import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { SerializationPool } from '../../src/transport/serialization-pool.js';
import { BatchManager } from '../../src/transport/batch-manager.js';
import { TransportEventQueue } from '../../src/transport/transport-event-queue.js';
import { HealthMonitor } from '../../src/transport/health-monitor.js';
import { ConnectionManager } from '../../src/transport/connection-manager.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersistentStorage } from '../../src/storage/persistent-storage.js';
const basePrivacyConfig = {
    capture: { headers: true, body: true, response: false, query: true, cookies: false },
    scrubbing: {
        enabled: true,
        headers: ['authorization'],
        fields: ['password', 'secret', 'token'],
    },
    piiDetection: {
        enabled: false,
        maskEmails: false,
        maskPhones: false,
        maskIPs: false,
    },
};
describe('Enterprise Hardening & Gap Verification', () => {
    describe('SecurityScrubber Top-Level Prototype Pollution Defense', () => {
        beforeEach(() => {
            SecurityScrubber.reset();
        });
        afterEach(() => {
            SecurityScrubber.reset();
            delete Object.prototype.polluted;
            delete Object.prototype.admin;
            delete Object.prototype.hacked;
        });
        it('strips top-level __proto__, constructor, and prototype from cloned events', () => {
            const scrubber = SecurityScrubber.initialize(basePrivacyConfig);
            // Construct a malicious payload with top-level dangerous keys
            const maliciousPayload = JSON.parse('{"type":"error","eventId":"p-1","__proto__":{"polluted":"yes"},"constructor":{"admin":true},"prototype":{"hacked":true},"extra":{"nested__proto__":123}}');
            const scrubbed = scrubber.scrub(maliciousPayload);
            // Object.prototype must NOT be polluted
            assert.strictEqual(Object.prototype.polluted, undefined);
            assert.strictEqual(Object.prototype.admin, undefined);
            assert.strictEqual(Object.prototype.hacked, undefined);
            // Top-level dangerous keys must not exist on the scrubbed object
            const ownKeys = Object.getOwnPropertyNames(scrubbed);
            assert.ok(!ownKeys.includes('__proto__') || scrubbed.__proto__ === Object.prototype);
            assert.ok(!ownKeys.includes('constructor') || typeof scrubbed.constructor === 'function');
            assert.ok(!ownKeys.includes('prototype'));
        });
        it('scrubs deep nested objects and removes dangerous keys without prototype mutation', () => {
            const scrubber = SecurityScrubber.initialize(basePrivacyConfig);
            const event = {
                type: 'error',
                eventId: 'test-event-1',
                timestamp: Date.now(),
                message: 'test error',
                severity: 'error',
                extra: {
                    __proto__: { polluted: 'deep' },
                    secret: 'topsecret123',
                    normal: 'safeValue',
                },
            };
            const scrubbed = scrubber.scrub(event);
            assert.strictEqual(Object.prototype.polluted, undefined);
            assert.strictEqual(scrubbed.extra.secret, '[Redacted]');
            assert.strictEqual(scrubbed.extra.normal, 'safeValue');
        });
    });
    describe('PersistentStorage POSIX Mode Enforcement', () => {
        let testDir;
        let storage;
        beforeEach(async () => {
            testDir = join(tmpdir(), `pulse-posix-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            storage = new PersistentStorage();
            storage.configure({
                directory: testDir,
                maxEvents: 100,
                eventTtlMs: 60000,
            });
            await storage.init();
        });
        afterEach(async () => {
            await storage.shutdown();
            try {
                await fs.rm(testDir, { recursive: true, force: true });
            }
            catch { }
        });
        it('creates directory and persistent data files with restricted permissions', async () => {
            const event = {
                type: 'error',
                eventId: 'posix-evt-1',
                timestamp: Date.now(),
            };
            await storage.persist(event);
            await storage.flush();
            // Directory must exist
            const dirStat = await fs.stat(testDir);
            assert.ok(dirStat.isDirectory());
            // In POSIX environments, check permissions; on Windows, check that mode is non-zero
            if (process.platform !== 'win32') {
                const dirMode = dirStat.mode & 0o777;
                assert.strictEqual(dirMode, 0o700, `Expected directory mode 0o700, got 0o${dirMode.toString(8)}`);
                const dataFile = join(testDir, 'events.ndjson');
                const fileStat = await fs.stat(dataFile);
                const fileMode = fileStat.mode & 0o777;
                assert.strictEqual(fileMode, 0o600, `Expected file mode 0o600, got 0o${fileMode.toString(8)}`);
            }
        });
    });
    describe('SerializationPool Worker Integration & Large Batch Offload', () => {
        const routes = ['errors', 'events', 'traces', 'spans', 'metrics', 'logs', 'profiles', 'crons', 'requests', 'replays'];
        const limits = Object.fromEntries(routes.map(route => [route, 2]));
        before(async () => {
            await SerializationPool.reset();
            SerializationPool.initialize(2);
        });
        after(async () => {
            await SerializationPool.reset();
        });
        it('initializes worker threads and serializes payloads to gzip format', async () => {
            const pool = SerializationPool.getInstance();
            assert.ok(pool, 'SerializationPool singleton should exist');
            const sampleBatch = [
                { type: 'error', id: 'evt-1', data: 'hello world'.repeat(100) },
                { type: 'span', id: 'span-1', traceId: 't-1'.repeat(50) },
            ];
            const result = await pool.serialize(sampleBatch, 'gzip');
            assert.strictEqual(result.algorithm, 'gzip');
            assert.ok(Buffer.isBuffer(result.buffer));
            assert.ok(result.compressedSize > 0);
            assert.ok(result.compressedSize < result.originalSize);
        });
        it('BatchManager successfully offloads batches exceeding 50KB to SerializationPool', async () => {
            const pool = SerializationPool.getInstance();
            assert.ok(pool);
            let capturedHeaders = {};
            let capturedBody = null;
            const mockFetch = async (_url, init) => {
                capturedHeaders = (init?.headers ?? {});
                capturedBody = init?.body ? new Uint8Array(init.body) : null;
                return new Response(JSON.stringify({ accepted: 100 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            };
            const queue = new TransportEventQueue({
                route: 'errors',
                maxSize: 20,
                criticalReserve: 2,
                priority: 'high',
                overflowStrategy: 'drop_oldest',
            });
            const healthMonitor = new HealthMonitor(routes);
            const connectionManager = new ConnectionManager({
                maxTotalConnections: 2,
                maxConnectionsPerRoute: limits,
                connectionTimeoutMs: 50,
                socketTimeoutMs: 1_000,
                connectionTTLMs: 1_000,
                idleConnectionTimeoutMs: 1_000,
            });
            const batchManager = new BatchManager({
                route: 'errors',
                definition: {
                    route: 'errors',
                    method: 'POST',
                    contentType: 'application/json',
                    url: 'https://example.test/api/v1/errors',
                },
                apiKey: 'test-api-key',
                fetchImpl: mockFetch,
                healthMonitor,
                connectionManager,
                queue,
                minBatchSize: 1,
                maxBatchSize: 100,
                maxWaitTimeMs: 50,
                maxPayloadBytes: 2 * 1024 * 1024,
                compression: 'gzip',
                keepAlive: false,
                socketTimeoutMs: 2000,
                retry: {
                    enabled: true,
                    maxRetries: 1,
                    backoff: 'fixed',
                    baseDelayMs: 1,
                },
            });
            // Generate large event (>55KB) to trigger the worker serialization threshold
            const largePayload = 'A'.repeat(60 * 1024);
            const largeEvent = {
                type: 'error',
                eventId: 'large-evt-1',
                timestamp: Date.now(),
                message: largePayload,
                severity: 'error',
            };
            batchManager.enqueue(largeEvent);
            await batchManager.flush();
            assert.strictEqual(capturedHeaders['Content-Encoding'], 'gzip');
            const bodyBytes = capturedBody;
            assert.ok(bodyBytes && bodyBytes.byteLength > 0);
            // Gzip magic numbers: 0x1f, 0x8b
            assert.strictEqual(bodyBytes[0], 0x1f);
            assert.strictEqual(bodyBytes[1], 0x8b);
            await batchManager.shutdown();
        });
    });
});
