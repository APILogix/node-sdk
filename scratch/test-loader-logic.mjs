import * as nodeModule from 'node:module';
import { register as registerSyncHooks, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';

function registerEsmHooks() {
  if (supportsSyncHooks()) {
    registerSyncHooks();
    console.log('Registered sync hooks!');
    return true;
  }
  if (typeof nodeModule.register === 'function') {
    nodeModule.register('import-in-the-middle/hook.mjs', import.meta.url);
    console.log('Registered async hooks!');
    return true;
  }
  return false;
}

registerEsmHooks();
