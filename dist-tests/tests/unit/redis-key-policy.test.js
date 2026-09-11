/**
 * Redis Key Visibility & Security Policy Test
 *
 * Verifies all 4 configurable Redis key visibility policies:
 * 1. 'command-only': only command name is visible
 * 2. 'sanitized-key': safe key names visible, sensitive keys ([REDACTED_KEY]) and write values ([REDACTED])
 * 3. 'hash': SHA-256 truncated hash of key
 * 4. 'full': full key name visible (except sensitive auth/tokens which remain [REDACTED_KEY])
 *
 * Invariant: AUTH, CONFIG SET/GET must NEVER expose passwords or configs regardless of policy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisStatementSerializer, isSensitiveRedisKey, } from '../../src/instrumentation/redis.js';
describe('Redis Key Visibility & Security Policy', () => {
    it('detects sensitive Redis keys', () => {
        assert.ok(isSensitiveRedisKey('user:session_token'));
        assert.ok(isSensitiveRedisKey('auth_key'));
        assert.ok(isSensitiveRedisKey('api_secret'));
        assert.ok(isSensitiveRedisKey('password_hash'));
        assert.ok(isSensitiveRedisKey('jwt:bearer'));
        assert.ok(isSensitiveRedisKey('user:credentials'));
        assert.ok(!isSensitiveRedisKey('users:42:profile'));
        assert.ok(!isSensitiveRedisKey('items:cache:list'));
        assert.ok(!isSensitiveRedisKey('leaderboard:score'));
    });
    it('policy: command-only strips all keys and arguments', () => {
        const serializer = createRedisStatementSerializer('command-only', true);
        assert.equal(serializer('GET', ['user:123']), 'GET');
        assert.equal(serializer('SET', ['user:123', 'John Doe']), 'SET');
        assert.equal(serializer('HGET', ['profile:42', 'email']), 'HGET');
        assert.equal(serializer('DEL', ['user:123']), 'DEL');
        assert.equal(serializer('AUTH', ['supersecretpass']), 'AUTH [REDACTED]');
    });
    it('policy: sanitized-key displays safe keys and redacts sensitive keys/values', () => {
        const serializer = createRedisStatementSerializer('sanitized-key', true);
        // Safe read command
        assert.equal(serializer('GET', ['users:42:profile']), 'GET users:42:profile');
        // Sensitive read command key redacted
        assert.equal(serializer('GET', ['user:session_token']), 'GET [REDACTED_KEY]');
        assert.equal(serializer('GET', ['auth_key']), 'GET [REDACTED_KEY]');
        // Safe write command: key visible, value redacted
        assert.equal(serializer('SET', ['users:42:profile', '{"name":"Alice"}']), 'SET users:42:profile [REDACTED]');
        // Sensitive write command: key and value redacted
        assert.equal(serializer('SET', ['session_secret', 'secretvalue']), 'SET [REDACTED_KEY] [REDACTED]');
        // AUTH is always redacted
        assert.equal(serializer('AUTH', ['mysecretpassword']), 'AUTH [REDACTED]');
        assert.equal(serializer('CONFIG', ['SET', 'requirepass', '123']), 'CONFIG SET [REDACTED]');
    });
    it('policy: hash truncates key with sha256 prefix', () => {
        const serializer = createRedisStatementSerializer('hash', true);
        const stmt = serializer('GET', ['users:42:profile']);
        assert.ok(stmt.startsWith('GET hash:'), `Expected statement to start with 'GET hash:', got: ${stmt}`);
        assert.equal(stmt.split(' ')[1]?.length, 17); // 'hash:' + 12 hex chars
        const writeStmt = serializer('SET', ['users:42:profile', 'val']);
        assert.ok(writeStmt.startsWith('SET hash:'), `Expected write statement to start with 'SET hash:', got: ${writeStmt}`);
        assert.ok(writeStmt.endsWith('[REDACTED]'), `Expected write statement to end with '[REDACTED]', got: ${writeStmt}`);
    });
    it('policy: full displays full key except sensitive credentials/tokens', () => {
        const serializer = createRedisStatementSerializer('full', true);
        // Safe key is full
        assert.equal(serializer('GET', ['org:tenant_1:users:42:profile']), 'GET org:tenant_1:users:42:profile');
        // Sensitive key is still protected!
        assert.equal(serializer('GET', ['org:tenant_1:auth_token']), 'GET [REDACTED_KEY]');
        // Write values are still protected!
        assert.equal(serializer('SET', ['items:cache', 'sensitive_data']), 'SET items:cache [REDACTED]');
        // AUTH is always protected
        assert.equal(serializer('AUTH', ['pass']), 'AUTH [REDACTED]');
    });
    it('captureBody: false forces command-only regardless of keyPolicy', () => {
        const serializer = createRedisStatementSerializer('full', false);
        assert.equal(serializer('GET', ['any:key']), 'GET');
        assert.equal(serializer('SET', ['any:key', 'val']), 'SET');
    });
});
