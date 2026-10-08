import http from "node:http";
import https from "node:https";

const clients = { "http:": http, "https:": https };

export class HttpWakeSource {
  constructor({ url, wake, minimumBackoffMs = 1_000, maximumBackoffMs = 30_000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random, get, health = null } = {}) {
    try { this.url = url ? new URL(url) : null; }
    catch { throw new Error("Invalid wake subscribe URL."); }
    if (this.url && !clients[this.url.protocol]) throw new Error("Wake subscribe URL must use HTTP or HTTPS.");
    this.wake = wake;
    this.minimumBackoffMs = minimumBackoffMs;
    this.maximumBackoffMs = maximumBackoffMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.random = random;
    this.get = get;
    this.health = health;
    this.request = null;
    this.response = null;
    this.reconnectTimer = null;
    this.backoffMs = minimumBackoffMs;
    this.failureCount = 0;
    this.stopped = true;
  }

  observe(operation) { Promise.resolve(operation).catch(() => {}); }

  matches(url) {
    try { return Boolean(this.url && new URL(url).href === this.url.href); }
    catch { return false; }
  }

  reconcile(url) {
    const verified = new URL(url);
    if (!clients[verified.protocol]) throw new Error("Wake subscribe URL must use HTTP or HTTPS.");
    if (this.matches(verified)) return false;
    const wasRunning = !this.stopped;
    this.stop();
    this.url = verified;
    this.backoffMs = this.minimumBackoffMs;
    this.failureCount = 0;
    if (wasRunning) this.start();
    return true;
  }

  start() {
    if (!this.url || !this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.request) return;
    const client = clients[this.url.protocol];
    let request;
    try {
      request = this.get
        ? this.get(this.url, { headers: { accept: "application/x-ndjson, application/json" } })
        : client.get(this.url, { headers: { accept: "application/x-ndjson, application/json" } });
    } catch {
      this.observe(this.health?.recordWakeVerification({ verified: false, failure: "connection_error" }));
      this.scheduleReconnect();
      return;
    }
    this.request = request;
    request.once("error", () => this.disconnected(request, "connection_error"));
    request.once("response", (response) => {
      if (this.request !== request || this.stopped) { response.destroy(); return; }
      this.response = response;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.observe(this.health?.recordWakeVerification({ verified: false, failure: "http_status" }));
        response.resume();
        this.disconnected(request, null);
        return;
      }
      response.setEncoding("utf8");
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event?.event === "message") {
              // A useful event proves that the subscription is healthy. A merely
              // accepted connection may close immediately, so it must not reset
              // a failure streak.
              this.backoffMs = this.minimumBackoffMs;
              this.failureCount = 0;
              this.observe(this.health?.recordWakeReceived());
              this.wake?.();
            }
          } catch {}
        }
      });
      response.once("end", () => this.disconnected(request, "connection_error"));
      response.once("error", () => this.disconnected(request, "connection_error"));
      response.once("close", () => this.disconnected(request, "connection_error"));
    });
  }

  disconnected(request = this.request, failure = null) {
    // end, error and close commonly arrive for the same stream. Events from an
    // older stream must not tear down a replacement subscription.
    if (this.stopped || request !== this.request) return;
    const response = this.response;
    const activeRequest = this.request;
    this.response = null;
    this.request = null;
    response?.destroy();
    activeRequest?.destroy();
    if (failure) this.observe(this.health?.recordWakeVerification({ verified: false, failure }));
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const ceiling = Math.min(this.maximumBackoffMs, this.backoffMs);
    // Equal jitter keeps retries exponential while preventing synchronized
    // watchers from reconnecting in lockstep. The ceiling remains bounded.
    const delay = Math.floor((ceiling / 2) + (this.random() * ceiling / 2));
    this.backoffMs = Math.min(this.maximumBackoffMs, this.backoffMs * 2);
    this.failureCount += 1;
    this.observe(this.health?.recordBackoff({
      consecutiveFailures: this.failureCount, backoffMs: delay,
    }));
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
    this.response?.destroy();
    this.request?.destroy();
    this.response = null;
    this.request = null;
  }
}
