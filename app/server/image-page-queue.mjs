// Batch-local page admission. Waiting pages from one host do not occupy all
// global permits; the HTTP retrieval session still owns cookies and redirects.
export class ImagePageQueue {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.active = 0;
    this.peak = 0;
    this.pending = [];
    this.activeKeys = new Set();
  }

  add(worker, { key = '', signal } = {}) {
    return new Promise((resolve, reject) => {
      const aborted = () => signal?.reason || new DOMException('Page request cancelled', 'AbortError');
      if (signal?.aborted) { reject(aborted()); return; }
      const task = { worker, key, resolve, reject, signal };
      task.onAbort = () => {
        const index = this.pending.indexOf(task);
        if (index < 0) return; // Running work keeps its permit until it settles.
        this.pending.splice(index, 1);
        signal.removeEventListener('abort', task.onAbort);
        reject(aborted());
        this.drain();
      };
      signal?.addEventListener('abort', task.onAbort, { once: true });
      this.pending.push(task);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.limit) {
      const index = this.pending.findIndex(task => !task.key || !this.activeKeys.has(task.key));
      if (index < 0) return;
      const [task] = this.pending.splice(index, 1);
      task.signal?.removeEventListener('abort', task.onAbort);
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      if (task.key) this.activeKeys.add(task.key);
      const settle = (failed, value) => {
        this.active -= 1;
        if (task.key) this.activeKeys.delete(task.key);
        failed ? task.reject(value) : task.resolve(value);
        this.drain();
      };
      Promise.resolve().then(() => {
        if (task.signal?.aborted) throw task.signal.reason || new DOMException('Page request cancelled', 'AbortError');
        return task.worker();
      }).then(value => settle(false, value), error => settle(true, error));
    }
  }
}

export function imagePageHost(value) {
  try { return new URL(value).hostname; } catch { return ''; }
}
