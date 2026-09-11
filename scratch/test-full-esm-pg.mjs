import * as nodeModule from 'node:module';
import { register as registerSyncHooks, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';
import { createPgInstrumentation } from '../dist/instrumentation/pg.js';
import { createIORedisInstrumentation } from '../dist/instrumentation/redis.js';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

if (supportsSyncHooks()) {
  registerSyncHooks();
} else if (typeof nodeModule.register === 'function') {
  nodeModule.register('import-in-the-middle/hook.mjs', import.meta.url);
}

const pgInst = createPgInstrumentation(true, { captureQueries: true }, { headers: false, body: false, response: false, query: false, cookies: false });
const ioRedisInst = createIORedisInstrumentation(true, {}, { headers: false, body: false, response: false, query: false, cookies: false });

registerInstrumentations({
  instrumentations: [pgInst, ioRedisInst],
});

import pg from 'pg';
import ioredis from 'ioredis';

const Client = pg.default ? pg.default.Client : pg.Client;
console.log('pg.Client.prototype.query isWrapped:', !!Client.prototype.query.__wrapped);

const Redis = ioredis.default || ioredis;
console.log('ioredis.prototype.sendCommand isWrapped:', !!Redis.prototype.sendCommand?.__wrapped);
