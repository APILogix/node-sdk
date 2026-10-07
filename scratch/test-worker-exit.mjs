import { Worker } from 'worker_threads';
const code = `
  const { parentPort } = require('worker_threads');
  parentPort.on('message', () => {});
`;
const w = new Worker(code, { eval: true });
w.once('online', () => {
  console.log('Worker online. Calling process.exit(1)...');
  process.exit(1);
});
