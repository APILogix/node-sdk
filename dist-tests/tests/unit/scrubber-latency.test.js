import { it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MAX_SCRUB_STRING_LENGTH, sanitizeEvent } from '../../src/processors/sanitizer.js';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { TEST_REMOTE_CONFIG } from '../fixtures/remote-config.js';
it('scrubs long non-email messages without quadratic scanning and still redacts email', () => {
    const scrubber = SecurityScrubber.initialize({
        ...TEST_REMOTE_CONFIG.privacy,
        piiDetection: { enabled: true, maskEmails: true, maskPhones: false, maskIPs: false },
    });
    try {
        for (const message of ['A'.repeat(60 * 1024), 'a.b-_%+'.repeat(10_000)]) {
            const event = { type: 'error', message: `${message} contact user.name+tag@example.com` };
            const started = performance.now();
            const sanitized = sanitizeEvent(event);
            const secured = scrubber.scrub(event);
            const elapsed = performance.now() - started;
            assert.ok(elapsed < 1000, `scrubbing blocked for ${elapsed.toFixed(1)}ms`);
            const expected = `${message.slice(0, MAX_SCRUB_STRING_LENGTH)}…[truncated]`;
            assert.equal(sanitized.message, expected);
            assert.equal(secured.message, expected);
        }
        const shortEvent = { type: 'error', message: 'contact user.name+tag@example.com' };
        assert.equal(sanitizeEvent(shortEvent).message, 'contact [email]');
        assert.equal(scrubber.scrub(shortEvent).message, 'contact [email]');
    }
    finally {
        SecurityScrubber.reset();
    }
});
it('bounds attacker-shaped phone and JWT text in both scrubbers', () => {
    const scrubber = SecurityScrubber.initialize({
        ...TEST_REMOTE_CONFIG.privacy,
        piiDetection: { enabled: true, maskEmails: true, maskPhones: true, maskIPs: true },
        scrubbing: { ...TEST_REMOTE_CONFIG.privacy.scrubbing, enabled: true },
    });
    const inputs = [
        `Invalid token ${'eyJ'.repeat(43_000)}`,
        `Invalid token ${'eyJheader.'.repeat(3_000)}..`,
        `Bad input${' '.repeat(120_000)}1`,
        `prefix ${'x'.repeat(32 * 1024)} token=CANARY_SUFFIX_MUST_NOT_LEAK`,
    ];
    try {
        for (const message of inputs) {
            const event = { type: 'error', message };
            const started = performance.now();
            const secure = scrubber.scrubValue(message);
            const fallback = sanitizeEvent(event);
            const elapsed = performance.now() - started;
            assert.ok(elapsed < 500, `scrubbing blocked for ${elapsed.toFixed(1)}ms at input length ${message.length}`);
            assert.ok(secure.length <= MAX_SCRUB_STRING_LENGTH + 20);
            assert.ok(fallback.message.length <= MAX_SCRUB_STRING_LENGTH + 20);
            assert.equal(secure.includes('CANARY_SUFFIX_MUST_NOT_LEAK'), false);
            assert.equal(fallback.message.includes('CANARY_SUFFIX_MUST_NOT_LEAK'), false);
        }
    }
    finally {
        SecurityScrubber.reset();
    }
});
