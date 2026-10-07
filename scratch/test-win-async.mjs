import { Worker } from 'worker_threads';

const code = `
  const { parentPort } = require('worker_threads');
  parentPort.on('message', (msg) => {
    parentPort.postMessage({ id: msg.id, result: 'done' });
  });
`;

const w = new Worker(code, { eval: true });
w.once('online', async () => {
  w.postMessage({ id: 1 });
  w.once('message', async (res) => {
    console.log('Received:', res);
    // DO NOT TERMINATE
    process.exit(1);
  });
});
