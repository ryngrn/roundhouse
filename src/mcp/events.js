import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";
import { itemView } from "../workflow/views.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const WORK_EVENT_NAME = "roundhouse.work.updated";

const defaultTtlMs = 7 * 24 * 60 * 60 * 1_000;
const maximumTtlMs = 30 * 24 * 60 * 60 * 1_000;
const verificationCacheMs = 10 * 60 * 1_000;
const signingRotationMs = 5 * 60 * 1_000;
const deliveryLeaseMs = 30 * 1_000;
const defaultRetryDelays = [1_000, 5_000, 30_000, 120_000, 600_000];
const notificationStates = new Set(["Needs Clarification", "Review", "Blocked", "Shipped"]);
const progressStates = new Set(["Executing", "Verification", "Rework"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function eventState(data) {
  data.mcp_events ??= { subscriptions: {}, deliveries: {}, verified_endpoints: {} };
  data.mcp_events.subscriptions ??= {};
  data.mcp_events.deliveries ??= {};
  data.mcp_events.verified_endpoints ??= {};
  return data.mcp_events;
}

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { code, data });
}

function validateArguments(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) throw rpcError(-32602, "InvalidParams", { reason: "arguments_must_be_an_object" });
  const allowed = new Set(["item_id", "project_id", "include_progress"]);
  if (Object.keys(argumentsValue).some((key) => !allowed.has(key))) throw rpcError(-32602, "InvalidParams", { reason: "unknown_argument" });
  const scopes = [argumentsValue.item_id, argumentsValue.project_id].filter((value) => value !== undefined);
  if (scopes.length !== 1 || typeof scopes[0] !== "string" || !scopes[0].trim() || scopes[0].length > 200) {
    throw rpcError(-32602, "InvalidParams", { reason: "exactly_one_scope_required" });
  }
  if (argumentsValue.include_progress !== undefined && typeof argumentsValue.include_progress !== "boolean") {
    throw rpcError(-32602, "InvalidParams", { reason: "include_progress_must_be_boolean" });
  }
  return {
    ...(argumentsValue.item_id === undefined ? {} : { item_id: argumentsValue.item_id }),
    ...(argumentsValue.project_id === undefined ? {} : { project_id: argumentsValue.project_id }),
    include_progress: argumentsValue.include_progress === true,
  };
}

function validateSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw rpcError(-32602, "InvalidParams", { reason: "invalid_signing_secret" });
  let decoded;
  try { decoded = Buffer.from(secret.slice(6), "base64"); }
  catch { throw rpcError(-32602, "InvalidParams", { reason: "invalid_signing_secret" }); }
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString("base64").replace(/=+$/, "") !== secret.slice(6).replace(/=+$/, "")) {
    throw rpcError(-32602, "InvalidParams", { reason: "invalid_signing_secret" });
  }
  return secret;
}

function ipPublic(address) {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
    return normalized.range() === "unicast";
  } catch { return false; }
}

function loopbackAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
    return normalized.range() === "loopback";
  } catch { return false; }
}

async function resolveCallback(value, allowInsecureLoopback) {
  let url;
  try { url = new URL(value); }
  catch { throw rpcError(-32602, "InvalidParams", { reason: "invalid_callback_url" }); }
  if (url.username || url.password || url.hash || !url.hostname) throw rpcError(-32602, "InvalidParams", { reason: "invalid_callback_url" });
  if (url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:")) {
    throw rpcError(-32602, "InvalidParams", { reason: "callback_requires_https" });
  }
  let addresses;
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw rpcError(-32015, "CallbackEndpointError", { reason: "connection_refused" }); }
  if (!addresses.length) throw rpcError(-32015, "CallbackEndpointError", { reason: "connection_refused" });
  const accepted = addresses.filter(({ address }) => ipPublic(address) || (allowInsecureLoopback && loopbackAddress(address)));
  if (accepted.length !== addresses.length || !accepted.length) throw rpcError(-32602, "InvalidParams", { reason: "callback_address_not_public" });
  return { url, address: accepted[0] };
}

function responseReason(error) {
  if (error?.code === "ETIMEDOUT" || error?.name === "AbortError") return "timeout";
  if (String(error?.code ?? "").startsWith("ERR_TLS") || /certificate|TLS/i.test(error?.message ?? "")) return "tls_error";
  return "connection_refused";
}

async function postSigned({ url, address, subscriptionId, messageId, secret, oldSecret, body, timeoutMs = 10_000 }) {
  const signedAt = new Date();
  const signatures = [new Webhook(secret).sign(messageId, signedAt, body)];
  if (oldSecret) signatures.push(new Webhook(oldSecret).sign(messageId, signedAt, body));
  const client = url.protocol === "https:" ? https : http;
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "webhook-id": messageId,
    "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1_000)),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
    Host: url.host,
  };
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      headers,
      timeout: timeoutMs,
      agent: false,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1_024) chunks.push(chunk);
        else request.destroy(Object.assign(new Error("Callback response is too large."), { code: "ETOOBIG" }));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("Callback timed out."), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    request.end(body);
  });
}

