import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyError } from '../../src/core/error-classifier.js';
import { Severity } from '../../src/types/severity.js';
describe('Error Classifier Unit Tests', () => {
    it('classifies manual error (handled: true, mechanism: manual, severity: error)', () => {
        const classification = classifyError(true, 'manual', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies express.next error (handled: true, mechanism: express.next, severity: error)', () => {
        const classification = classifyError(true, 'express.next', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies express.res.error (handled: true, mechanism: express.res.error, severity: error)', () => {
        const classification = classifyError(true, 'express.res.error', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies fastify.onError (handled: true, mechanism: fastify.onError, severity: error)', () => {
        const classification = classifyError(true, 'fastify.onError', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies manual fatal error (handled: true, mechanism: manual, severity: fatal)', () => {
        const classification = classifyError(true, 'manual', 'fatal');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: true,
            crash: false,
        });
    });
    it('classifies manual fatal error using Severity.Fatal enum', () => {
        const classification = classifyError(true, 'manual', Severity.Fatal);
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: true,
            crash: false,
        });
    });
    it('classifies uncaughtException (handled: false, mechanism: uncaughtException, severity: fatal)', () => {
        const classification = classifyError(false, 'uncaughtException', 'fatal');
        assert.deepStrictEqual(classification, {
            unhandled: true,
            fatal: true,
            crash: true,
        });
    });
    it('classifies unhandledRejection (handled: false, mechanism: unhandledRejection, severity: error)', () => {
        const classification = classifyError(false, 'unhandledRejection', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: true,
            fatal: false,
            crash: false,
        });
    });
    it('classifies console.error (handled: true, mechanism: console.error, severity: error)', () => {
        const classification = classifyError(true, 'console.error', 'error');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies unknown mechanism safely without throwing', () => {
        const classification = classifyError(true, 'unknown-framework-hook', 'warning');
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classifies undefined/null values safely', () => {
        const classification = classifyError(true, undefined, undefined);
        assert.deepStrictEqual(classification, {
            unhandled: false,
            fatal: false,
            crash: false,
        });
    });
    it('classification remains deterministic across repeated invocations', () => {
        for (let i = 0; i < 50; i++) {
            const res1 = classifyError(false, 'uncaughtException', 'fatal');
            assert.deepStrictEqual(res1, { unhandled: true, fatal: true, crash: true });
            const res2 = classifyError(true, 'express.next', 'error');
            assert.deepStrictEqual(res2, { unhandled: false, fatal: false, crash: false });
            const res3 = classifyError(true, 'manual', 'fatal');
            assert.deepStrictEqual(res3, { unhandled: false, fatal: true, crash: false });
        }
    });
    it('does NOT infer fatal or crash from arbitrary heuristics', () => {
        // If severity is 'error', fatal is false even if message or name suggests crash
        const classification = classifyError(true, 'manual', 'error');
        assert.strictEqual(classification.fatal, false);
        assert.strictEqual(classification.crash, false);
        assert.strictEqual(classification.unhandled, false);
    });
});
