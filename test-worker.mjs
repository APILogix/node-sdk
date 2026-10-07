import { Worker } from 'worker_threads';

const workerCode = `
import { parentPort } from 'worker_threads';
parentPort.on('message', (msg) => {
  setTimeout(() => {
    parentPort.postMessage('reply:' + msg);
  }, 100);
});
`;

const w = new Worker(workerCode, { eval: true });
w.on('online', () => {
  w.postMessage('ping');
  setTimeout(() => {
    // Exit while worker is in the middle of setTimeout/postMessage:
    process.exit(1);
  }, 10);
});
