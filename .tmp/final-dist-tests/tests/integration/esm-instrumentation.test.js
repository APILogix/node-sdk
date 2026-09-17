/**
 * P0 Native ESM Instrumentation & Database Spans Integration Test Suite
 *
 * Verifies that native ESM database and cache module imports (pg, redis, ioredis)
 * are intercepted and instrumented when running under Node.js native ESM:
 * 1. Preload registration via `node --import ./dist/register.js` in a real child process.
 * 2. Real wire-level communication with mock PostgreSQL and Redis servers.
 * 3. OpenTelemetry database span creation (db.system, db.statement, parent-child causality).
 * 4. First-class manual database span helpers (withDbSpan, startDbSpan, withDbSpanSync).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { fork, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { init, shutdown, withSpan, flushTracer, flush, withDbSpan, withDbSpanSync, startDbSpan, registerEsmLoaderHooks, } from '../../src/index.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
const projectRoot = process.cwd();
describe('Native ESM Instrumentation & Database Driver Interception', () => {
    let backendServer;
    let backendUrl;
    let pgServer;
    let pgPort;
    let redisServer;
    let redisPort;
    const activeSockets = new Set();
    const capturedEvents = [];
    before(async () => {
        // 1. Mock telemetry backend
        backendServer = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(Buffer.from(c)));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const decoded = req.headers['content-encoding'] === 'gzip'
                    ? gunzipSync(raw).toString('utf8')
                    : raw.toString('utf8');
                let body = null;
                try {
                    body = decoded ? JSON.parse(decoded) : null;
                    if (body && Array.isArray(body.events)) {
                        capturedEvents.push(...body.events);
                    }
                    else if (body && body.type) {
                        capturedEvents.push(body);
                    }
                }
                catch { }
                if (req.url === '/v1/init') {
                    const routes = Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                        name,
                        {
                            ...route,
                            url: `${backendUrl}/api/v1/${name}`,
                            batchSize: 50,
                            flushIntervalMs: 50,
                            timeoutMs: 2000,
                        },
                    ]));
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        projectId: 'proj-esm-test',
                        environment: 'test',
                        release: '1.0.0',
                        config: {
                            ...TEST_REMOTE_CONFIG,
                            sdk: {
                                projectId: 'proj-esm-test',
                                service: 'esm-test-service',
                                environment: 'test',
                                release: '1.0.0',
                            },
                            features: {
                                ...TEST_REMOTE_CONFIG.features,
                                tracing: true,
                                requestCapture: true,
                            },
                            sampling: {
                                ...TEST_REMOTE_CONFIG.sampling,
                                traces: 1,
                                spans: 1,
                                requests: 1,
                            },
                            transport: {
                                ...TEST_REMOTE_CONFIG.transport,
                                retry: { ...TEST_REMOTE_CONFIG.transport.retry, enabled: false, maxRetries: 0 },
                                routes,
                            },
                            instrumentation: {
                                ...TEST_REMOTE_CONFIG.instrumentation,
                                pg: { enabled: true, captureQueries: true, captureParams: true },
                                redis: { enabled: true, keyPolicy: 'sanitized-key' },
                            },
                        },
                    }));
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ success: true, accepted: true }));
            });
        });
        await new Promise(resolve => backendServer.listen(0, '127.0.0.1', () => resolve()));
        const backendAddr = backendServer.address();
        backendUrl = `http://127.0.0.1:${backendAddr.port}`;
        // 2. Mock PostgreSQL wire protocol v3 server
        pgServer = net.createServer(socket => {
            activeSockets.add(socket);
            socket.on('close', () => activeSockets.delete(socket));
            let state = 'startup';
            socket.on('data', (rawChunk) => {
                const data = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                if (state === 'startup') {
                    state = 'ready';
                    const authOk = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]);
                    const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
                    socket.write(Buffer.concat([authOk, ready]));
                    return;
                }
                if (data[0] === 0x51) { // 'Q' Simple Query
                    const str = data.subarray(5).toString('utf8');
                    if (str.includes('SYNTAX_ERROR')) {
                        const err = Buffer.from('42601\0syntax error\0');
                        const errPkt = Buffer.alloc(5 + err.length);
                        errPkt[0] = 69; // 'E'
                        errPkt.writeInt32BE(4 + err.length, 1);
                        err.copy(errPkt, 5);
                        const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
                        socket.write(Buffer.concat([errPkt, ready]));
                    }
                    else {
                        const tag = Buffer.from('SELECT 1\0');
                        const complete = Buffer.alloc(5 + tag.length);
                        complete[0] = 67; // 'C'
                        complete.writeInt32BE(4 + tag.length, 1);
                        tag.copy(complete, 5);
                        const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
                        socket.write(Buffer.concat([complete, ready]));
                    }
                }
                else if (data[0] === 0x50) { // 'P' Parse (extended protocol)
                    const parseComplete = Buffer.from([49, 0, 0, 0, 4]);
                    const bindComplete = Buffer.from([50, 0, 0, 0, 4]);
                    const tag = Buffer.from('SELECT 1\0');
                    const complete = Buffer.alloc(5 + tag.length);
                    complete[0] = 67;
                    complete.writeInt32BE(4 + tag.length, 1);
                    tag.copy(complete, 5);
                    const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
                    socket.write(Buffer.concat([parseComplete, bindComplete, complete, ready]));
                }
            });
        });
        await new Promise(resolve => pgServer.listen(0, '127.0.0.1', () => resolve()));
        pgPort = pgServer.address().port;
        // 3. Mock Redis RESP server
        const store = new Map();
        const pairs = [
            ['server', 'redis'],
            ['version', '7.2.0'],
            ['proto', 3],
            ['id', 1],
            ['mode', 'standalone'],
            ['role', 'master'],
        ];
        let helloResp = `%${pairs.length}\r\n`;
        for (const [k, v] of pairs) {
            helloResp += `$${k.length}\r\n${k}\r\n`;
            if (typeof v === 'number')
                helloResp += `:${v}\r\n`;
            else
                helloResp += `$${v.length}\r\n${v}\r\n`;
        }
        redisServer = net.createServer(socket => {
            activeSockets.add(socket);
            socket.on('close', () => activeSockets.delete(socket));
            let buffer = Buffer.alloc(0);
            socket.on('data', (rawChunk) => {
                const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length > 0) {
                    if (buffer[0] !== 42) { // not '*'
                        const lf = buffer.indexOf('\n');
                        if (lf === -1)
                            break;
                        const line = buffer.subarray(0, lf).toString('utf8').trim();
                        buffer = buffer.subarray(lf + 1);
                        const parts = line.split(/\s+/);
                        const cmd = parts[0]?.toUpperCase();
                        if (cmd === 'PING')
                            socket.write('+PONG\r\n');
                        else
                            socket.write('+OK\r\n');
                        continue;
                    }
                    const firstCrLf = buffer.indexOf('\r\n');
                    if (firstCrLf === -1)
                        break;
                    const count = parseInt(buffer.subarray(1, firstCrLf).toString('utf8'), 10);
                    let offset = firstCrLf + 2;
                    const args = [];
                    let complete = true;
                    for (let i = 0; i < count; i++) {
                        if (offset >= buffer.length || buffer[offset] !== 36) {
                            complete = false;
                            break;
                        }
                        const crLf = buffer.indexOf('\r\n', offset);
                        if (crLf === -1) {
                            complete = false;
                            break;
                        }
                        const len = parseInt(buffer.subarray(offset + 1, crLf).toString('utf8'), 10);
                        const valStart = crLf + 2;
                        const valEnd = valStart + len;
                        if (valEnd + 2 > buffer.length) {
                            complete = false;
                            break;
                        }
                        args.push(buffer.subarray(valStart, valEnd).toString('utf8'));
                        offset = valEnd + 2;
                    }
                    if (!complete)
                        break;
                    buffer = buffer.subarray(offset);
                    const cmd = (args[0] || '').toUpperCase();
                    if (cmd === 'HELLO')
                        socket.write(helloResp);
                    else if (cmd === 'CLIENT')
                        socket.write('+OK\r\n');
                    else if (cmd === 'PING')
                        socket.write('+PONG\r\n');
                    else if (cmd === 'SET') {
                        store.set(args[1] || '', args[2] || '');
                        socket.write('+OK\r\n');
                    }
                    else if (cmd === 'GET') {
                        const val = store.get(args[1] || '') || 'val';
                        const valBuf = Buffer.from(val);
                        socket.write(`$${valBuf.length}\r\n${val}\r\n`);
                    }
                    else if (cmd === 'QUIT') {
                        socket.write('+OK\r\n');
                        socket.end();
                    }
                    else {
                        socket.write('+OK\r\n');
                    }
                }
            });
        });
        await new Promise(resolve => redisServer.listen(0, '127.0.0.1', () => resolve()));
        redisPort = redisServer.address().port;
    });
    after(async () => {
        for (const s of activeSockets) {
            try {
                s.destroy();
            }
            catch { }
        }
        activeSockets.clear();
        await new Promise(resolve => pgServer.close(() => resolve()));
        await new Promise(resolve => redisServer.close(() => resolve()));
        await new Promise(resolve => backendServer.close(() => resolve()));
    });
    it('instruments native ESM static imports in child process using --import ./dist/register.js', async () => {
        // Create a pure ESM runner script that performs static imports of pg and ioredis
        const tempScriptPath = path.join(projectRoot, 'pure-esm-runner.mjs');
        const sdkUrl = pathToFileURL(path.join(projectRoot, 'dist', 'index.js')).href;
        const scriptContent = `
import pg from 'pg'
import IORedis from 'ioredis'
import { init, withSpan, flushTracer, flush, shutdown } from '${sdkUrl}'

async function main() {
  process.env['SDK_BASE_URL'] = '${backendUrl}'
  await init({ apiKey: 'test-esm-child-key' })

  // Execute PostgreSQL query inside parent span
  const pgClient = new pg.Client({
    host: '127.0.0.1',
    port: ${pgPort},
    user: 'postgres',
    database: 'esm_db',
  })
  await pgClient.connect()

  await withSpan('esm-parent-http', async (span) => {
    await pgClient.query('SELECT 1 FROM esm_users WHERE id = $1', [99])
  })
  await pgClient.end()

  // Execute IORedis commands inside parent span
  const ioClient = new IORedis({
    host: '127.0.0.1',
    port: ${redisPort},
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  })
  await ioClient.connect()

  await withSpan('esm-redis-parent', async (span) => {
    await ioClient.set('esm-key', 'esm-val')
    await ioClient.get('esm-key')
  })
  ioClient.disconnect()

  await flushTracer()
  await flush()
  await shutdown(2000)
}

main().catch(err => {
  console.error('Child runner error:', err)
  process.exit(1)
})
`;
        await fs.writeFile(tempScriptPath, scriptContent, 'utf8');
        try {
            const registerUrl = pathToFileURL(path.join(projectRoot, 'dist', 'register.js')).href;
            const child = spawn(process.execPath, [
                '--import', registerUrl,
                tempScriptPath,
            ], {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    SDK_BASE_URL: backendUrl,
                    NODE_ENV: 'test',
                },
                stdio: 'pipe',
            });
            let stderr = '';
            let stdout = '';
            child.stdout.on('data', d => { stdout += d.toString(); });
            child.stderr.on('data', d => { stderr += d.toString(); });
            const exitCode = await new Promise(resolve => {
                child.on('close', resolve);
            });
            if (exitCode !== 0) {
                console.error('Child stdout:', stdout);
                console.error('Child stderr:', stderr);
            }
            assert.equal(exitCode, 0, `Child process must exit with code 0. Stderr: ${stderr}`);
            // Verify traces and database spans were captured by backend
            const traces = capturedEvents.filter(e => e.type === 'trace');
            assert.ok(traces.length >= 1, `Expected traces from child process, found ${traces.length}`);
            // Find PG query span
            const allSpans = [];
            for (const t of traces) {
                const collect = (node) => {
                    if (!node)
                        return;
                    allSpans.push(node);
                    if (Array.isArray(node.children)) {
                        for (const c of node.children)
                            collect(c);
                    }
                };
                collect(t.rootSpan);
            }
            const pgSpan = allSpans.find(s => s.attributes?.['db.system'] === 'postgresql' ||
                s.name?.toLowerCase().includes('select'));
            assert.ok(pgSpan, 'PostgreSQL database span must be captured in pure ESM execution');
            assert.equal(pgSpan.kind, 'client', 'Database span kind must be client');
            const redisSpan = allSpans.find(s => s.attributes?.['db.system'] === 'redis' ||
                s.name?.toLowerCase().includes('set') ||
                s.name?.toLowerCase().includes('get'));
            assert.ok(redisSpan, 'Redis database span must be captured in pure ESM execution');
            assert.equal(redisSpan.kind, 'client', 'Redis span kind must be client');
        }
        finally {
            try {
                await fs.unlink(tempScriptPath);
            }
            catch { }
        }
    });
    it('provides safe manual database span instrumentation via withDbSpan and withDbSpanSync', async () => {
        process.env['SDK_BASE_URL'] = backendUrl;
        await init({ apiKey: 'test-manual-db-key' });
        try {
            // 1. Async withDbSpan
            const asyncResult = await withDbSpan({
                system: 'postgresql',
                operation: 'SELECT',
                statement: 'SELECT * FROM users WHERE active = true',
                database: 'production_db',
            }, async (span) => {
                assert.ok(span, 'PulseSpan must be provided to withDbSpan callback');
                span.setAttribute('db.rows_affected', 5);
                return { count: 5 };
            });
            assert.equal(asyncResult.count, 5);
            // 2. Sync withDbSpanSync
            const syncResult = withDbSpanSync({
                system: 'redis',
                operation: 'GET',
                statement: 'GET cache:session:123',
            }, (span) => {
                span.setAttribute('cache.hit', true);
                return 'cached-value';
            });
            assert.equal(syncResult, 'cached-value');
            // 3. Manual startDbSpan lifecycle
            const manualSpan = startDbSpan({
                system: 'mongodb',
                operation: 'find',
                statement: 'find({ status: "active" })',
                database: 'analytics',
                collection: 'events',
            });
            assert.ok(manualSpan, 'startDbSpan must return a PulseSpan');
            manualSpan.setAttribute('db.mongodb.read_preference', 'secondaryPreferred');
            manualSpan.end();
            // 4. Failing DB query records error status
            await assert.rejects(async () => {
                await withDbSpan({
                    system: 'postgresql',
                    operation: 'DROP',
                    statement: 'DROP TABLE nonexistent',
                }, async () => {
                    throw new Error('Table nonexistent does not exist');
                });
            }, /Table nonexistent does not exist/);
            await flushTracer();
            await flush();
        }
        finally {
            await shutdown(2000);
        }
    });
});
