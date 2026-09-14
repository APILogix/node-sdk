import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { DEFAULT_PRIVACY } from '../../src/constants/defaults.js';
describe('Sensitive-Data Protection & Redaction Hardening', () => {
    let scrubber;
    const customPrivacyConfig = {
        capture: { headers: true, body: true, response: true, query: true, cookies: true },
        scrubbing: {
            enabled: true,
            headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'],
            fields: ['password', 'token', 'secret', 'creditCard', 'ssn', 'apiKey', 'access_token', 'refresh_token'],
        },
        piiDetection: {
            enabled: true,
            maskEmails: true,
            maskPhones: true,
            maskIPs: true,
        },
    };
    beforeEach(() => {
        scrubber = SecurityScrubber.initialize(customPrivacyConfig);
    });
    afterEach(() => {
        SecurityScrubber.reset();
    });
    it('redacts credentials embedded in URLs', () => {
        const event = {
            type: 'request',
            url: 'https://admin:superSecretPassword@api.example.com/v1/users?token=queryToken123',
        };
        const scrubbed = scrubber.scrub(event);
        assert.ok(!scrubbed.url.includes('superSecretPassword'), `URL leaked credentials: ${scrubbed.url}`);
        assert.ok(!scrubbed.url.includes('queryToken123'), `URL leaked query token: ${scrubbed.url}`);
        assert.ok(scrubbed.url.includes('[Redacted]'));
    });
    it('redacts sensitive fields inside JSON string attributes (db.statement)', () => {
        const rawFilter = JSON.stringify({
            email: 'user@example.com',
            password: 'plainPassword123',
            apiKey: 'sk_live_abcdef123456',
            active: true,
        });
        const event = {
            type: 'span',
            attributes: {
                'db.system': 'mongodb',
                'db.statement': rawFilter,
            },
        };
        const scrubbed = scrubber.scrub(event);
        const scrubbedStatement = scrubbed.attributes['db.statement'];
        assert.ok(!scrubbedStatement.includes('plainPassword123'), `db.statement leaked password: ${scrubbedStatement}`);
        assert.ok(!scrubbedStatement.includes('sk_live_abcdef123456'), `db.statement leaked apiKey: ${scrubbedStatement}`);
        assert.ok(!scrubbedStatement.includes('user@example.com'), `db.statement leaked email: ${scrubbedStatement}`);
        const parsed = JSON.parse(scrubbedStatement);
        assert.equal(parsed.password, '[Redacted]');
        assert.equal(parsed.apiKey, '[Redacted]');
        assert.equal(parsed.email, '[email]');
        assert.equal(parsed.active, true);
    });
    it('masks generic key=value credentials in free-form strings and error messages', () => {
        const event = {
            type: 'error',
            message: 'Failed to connect: password=MySecretPass123! and token=xyz98765 for admin',
        };
        const scrubbed = scrubber.scrub(event);
        assert.ok(!scrubbed.message.includes('MySecretPass123!'), `Message leaked password: ${scrubbed.message}`);
        assert.ok(!scrubbed.message.includes('xyz98765'), `Message leaked token: ${scrubbed.message}`);
        assert.ok(scrubbed.message.includes('password=[Redacted]'));
        assert.ok(scrubbed.message.includes('token=[Redacted]'));
    });
    it('preserves DEFAULT_PRIVACY safety and includes set-cookie in default headers', () => {
        assert.ok(DEFAULT_PRIVACY.scrubbing.headers.includes('set-cookie'), 'DEFAULT_PRIVACY should include set-cookie');
    });
});
