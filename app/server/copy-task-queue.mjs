import { COPY_GENERATION_CONFIG } from "../config/copy-generation.mjs";

export class CopyTaskQueue {
  constructor(concurrency = COPY_GENERATION_CONFIG.initialConcurrency) {
    this.concurrency = Math.max(1, Math.min(COPY_GENERATION_CONFIG.maximumConcurrency, Number(concurrency) || 1));
    this.active = 0;
    this.pending = [];
    this.peakActive = 0;
    this.throttleTimer = null;
  }

  throttle(durationMs = 30_000) {
    this.concurrency = 1;
    clearTimeout(this.throttleTimer);
    this.throttleTimer = setTimeout(() => {
      this.concurrency = COPY_GENERATION_CONFIG.initialConcurrency;
      this.#drain();
    }, Math.max(1, Number(durationMs) || 30_000));
    this.throttleTimer.unref?.();
  }

  restore() {
    clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    this.concurrency = COPY_GENERATION_CONFIG.initialConcurrency;
    this.#drain();
  }

  add(task, { taskId = "copy-unit", onQueueStatus } = {}) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, taskId, onQueueStatus, resolve, reject });
      onQueueStatus?.({ taskId, state: "queued", active: this.active, queued: this.pending.length, concurrency: this.concurrency });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const entry = this.pending.shift();
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      entry.onQueueStatus?.({ taskId: entry.taskId, state: "running", active: this.active, queued: this.pending.length, concurrency: this.concurrency });
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1;
        entry.onQueueStatus?.({ taskId: entry.taskId, state: "finished", active: this.active, queued: this.pending.length, concurrency: this.concurrency });
        this.#drain();
      });
    }
  }
}

export const copyTaskQueue = new CopyTaskQueue();
