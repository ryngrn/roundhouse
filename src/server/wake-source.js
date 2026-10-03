import http from "node:http";
import https from "node:https";

const clients = { "http:": http, "https:": https };

export class HttpWakeSource {
  constructor({ url, wake, minimumBackoffMs = 1_000, maximumBackoffMs = 30_000,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    try { this.url = url ? new URL(url) : null; }
    catch { throw new Error("Invalid wake subscribe URL."); }
    if (this.url && !clients[this.url.protocol]) throw new Error("Wake subscribe URL must use HTTP or HTTPS.");
    this.wake = wake;
    this.minimumBackoffMs = minimumBackoffMs;
    this.maximumBackoffMs = maximumBackoffMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.request = null;
    this.response = null;
    this.reconnectTimer = null;
    this.backoffMs = minimumBackoffMs;
    this.stopped = true;
  }

  start() {
    if (!this.url || !this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.request) return;
    const client = clients[this.url.protocol];
    const request = client.get(this.url, { headers: { accept: "application/x-ndjson, application/json" } });
    this.request = request;
    request.once("error", () => this.disconnected());
    request.once("response", (response) => {
      if (this.request !== request || this.stopped) { response.destroy(); return; }
      this.response = response;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        this.disconnected();
        return;
      }
      this.backoffMs = this.minimumBackoffMs;
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
            if (event?.event === "message") this.wake?.();
          } catch {}
        }
      });
      response.once("end", () => this.disconnected());
      response.once("error", () => this.disconnected());
      response.once("close", () => this.disconnected());
    });
  }

  disconnected() {
    if (this.stopped) return;
    this.response?.destroy();
    this.request?.destroy();
    this.response = null;
    this.request = null;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.maximumBackoffMs, this.backoffMs * 2);
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