export const roundhouseEventDefinition = {
  name: WORK_EVENT_NAME,
  description: "A scoped Roundhouse work item needs human input, becomes materially blocked, ships, or (when explicitly requested) makes meaningful build progress.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      item_id: { type: "string", minLength: 1, maxLength: 200, description: "One durable Depot item to monitor." },
      project_id: { type: "string", minLength: 1, maxLength: 200, description: "One configured Roundhouse project to monitor." },
      include_progress: { type: "boolean", default: false, description: "Also receive meaningful Executing, Verification, and Rework transitions." },
    },
    oneOf: [{ required: ["item_id"] }, { required: ["project_id"] }],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      item_id: { type: "string" },
      project: { type: ["string", "null"] },
      state: { type: "string" },
      kind: { enum: ["needs_you", "blocked", "shipped", "progress"] },
      question_id: { type: ["string", "null"] },
      question_revision: { type: ["integer", "null"] },
      reason: { type: ["string", "null"] },
      summary: { type: "string" },
      shipping: { type: ["object", "null"] },
    },
    required: ["item_id", "project", "state", "kind", "question_id", "question_revision", "reason", "summary", "shipping"],
    additionalProperties: false,
  },
};

function subscriptionId(owner, url, name, argumentsValue) {
  return `sub_${sha256(`${owner}\n${url}\n${name}\n${canonical(argumentsValue)}`).slice(0, 32)}`;
}

function deliveryEvent(data, outbox, subscription) {
  const item = data.items[outbox.item_id];
  if (!item) return null;
  if (subscription.arguments.item_id && subscription.arguments.item_id !== item.id) return null;
  if (subscription.arguments.project_id && subscription.arguments.project_id !== item.project_id) return null;
  if (!notificationStates.has(outbox.state) && !(subscription.arguments.include_progress && progressStates.has(outbox.state))) return null;
  const view = itemView(data, item);
  if (outbox.state === "Shipped") {
    const finalShipment = data.outbox.findLast((candidate) => candidate.item_id === item.id && candidate.state === "Shipped");
    if (view.state !== "Shipped" || finalShipment?.id !== outbox.id) return null;
  }
  const question = ["Needs Clarification", "Review"].includes(outbox.state)
    ? (item.questions ?? []).find((candidate) => candidate.id === outbox.question_id && candidate.status === "open" && candidate.revision === outbox.question_revision)
    : null;
  if (["Needs Clarification", "Review"].includes(outbox.state) && !question) return null;
  const kind = ["Needs Clarification", "Review"].includes(outbox.state) ? "needs_you"
    : outbox.state === "Blocked" ? "blocked"
      : outbox.state === "Shipped" ? "shipped" : "progress";
  return {
    eventId: `evt_${sha256(outbox.id).slice(0, 32)}`,
    name: WORK_EVENT_NAME,
    timestamp: outbox.at,
    data: {
      item_id: item.id,
      project: item.project_id ?? null,
      state: outbox.state,
      kind,
      question_id: question?.id ?? null,
      question_revision: question?.revision ?? null,
      reason: outbox.reason ?? null,
      summary: item.input.text.slice(0, 240),
      shipping: kind === "shipped" ? { deliveries: view.evidence.deliveries } : null,
    },
    cursor: null,
  };
}

