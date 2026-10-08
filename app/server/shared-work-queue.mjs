// One backend process owns these queues. Waiting is cancellable; running work
// keeps its permit until it actually settles, including after an abort request.
export class SharedWorkQueue {
  constructor({ concurrency = 1 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid queue concurrency');
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
  }

  snapshot() { return { activeCount: this.active, waitingCount: this.waiting.length, concurrency: this.concurrency }; }

  notify(entry, state, extra = {}) {
    const position = this.waiting.indexOf(entry) + 1;
    try { entry.onState?.({ state, position: Math.max(0, position), queuedAt: entry.queuedAt,
      ...this.snapshot(), ...extra }); }
    catch { /* A diagnostic observer must not strand a permit. */ }
  }

  positions() { for (const entry of this.waiting) this.notify(entry, 'queued'); }

  enqueue(work, { signal, onState } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { work, signal, onState, resolve, reject, queuedAt: Date.now() };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return; // Active work releases only when it settles.
        this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        this.notify(entry, 'cancelled', { waitMs: Date.now() - entry.queuedAt });
        reject(Object.assign(new Error('Work cancelled before start'), { name: 'AbortError', code: 'queue_cancelled' }));
        this.positions();
      };
      entry.abort = abort;
      this.waiting.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else this.positions();
      queueMicrotask(() => this.drain());
    });
  }

  drain() {
    while (this.active < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      this.active++;
      const startedAt = Date.now();
      this.notify(entry, 'running', { startedAt, waitMs: startedAt - entry.queuedAt });
      this.positions();
      Promise.resolve().then(() => {
        if (entry.signal?.aborted) throw Object.assign(new Error('Work cancelled before start'), { name: 'AbortError', code: 'queue_cancelled' });
        return entry.work();
      }).then(value => this.finish(entry, 'complete', startedAt, null, value),
        error => this.finish(entry, error?.name === 'AbortError' ? 'cancelled' : 'failed', startedAt, error));
    }
  }

  finish(entry, state, startedAt, error, value) {
    this.active--;
    this.notify(entry, state, { waitMs: startedAt - entry.queuedAt, executionMs: Date.now() - startedAt });
    if (error) entry.reject(error); else entry.resolve(value);
    this.positions();
    this.drain();
  }
}

export const generationQueue = new SharedWorkQueue();
export const rendererQueue = new SharedWorkQueue();
