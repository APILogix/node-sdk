import { register, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';
import { createPgInstrumentation } from '../dist/instrumentation/pg.js';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

register();

const pgInst = createPgInstrumentation(true, { captureQueries: true }, { headers: false, body: false, response: false, query: false, cookies: false });
registerInstrumentations({
  instrumentations: [pgInst],
});

const pg = await import('pg');
const Client = pg.default ? pg.default.Client : pg.Client;
console.log('Client.prototype.query isWrapped:', !!Client.prototype.query.__wrapped);
console.log('Client.prototype.query name:', Client.prototype.query.name);