export class McpEventBroker {
  constructor({ service, allowInsecureLoopback = false, retryDelaysMs = defaultRetryDelays, timeoutMs = 10_000, clock = () => Date.now() }) {
    this.service = service;
    this.store = service.store;
    this.allowInsecureLoopback = allowInsecureLoopback;
    this.retryDelaysMs = retryDelaysMs;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  list() {
    return { resultType: "complete", events: [roundhouseEventDefinition] };
  }

  async authorize(argumentsValue) {
    const data = await this.store.read();
    if (argumentsValue.item_id && !data.items[argumentsValue.item_id]) throw rpcError(-32011, "NotFound", { kind: "item" });
    if (argumentsValue.project_id) {
      const configured = this.service.config?.projects?.some((project) => project.id === argumentsValue.project_id);
      const known = configured || Object.values(data.items).some((item) => item.project_id === argumentsValue.project_id);
      if (!known) throw rpcError(-32011, "NotFound", { kind: "project" });
    }
  }

  async subscribe(params, owner = "local-anonymous") {
    if (params?.name !== WORK_EVENT_NAME) throw rpcError(-32011, "NotFound", { kind: "event" });
    const argumentsValue = validateArguments(params.arguments);
    await this.authorize(argumentsValue);
    if (params.delivery?.mode !== "webhook" || typeof params.delivery.url !== "string") throw rpcError(-32014, "Unsupported", { feature: "deliveryMode", value: params.delivery?.mode });
    const secret = validateSecret(params.delivery.secret);
    const resolved = await resolveCallback(params.delivery.url, this.allowInsecureLoopback);
    const id = subscriptionId(owner, resolved.url.href, params.name, argumentsValue);
    const now = this.clock();
    const cacheKey = sha256(`${owner}\n${resolved.url.href}`);
    const snapshot = await this.store.read();
    const cached = eventState(snapshot).verified_endpoints[cacheKey];
    if (!cached || Date.parse(cached.expires_at) <= now) {
      const challenge = randomBytes(32).toString("base64url");
      const body = JSON.stringify({ type: "verification", challenge });
      let response;
      try {
        response = await postSigned({ url: resolved.url, address: resolved.address, subscriptionId: id,
          messageId: `msg_verification_${randomBytes(16).toString("hex")}`, secret, body, timeoutMs: this.timeoutMs });
      } catch (error) {
        throw rpcError(-32015, "CallbackEndpointError", { reason: responseReason(error) });
      }
      if (response.status < 200 || response.status >= 300) throw rpcError(-32015, "CallbackEndpointError", { reason: response.status >= 500 ? "http_5xx" : "http_4xx" });
      let echoed;
      try { echoed = JSON.parse(response.body).challenge; } catch { echoed = ""; }
      const expected = Buffer.from(challenge);
      const actual = Buffer.from(typeof echoed === "string" ? echoed : "");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw rpcError(-32015, "CallbackEndpointError", { reason: "challenge_failed" });
    }
    const requestedTtl = params.ttlMs;
    if (requestedTtl !== undefined && requestedTtl !== null && (!Number.isInteger(requestedTtl) || requestedTtl <= 0)) throw rpcError(-32602, "InvalidParams", { reason: "invalid_ttl" });
    const ttl = requestedTtl === null ? null : Math.min(requestedTtl ?? defaultTtlMs, maximumTtlMs);
    const refreshBefore = ttl === null ? null : new Date(now + ttl).toISOString();
    await this.store.change((data) => {
      const events = eventState(data);
      const previous = events.subscriptions[id];
      const continuing = previous?.active && (!previous.refresh_before || Date.parse(previous.refresh_before) > now);
      const rotation = previous?.secret && previous.secret !== secret
        ? { previous_secret: previous.secret, previous_secret_until: new Date(now + signingRotationMs).toISOString() }
        : previous?.previous_secret_until && Date.parse(previous.previous_secret_until) > now
          ? { previous_secret: previous.previous_secret, previous_secret_until: previous.previous_secret_until }
          : {};
      events.verified_endpoints[cacheKey] = { owner, url: resolved.url.href, expires_at: new Date(now + verificationCacheMs).toISOString() };
      events.subscriptions[id] = {
        id,
        owner,
        name: params.name,
        arguments: argumentsValue,
        delivery: { mode: "webhook", url: resolved.url.href },
        secret,
        ...rotation,
        created_at: previous?.created_at ?? new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        refresh_before: refreshBefore,
        next_outbox_index: continuing ? previous.next_outbox_index : data.outbox.length,
        active: true,
      };
    });
    return { resultType: "complete", id, refreshBefore, cursor: null, truncated: false };
  }

  async unsubscribe(params, owner = "local-anonymous") {
    if (params?.name !== WORK_EVENT_NAME) return { resultType: "complete" };
    const argumentsValue = validateArguments(params.arguments);
    if (params.delivery?.mode !== "webhook" || typeof params.delivery.url !== "string") throw rpcError(-32602, "InvalidParams", { reason: "invalid_delivery" });
    let href;
    try { href = new URL(params.delivery.url).href; } catch { throw rpcError(-32602, "InvalidParams", { reason: "invalid_callback_url" }); }
    const id = subscriptionId(owner, href, params.name, argumentsValue);
    await this.store.change((data) => {
      const events = eventState(data);
      if (events.subscriptions[id]?.owner === owner) events.subscriptions[id].active = false;
      for (const delivery of Object.values(events.deliveries)) {
        if (delivery.subscription_id === id && !["delivered", "failed"].includes(delivery.status)) delivery.status = "cancelled";
      }
    });
    return { resultType: "complete" };
  }

  async materialize() {
    const now = this.clock();
    if (this.store.shared) {
      const snapshot = await this.store.read();
      if (!Object.values(snapshot.mcp_events?.subscriptions ?? {}).some((subscription) => subscription.active)) return;
    }
    await this.store.change((data) => {
      const events = eventState(data);
      for (const subscription of Object.values(events.subscriptions)) {
        if (!subscription.active || (subscription.refresh_before && Date.parse(subscription.refresh_before) <= now)) {
          subscription.active = false;
          continue;
        }
        for (let index = subscription.next_outbox_index ?? data.outbox.length; index < data.outbox.length; index++) {
          const outbox = data.outbox[index];
          const occurrence = deliveryEvent(data, outbox, subscription);
          if (occurrence) {
            const id = sha256(`${subscription.id}\n${outbox.id}`);
            events.deliveries[id] ??= {
              id,
              subscription_id: subscription.id,
              outbox_id: outbox.id,
              event_id: occurrence.eventId,
              occurrence,
              status: "pending",
              attempts: 0,
              next_attempt_at: new Date(now).toISOString(),
              created_at: new Date(now).toISOString(),
            };
          }
          subscription.next_outbox_index = index + 1;
        }
      }
    });
  }

  async claim() {
    const now = this.clock();
    return this.store.change((data) => {
      const events = eventState(data);
      const delivery = Object.values(events.deliveries).find((candidate) =>
        (["pending", "retry"].includes(candidate.status) && Date.parse(candidate.next_attempt_at) <= now) ||
        (candidate.status === "sending" && Date.parse(candidate.lease_until) <= now),
      );
      if (!delivery) return null;
      const subscription = events.subscriptions[delivery.subscription_id];
      if (!subscription?.active || (subscription.refresh_before && Date.parse(subscription.refresh_before) <= now)) {
        delivery.status = "cancelled";
        return null;
      }
      delivery.status = "sending";
      delivery.lease_until = new Date(now + deliveryLeaseMs).toISOString();
      delivery.attempts += 1;
      delivery.last_attempt_at = new Date(now).toISOString();
      return { delivery, subscription };
    });
  }

  async deliverClaim(claim) {
    const now = this.clock();
    const body = JSON.stringify(claim.delivery.occurrence);
    if (Buffer.byteLength(body, "utf8") > 256 * 1_024) throw new Error("Event payload exceeds 256 KiB.");
    let outcome;
    try {
      const resolved = await resolveCallback(claim.subscription.delivery.url, this.allowInsecureLoopback);
      const oldSecret = claim.subscription.previous_secret_until && Date.parse(claim.subscription.previous_secret_until) > now
        ? claim.subscription.previous_secret : undefined;
      const response = await postSigned({ url: resolved.url, address: resolved.address, subscriptionId: claim.subscription.id,
        messageId: claim.delivery.event_id, secret: claim.subscription.secret, oldSecret, body, timeoutMs: this.timeoutMs });
      outcome = { status: response.status, accepted: response.status >= 200 && response.status < 300 };
    } catch (error) {
      outcome = { status: 0, accepted: false, reason: responseReason(error) };
    }
    await this.store.change((data) => {
      const delivery = eventState(data).deliveries[claim.delivery.id];
      if (!delivery || delivery.status !== "sending") return;
      delete delivery.lease_until;
      if (outcome.accepted) {
        delivery.status = "delivered";
        delivery.delivered_at = new Date(now).toISOString();
        delivery.http_status = outcome.status;
        return;
      }
      delivery.http_status = outcome.status || null;
      delivery.last_error = outcome.reason ?? `http_${outcome.status}`;
      const permanent = [410, 413].includes(outcome.status) || (outcome.status >= 400 && outcome.status < 500 && ![408, 425, 429].includes(outcome.status));
      const delay = this.retryDelaysMs[delivery.attempts - 1];
      if (permanent || delay === undefined) {
        delivery.status = "failed";
        delivery.failed_at = new Date(now).toISOString();
      } else {
        delivery.status = "retry";
        delivery.next_attempt_at = new Date(now + delay).toISOString();
      }
    });
    return outcome;
  }

  async drain({ maximum = 100 } = {}) {
    await this.materialize();
    let attempted = 0;
    while (attempted < maximum) {
      const claim = await this.claim();
      if (!claim) break;
      await this.deliverClaim(claim);
      attempted += 1;
    }
    return { attempted };
  }
}

export function principalFromRequest(request) {
  const principalHeader = process.env.ROUNDHOUSE_MCP_PRINCIPAL_HEADER?.trim().toLowerCase();
  if (principalHeader) {
    const value = request.headers[principalHeader];
    if (typeof value !== "string" || !value.trim()) throw rpcError(-32012, "Forbidden", { reason: "missing_principal" });
    return `principal_${sha256(value).slice(0, 32)}`;
  }
  const authorization = request.headers.authorization;
  return authorization ? `auth_${sha256(authorization).slice(0, 32)}` : "local-anonymous";
}
