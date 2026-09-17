import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScrubber } from '../../src/processors/security-scrubber.js';
import { DEFAULT_PRIVACY } from '../../src/constants/defaults.js';
describe('Adversarial PII & Payment Card Scrubbing (SEC-01 & SEC-02)', () => {
    let scrubber;
    beforeEach(() => {
        SecurityScrubber.reset();
        scrubber = SecurityScrubber.initialize(DEFAULT_PRIVACY);
    });
    it('scrubs 16-digit hyphenated Visa PAN in free-form error message', () => {
        const rawMessage = 'Payment failed for card 4532-0151-1283-0366: Insufficient funds';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Payment failed for card [Redacted]: Insufficient funds');
    });
    it('scrubs 16-digit space-separated Mastercard PAN in free-form error message', () => {
        // 5412 7512 3412 3452 is a Luhn-valid Mastercard number
        const rawMessage = 'Charge failed for card 5412 7512 3412 3452 decline code 05';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Charge failed for card [Redacted] decline code 05');
    });
    it('scrubs 16-digit contiguous PAN in error message', () => {
        const rawMessage = 'Declined transaction for 4532015112830366';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Declined transaction for [Redacted]');
    });
    it('scrubs 15-digit Amex card number with 4-6-5 formatting', () => {
        // 3782-822463-10005 is a standard Luhn-valid Amex test card
        const rawMessage = 'Error on card 3782-822463-10005: card expired';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Error on card [Redacted]: card expired');
    });
    it('does NOT scrub 16-digit numbers that fail the Luhn checksum (prevents false positives)', () => {
        // 1234-5678-9012-3456 fails Luhn check
        const rawMessage = 'Order shipment tracker 1234-5678-9012-3456 dispatched';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Order shipment tracker 1234-5678-9012-3456 dispatched');
    });
    it('scrubs US Social Security Numbers formatted with hyphens in error message', () => {
        const rawMessage = 'User validation failed for SSN 123-45-6789';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'User validation failed for SSN [Redacted]');
    });
    it('scrubs US Social Security Numbers formatted with spaces in error message', () => {
        const rawMessage = 'Identity verification failed: 123 45 6789';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Identity verification failed: [Redacted]');
    });
    it('scrubs Stripe live secret keys in free-form strings', () => {
        const rawMessage = 'Authentication failed using sk_live_51AbcDef12345678901234567890';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Authentication failed using [Redacted]');
    });
    it('scrubs AWS Access Key IDs in free-form strings', () => {
        const rawMessage = 'S3 upload failed for credential AKIAIOSFODNN7EXAMPLE';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'S3 upload failed for credential [Redacted]');
    });
    it('scrubs Basic Auth credentials in free-form strings', () => {
        const rawMessage = 'Failed to connect with Basic dXNlcjpwYXNzd29yZDEyMw==';
        const scrubbed = scrubber.scrubValue(rawMessage);
        assert.equal(scrubbed, 'Failed to connect with Basic [Redacted]');
    });
    it('scrubs sensitive query parameters with underscores (api_key) in URLs', () => {
        const rawUrl = 'https://api.stripe.com/v1/charges?api_key=sk_live_9948294104810&customer=cus_123';
        const event = {
            type: 'error',
            name: 'Error',
            message: 'Charge failed',
            stack: [],
            severity: 'error',
            timestamp: Date.now(),
            fingerprint: 'fp-1',
            mechanism: 'manual',
            handled: true,
            classification: { unhandled: false, fatal: false, crash: false },
            context: {},
            url: rawUrl,
        };
        const scrubbedEvent = scrubber.scrub(event);
        assert.ok(scrubbedEvent.url);
        assert.ok(!scrubbedEvent.url.includes('sk_live_9948294104810'));
        assert.ok(scrubbedEvent.url.includes('api_key=%5BRedacted%5D') || scrubbedEvent.url.includes('api_key=[Redacted]'));
    });
    it('scrubs sensitive card numbers and SSNs inside an entire ErrorEvent object', () => {
        const event = {
            type: 'error',
            name: 'Error',
            message: 'Payment failed for card 4532-0151-1283-0366 and SSN 123-45-6789',
            stack: [],
            severity: 'error',
            timestamp: Date.now(),
            fingerprint: 'fp-2',
            mechanism: 'manual',
            handled: true,
            classification: { unhandled: false, fatal: false, crash: false },
            context: {
                rawInput: 'card=4532 0151 1283 0366&ssn=123-45-6789',
                nested: {
                    userNote: 'Customer stated card 4532015112830366 was declined',
                },
            },
        };
        const scrubbed = scrubber.scrub(event);
        assert.equal(scrubbed.message, 'Payment failed for card [Redacted] and SSN [Redacted]');
        const ctx = scrubbed.context;
        const nested = ctx.nested;
        assert.ok(!String(ctx.rawInput).includes('4532'));
        assert.ok(!String(ctx.rawInput).includes('123-45-6789'));
        assert.ok(!String(nested.userNote).includes('4532015112830366'));
        assert.ok(String(nested.userNote).includes('[Redacted]'));
    });
});
