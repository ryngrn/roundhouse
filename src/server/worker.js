export class WorkerLoop {
  constructor({ service, intervalMs = 2000, onError = () => {} }) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.running = null;
    this.timer = null;
    this.lastRun = null;
    this.lastError = null;
  }

  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        if (!this.service.engine) return { executed: 0 };
        const result = await this.service.engine.run();
        this.lastRun = new Date().toISOString();
        this.lastError = null;
        return result;
      } catch (error) {
        if (!/^Locked:/.test(error.message)) {
          this.lastError = error.message;
          this.onError(error);
        }
        return { executed: 0, error: error.message };
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  wake() {
    queueMicrotask(() => this.tick());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return { running: Boolean(this.running), last_run: this.lastRun, last_error: this.lastError };
  }
}
