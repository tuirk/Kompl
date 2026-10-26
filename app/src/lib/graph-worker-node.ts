/**
 * Runs the bridges' betweenness pass (graph-betweenness.ts) in a worker
 * thread, so wiki_status never runs it on the event loop that serves
 * compile commits and n8n callbacks (it is O(pages x lines): seconds on a
 * large wiki). The worker is built from the pass's source text, so there is
 * no separate file for the bundler to place, and it never opens the
 * database: it gets the CSR arrays and sends the scores back. Server only.
 */

import { Worker } from 'node:worker_threads';
import { KERNEL_SOURCE, type BetweennessRunner } from './graph-betweenness';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const kernel = ${KERNEL_SOURCE};
const scores = kernel(workerData.start, workerData.next, workerData.topic);
parentPort.postMessage(scores, [scores.buffer]);
`;

/** One worker per pass; it ends once the scores are back. Rejects if the worker fails. */
export const runInWorkerThread: BetweennessRunner = (job) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { start: job.start, next: job.next, topic: job.topic },
    });
    worker.once('message', (scores: Float64Array) => {
      resolve(scores);
      void worker.terminate();
    });
    worker.once('error', reject);
    // After a result this changes nothing: a promise settles once.
    worker.once('exit', (code) => reject(new Error(`betweenness worker stopped (exit code ${code}) without a result`)));
  });
