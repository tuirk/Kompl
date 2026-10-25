/**
 * Runs the bridges' betweenness pass (graph-betweenness.ts) in a Web Worker,
 * so the knowledge graph page answers zoom, pan and clicks while it runs
 * (deferring a render does not help: React cannot interrupt one long
 * calculation). The worker is built from the pass's source text and gets
 * the CSR arrays by transfer, not copy. Where no Worker can start (tests,
 * server render, a blocked worker), the pass runs on this thread.
 */

import { KERNEL_SOURCE, runHere, type BetweennessJob } from './graph-betweenness';

const WORKER_SOURCE = `
const kernel = ${KERNEL_SOURCE};
self.onmessage = (event) => {
  const scores = kernel(event.data.start, event.data.next, event.data.topic);
  self.postMessage(scores, [scores.buffer]);
};
`;

export interface PendingPass {
  /** Rejects if the worker fails; never settles once cancelled. */
  scores: Promise<Float64Array>;
  /** Stops the worker (the page moved on to another load). */
  cancel(): void;
}

function startWorker(): { worker: Worker; url: string } | null {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  try {
    return { worker: new Worker(url), url };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** Starts the pass in a worker, or here when none can start. The job's arrays move to the worker. */
export function runInBrowserWorker(job: BetweennessJob): PendingPass {
  const started = startWorker();
  if (!started) return { scores: runHere(job), cancel: () => {} };
  const { worker, url } = started;
  let done = false;
  const stop = () => {
    done = true;
    worker.terminate();
    URL.revokeObjectURL(url);
  };
  const scores = new Promise<Float64Array>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<Float64Array>) => {
      if (done) return;
      stop();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (done) return;
      stop();
      reject(new Error(event.message || 'betweenness worker failed'));
    };
  });
  const { start, next, topic } = job;
  worker.postMessage({ start, next, topic }, [start.buffer, next.buffer, topic.buffer]);
  return { scores, cancel: () => { if (!done) stop(); } };
}
