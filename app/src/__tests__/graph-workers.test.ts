/**
 * The bridges' betweenness pass off the main thread: in a worker thread for
 * wiki_status (lib/graph-worker-node.ts) and a Web Worker for the map
 * (lib/graph-worker-browser.ts), both built from the pass's own source text
 * (lib/graph-betweenness.ts). Each must give exactly the scores the pass
 * gives here; the browser one moves the arrays instead of copying them, and
 * runs here when no Worker exists.
 */

import { resolveObjectURL } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossTopicKernel, runHere, type BetweennessJob } from '../lib/graph-betweenness';
import { bridgeJob } from '../lib/graph-metrics';
import { runInBrowserWorker } from '../lib/graph-worker-browser';
import { runInWorkerThread } from '../lib/graph-worker-node';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Three linked islands of 30 pages with a few lines between them, some pages with no topic. */
function job(): BetweennessJob {
  const adj = new Map<string, string[]>();
  for (let i = 0; i < 90; i++) {
    const near = [i + 1, i + 3].filter((j) => j < 90 && Math.floor(j / 30) === Math.floor(i / 30));
    adj.set(`p${i}`, near.map((j) => `p${j}`));
  }
  for (const [a, b] of [['p5', 'p40'], ['p35', 'p70'], ['p0', 'p89']]) adj.get(a)?.push(b);
  return bridgeJob(adj, (id) => (Number(id.slice(1)) % 11 === 0 ? null : `T${Math.floor(Number(id.slice(1)) / 30)}`));
}

const expected = () => {
  const j = job();
  return Array.from(crossTopicKernel(j.start, j.next, j.topic));
};

describe('betweenness in a worker thread', () => {
  it('gives the same scores as the pass on this thread', async () => {
    const scores = await runInWorkerThread(job());
    expect(Array.from(scores)).toEqual(expected());
    expect(Array.from(scores).some((s) => s > 0)).toBe(true);
  });

  it('runs one worker per pass, side by side', async () => {
    const both = await Promise.all([runInWorkerThread(job()), runInWorkerThread(job())]);
    expect(both.map((s) => Array.from(s))).toEqual([expected(), expected()]);
  });
});

/**
 * A Web Worker stand-in: evaluates the blob's script with its own `self`,
 * and moves posted arrays the way structured clone with transfer does.
 */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  private scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(data: unknown, transfer?: ArrayBuffer[]): void };
  private ready: Promise<void>;

  constructor(url: string) {
    FakeWorker.made.push(this);
    this.scope = {
      onmessage: null,
      postMessage: (data, transfer) => {
        const moved = structuredClone(data, { transfer });
        queueMicrotask(() => this.onmessage?.({ data: moved }));
      },
    };
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error('no blob at that URL');
    this.ready = blob.text().then((source) => new Function('self', source)(this.scope));
  }

  postMessage(data: unknown, transfer?: ArrayBuffer[]): void {
    const moved = structuredClone(data, { transfer });
    void this.ready.then(() => this.scope.onmessage?.({ data: moved }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('betweenness in a Web Worker', () => {
  it('runs on this thread where no Worker exists', async () => {
    vi.stubGlobal('Worker', undefined);
    const pass = runInBrowserWorker(job());
    expect(Array.from(await pass.scores)).toEqual(expected());
  });

  it('runs the worker script, moves the arrays to it and stops it when done', async () => {
    FakeWorker.made = [];
    vi.stubGlobal('Worker', FakeWorker);
    const j = job();
    const pass = runInBrowserWorker(j);
    // Transferred, not copied: this thread's arrays are now empty.
    expect(j.start.length + j.next.length + j.topic.length).toBe(0);
    expect(Array.from(await pass.scores)).toEqual(expected());
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0].terminated).toBe(true);
  });

  it('stops the worker when the page moves on, and then never answers', async () => {
    FakeWorker.made = [];
    vi.stubGlobal('Worker', FakeWorker);
    const pass = runInBrowserWorker(job());
    pass.cancel();
    expect(FakeWorker.made[0].terminated).toBe(true);
    const settled = await Promise.race([pass.scores.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 50))]);
    expect(settled).toBe('pending');
  });

  it('reports a worker that fails', async () => {
    class Failing extends FakeWorker {
      override postMessage(): void {
        queueMicrotask(() => this.onerror?.({ message: 'out of memory' }));
      }
    }
    vi.stubGlobal('Worker', Failing);
    await expect(runInBrowserWorker(job()).scores).rejects.toThrow('out of memory');
  });

  it('keeps the plain pass for tests that pass no worker', async () => {
    expect(Array.from(await runHere(job()))).toEqual(expected());
  });
});
