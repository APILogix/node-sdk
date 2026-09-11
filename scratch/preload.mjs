import { register, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';
import { createPgInstrumentation } from '../dist/instrumentation/pg.js';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

register();

const pgInst = createPgInstrumentation(true, { captureQueries: true }, { headers: false, body: false, response: false, query: false, cookies: false });
registerInstrumentations({
  instrumentations: [pgInst],
});
