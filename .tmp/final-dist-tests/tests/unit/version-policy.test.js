import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMOTE_CONFIG_SCHEMA_VERSION } from '../../src/types/config.js';
// Version policy is no longer a second configuration model. Wire compatibility
// is represented by the single schema version constant and ConfigValidator.
test('remote config schema version is explicit', () => {
    assert.equal(REMOTE_CONFIG_SCHEMA_VERSION, 1);
});
