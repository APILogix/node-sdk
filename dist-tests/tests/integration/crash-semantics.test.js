import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { init } from '../../src/core/init.js';
import { shutdown } from '../../src/core/lifecycle.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
describe('Crash Semantics & Process Termination Lifecycle', () => {
    let mockServer;
    let mockPort;
    const receivedBatches = [];
    before(async () => {
        mockServer = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                let body = null;
                try {
                    const text = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
                    body = JSON.parse(text);
                }
                catch {
                    // Plain text or uncompressed fallback
                }
                receivedBatches.push({ path: req.url ?? '', body });
                if (req.url?.includes('init') || req.url?.includes('config')) {
                    const port = mockServer.address().port;
                    const localUrl = `http://127.0.0.1:${port}`;
                    const paths = {
                        errors: '/api/v1/errors', events: '/api/v1/events', traces: '/api/v1/traces',
                        spans: '/api/v1/spans', requests: '/api/v1/requests', metrics: '/api/v1/metrics',
                        logs: '/api/v1/logs', profiles: '/api/v1/profiles', crons: '/api/v1/checkins',
                        replays: '/api/v1/replays',
                    };
                    const routes = Object.fromEntries(Object.entries(TEST_REMOTE_CONFIG.transport.routes).map(([name, route]) => [
                        name,
                        { ...route, url: `${localUrl}${paths[name]}`, batchSize: 50, flushIntervalMs: 250, timeoutMs: 2_000 },
                    ]));
                    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
                    res.end(JSON.stringify({
                        success: true,
                        projectId: 'test-project',
                        environment: 'test',
                        release: '1.0.0',
                        config: {
                            ...TEST_REMOTE_CONFIG,
                            features: {
                                ...TEST_REMOTE_CONFIG.features,
                                errors: true,
                            },
                            sampling: {
                                ...TEST_REMOTE_CONFIG.sampling,
                                errors: 1,
                            },
                            transport: {
                                ...TEST_REMOTE_CONFIG.transport,
                                routes,
                            },
                        },
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
                res.end(JSON.stringify({ accepted: true }));
            });
        });
        await new Promise(resolve => {
            mockServer.listen(0, '127.0.0.1', () => {
                const addr = mockServer.address();
                if (addr && typeof addr === 'object') {
                    mockPort = addr.port;
                    process.env['PULSE_ENDPOINT'] = `http://127.0.0.1:${mockPort}`;
                }
                resolve();
            });
        });
    });
    after(async () => {
        delete process.env['PULSE_ENDPOINT'];
        await new Promise(resolve => mockServer.close(() => resolve()));
    });
    function runChildScript(scriptContent, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', scriptContent], {
                env: {
                    ...process.env,
                    PULSE_ENDPOINT: `http://127.0.0.1:${mockPort}`,
                    NODE_ENV: 'production',
                },
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', d => { stdout += d.toString(); });
            child.stderr?.on('data', d => { stderr += d.toString(); });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`Child process timed out after ${timeoutMs}ms (zombie process). stdout: ${stdout}, stderr: ${stderr}`));
            }, timeoutMs);
            child.on('close', code => {
                clearTimeout(timer);
                resolve({ code, stdout, stderr });
            });
            child.on('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
    it('terminates process with exitCode 1 on uncaughtException even with active HTTP server sockets', async () => {
        const script = `
      import http from 'node:http'
      import { init } from './dist/index.js'

      await init({
        apiKey: 'test-api-key',
        initTimeoutMs: 1000,
        crashTimeoutMs: 500,
        exitOnUncaughtException: true,
      })

      // Keep event loop alive indefinitely with open listening socket
      const server = http.createServer((req, res) => res.end('ok'))
      server.listen(0, '127.0.0.1', () => {
        // Trigger fatal uncaught exception
        setTimeout(() => {
          throw new Error('Fatal crash in HTTP worker')
        }, 50)
      })
    `;
        const start = Date.now();
        const result = await runChildScript(script, 6000);
        const duration = Date.now() - start;
        assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}. stderr: ${result.stderr}`);
        assert.ok(duration < 4000, `Process took too long to terminate (${duration}ms) — possible socket hang`);
    });
    it('respects exitOnUncaughtException: false opt-out allowing host to handle termination', async () => {
        const script = `
      import http from 'node:http'
      import { init } from './dist/index.js'

      await init({
        apiKey: 'test-api-key',
        initTimeoutMs: 1000,
        crashTimeoutMs: 300,
        exitOnUncaughtException: false,
      })

      const server = http.createServer((req, res) => res.end('ok'))
      server.listen(0, '127.0.0.1', () => {
        // Custom application crash handler
        process.on('uncaughtException', (err) => {
          console.log('HOST_HANDLED_CRASH:' + err.message)
          setTimeout(() => {
            server.close(() => process.exit(42))
          }, 100)
        })

        setTimeout(() => {
          throw new Error('Application handled error')
        }, 50)
      })
    `;
        const result = await runChildScript(script, 6000);
        assert.strictEqual(result.code, 42, `Expected host exit code 42, got ${result.code}. stderr: ${result.stderr}`);
        assert.ok(result.stdout.includes('HOST_HANDLED_CRASH:Application handled error'));
    });
    it('invokes onFatalError callback prior to terminating process', async () => {
        const script = `
      import { init } from './dist/index.js'

      await init({
        apiKey: 'test-api-key',
        initTimeoutMs: 1000,
        crashTimeoutMs: 300,
        exitOnUncaughtException: true,
        onFatalError: (err) => {
          console.log('ON_FATAL_ERROR_INVOKED:' + err.message)
        }
      })

      setTimeout(() => {
        throw new Error('Fatal hook verification')
      }, 50)
    `;
        const result = await runChildScript(script, 6000);
        assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}`);
        assert.ok(result.stdout.includes('ON_FATAL_ERROR_INVOKED:Fatal hook verification'), `Expected hook output in stdout: ${result.stdout}`);
    });
    it('handles crash storm / multiple re-entrant uncaught exceptions without deadlock', async () => {
        const script = `
      import { init } from './dist/index.js'

      await init({
        apiKey: 'test-api-key',
        initTimeoutMs: 1000,
        crashTimeoutMs: 500,
        exitOnUncaughtException: true,
      })

      setTimeout(() => {
        setTimeout(() => { throw new Error('Secondary crash storm exception') }, 10)
        throw new Error('Primary crash exception')
      }, 50)
    `;
        const start = Date.now();
        const result = await runChildScript(script, 6000);
        const duration = Date.now() - start;
        assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}`);
        assert.ok(duration < 4000, `Crash storm took too long (${duration}ms)`);
    });
    it('preserves clean listener registration and leaves no leaks across repeated init/shutdown cycles', async () => {
        const baselineUncaught = process.listenerCount('uncaughtException');
        const baselineUnhandled = process.listenerCount('unhandledRejection');
        for (let i = 0; i < 5; i++) {
            await init({
                apiKey: 'test-api-key',
                initTimeoutMs: 2000,
                exitOnUncaughtException: false,
            });
            // Inside initialized state, listener count must be exactly baseline + 1
            assert.strictEqual(process.listenerCount('uncaughtException'), baselineUncaught + 1);
            assert.strictEqual(process.listenerCount('unhandledRejection'), baselineUnhandled + 1);
            await shutdown(1000);
            // After shutdown, listener count must return to exact baseline
            assert.strictEqual(process.listenerCount('uncaughtException'), baselineUncaught, `Leaked uncaughtException at cycle ${i}`);
            assert.strictEqual(process.listenerCount('unhandledRejection'), baselineUnhandled, `Leaked unhandledRejection at cycle ${i}`);
        }
    });
    it('successfully delivers fatal crash error telemetry before process terminates', async () => {
        receivedBatches.length = 0;
        const script = `
      import { init } from './dist/index.js'

      await init({
        apiKey: 'test-api-key',
        initTimeoutMs: 1000,
        crashTimeoutMs: 1500,
        exitOnUncaughtException: true,
      })

      setTimeout(() => {
        throw new Error('Fatal production crash telemetry test')
      }, 50)
    `;
        const result = await runChildScript(script, 6000);
        assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}`);
        // Verify received batches in mock server
        const errorBatch = receivedBatches.find(b => b.path.includes('errors'));
        assert.ok(errorBatch, 'Expected error batch to be delivered before process termination');
    });
});
