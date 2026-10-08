import http from "node:http";
import https from "node:https";

const clients = { "http:": http, "https:": https };
const VERIFIED = Symbol("verified wake configuration");

// The URL is never included in status or health evidence. Creation is the
// trust boundary for operator-owned startup
// configuration; runtime messages cannot supply a reconciliation target.
export function verifiedWakeConfiguration(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!clients[url.protocol] || !url.hostname || url.username || url.password) return null;
    return Object.freeze({ [VERIFIED]: true, url });
  } catch { return null; }
}

export function probeWakeChannel(url, { get, timeoutMs = 10_000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      request?.destroy();
      resolve(result);
    };
    const timer = setTimeoutFn(() => finish({ verified: false, failure: "timeout" }), timeoutMs);
    timer.unref?.();
    try {
      const client = clients[url.protocol];
      request = get
        ? get(url, { headers: { accept: "application/x-ndjson, application/json" } })
        : client.get(url, { headers: { accept: "application/x-ndjson, application/json" } });
      request.once("error", () => finish({ verified: false, failure: "connection_error" }));
      request.once("response", (response) => {
        const verified = response.statusCode >= 200 && response.statusCode < 300;
        response.resume?.();
        response.destroy?.();
        finish({ verified, failure: verified ? null : "http_status" });
      });
    } catch { finish({ verified: false, failure: "connection_error" }); }
  });
}

export class WakeChannelVerifier {
  constructor({ source, configuration, health = null, probe = probeWakeChannel,
    intervalMs = 6 * 60 * 60 * 1000, minimumBackoffMs = 30_000,
    maximumBackoffMs = 30 * 60 * 1000, maxRetries = 3, random = Math.random,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => Date.now() } = {}) {
    this.source = source;
    this.configuration = configuration?.[VERIFIED] ? configuration : null;
    this.health = health;
    this.probe = probe;
    this.intervalMs = intervalMs;
    this.minimumBackoffMs = minimumBackoffMs;
    this.maximumBackoffMs = maximumBackoffMs;
    this.maxRetries = maxRetries;
    this.random = random;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.stopped = true;
    this.failures = 0;
    this.nextCheckAt = null;
    this.retrying = false;
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error("Wake verification interval must be positive.");
    if (!Number.isFinite(minimumBackoffMs) || minimumBackoffMs < 1 ||
      !Number.isFinite(maximumBackoffMs) || maximumBackoffMs < minimumBackoffMs) {
      throw new Error("Wake verification backoff bounds are invalid.");
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new Error("Wake verification retries must be an integer from 0 to 10.");
    }
  }

  observe(operation) { Promise.resolve(operation).catch(() => {}); }

  schedule(delay) {
    if (this.stopped || !this.configuration || this.timer) return;
    this.nextCheckAt = new Date(this.now() + delay).toISOString();
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.nextCheckAt = null;
      return this.check();
    }, delay);
    this.timer.unref?.();
  }

  retryDelay() {
    const ceiling = Math.min(this.maximumBackoffMs,
      this.minimumBackoffMs * (2 ** Math.max(0, this.failures - 1)));
    return Math.floor((ceiling / 2) + (this.random() * ceiling / 2));
  }

  async check() {
    if (this.stopped || !this.configuration) return { checked: false };
    if (this.running) return this.running;
    this.running = (async () => {
      let result;
      try { result = await this.probe(this.configuration.url); }
      catch { result = { verified: false, failure: "connection_error" }; }
      if (this.stopped) return { checked: false };
      if (!result?.verified) {
        this.failures += 1;
        this.observe(this.health?.recordWakeVerification({ verified: false,
          failure: result?.failure ?? "invalid_response" }));
        const retrying = this.failures <= this.maxRetries;
        this.retrying = retrying;
        this.schedule(retrying ? this.retryDelay() : this.intervalMs);
        return { checked: true, verified: false, retrying };
      }

      let mismatch;
      try {
        mismatch = !this.source?.matches?.(this.configuration.url);
        if (mismatch) this.source.reconcile(this.configuration.url);
      } catch {
        this.failures += 1;
        this.observe(this.health?.recordWakeVerification({ verified: false, failure: "configuration_mismatch" }));
        const retrying = this.failures <= this.maxRetries;
        this.retrying = retrying;
        this.schedule(retrying ? this.retryDelay() : this.intervalMs);
        return { checked: true, verified: false, mismatch: true, reconciled: false, retrying };
      }
      this.failures = 0;
      this.retrying = false;
      this.observe(this.health?.recordWakeVerification({ verified: true,
        configurationMatched: !mismatch, reconciled: mismatch }));
      this.schedule(this.intervalMs);
      return { checked: true, verified: true, mismatch, reconciled: mismatch };
    })();
    try { return await this.running; }
    finally { this.running = null; }
  }

  start() {
    if (!this.stopped) return this.running ?? Promise.resolve({ checked: false });
    this.stopped = false;
    if (!this.configuration) return Promise.resolve({ checked: false });
    return this.check();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    this.retrying = false;
    await this.running;
  }

  status() {
    return { enabled: Boolean(this.configuration), running: Boolean(this.running),
      retrying: this.retrying, consecutive_failures: this.failures, next_check_at: this.nextCheckAt };
  }
}
