const DAY_MS = 24 * 60 * 60 * 1000;

export class ControlPlaneHealthScheduler {
  constructor({ store, onError = () => {}, now = () => Date.now(), setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout, intervalMs = DAY_MS, minimumBackoffMs = 5 * 60 * 1000,
    maximumBackoffMs = 6 * 60 * 60 * 1000 } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error("Health check interval must be positive.");
    if (!Number.isFinite(minimumBackoffMs) || minimumBackoffMs < 1) throw new Error("Health check minimum backoff must be positive.");
    if (!Number.isFinite(maximumBackoffMs) || maximumBackoffMs < minimumBackoffMs) {
      throw new Error("Health check maximum backoff must not be less than its minimum backoff.");
    }
    this.store = store;
    this.onError = onError;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.intervalMs = intervalMs;
    this.minimumBackoffMs = minimumBackoffMs;
    this.maximumBackoffMs = maximumBackoffMs;
    this.enabled = typeof store?.getControlPlaneHealthEvidence === "function"
      && typeof store?.runControlPlaneHealthCheck === "function";
    this.timer = null;
    this.running = null;
    this.started = false;
    this.stopped = true;
    this.lastSuccessAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.nextCheckAt = null;
    this.failureCount = 0;
  }

  schedule(delay) {
    if (this.stopped || !this.enabled) return;
    if (this.timer) this.clearTimeoutFn(this.timer);
    const boundedDelay = Math.max(0, Math.min(delay, 2_147_483_647));
    this.nextCheckAt = new Date(this.now() + boundedDelay).toISOString();
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.nextCheckAt = null;
      this.check();
    }, boundedDelay);
    this.timer.unref?.();
  }

  async start() {
    if (!this.enabled || this.started) return this.running;
    this.started = true;
    this.stopped = false;
    try {
      const evidence = await this.store.getControlPlaneHealthEvidence();
      this.lastSuccessAt = evidence?.last_success_at ?? null;
      const elapsed = this.lastSuccessAt ? this.now() - Date.parse(this.lastSuccessAt) : this.intervalMs;
      if (Number.isFinite(elapsed) && elapsed < this.intervalMs) this.schedule(this.intervalMs - Math.max(0, elapsed));
      else await this.check();
    } catch (error) {
      this.failed(error);
    }
    return this.running;
  }

  failed(error) {
    this.failureCount += 1;
    this.lastError = error.message;
    this.onError(error);
    const delay = Math.min(this.maximumBackoffMs, this.minimumBackoffMs * (2 ** Math.min(this.failureCount - 1, 30)));
    this.schedule(delay);
  }

  check() {
    if (!this.enabled || this.stopped) return Promise.resolve(null);
    if (this.running) return this.running;
    this.lastAttemptAt = new Date(this.now()).toISOString();
    this.running = (async () => {
      try {
        const evidence = await this.store.runControlPlaneHealthCheck();
        this.lastSuccessAt = evidence.last_success_at;
        this.lastError = null;
        this.failureCount = 0;
        this.schedule(this.intervalMs);
        return evidence;
      } catch (error) {
        this.failed(error);
        return null;
      }
    })();
    return this.running.finally(() => { this.running = null; });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    await this.running;
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.running),
      last_success_at: this.lastSuccessAt,
      last_attempt_at: this.lastAttemptAt,
      last_error: this.lastError,
      next_check_at: this.nextCheckAt,
      consecutive_failures: this.failureCount,
    };
  }
}
