#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { RoundhouseService } from "../workflow/service.js";
import { handleMcpRequest } from "../mcp/http-server.js";
import { McpEventBroker, McpEventDrainScheduler } from "../mcp/events.js";
import { WorkerLoop } from "./worker.js";
import { HttpWakeSource } from "./wake-source.js";
import { openPostgresRelay, RelayProjectionPublisher } from "../relay/postgres-relay.js";
import { openStorage } from "../storage/open.js";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);

export function defaultLocalPaths(home = os.homedir()) {
  const root = path.join(home, "Library", "Application Support", "Roundhouse");
  return { root, stateDirectory: path.join(root, "state"), configFile: path.join(root, "projects.yaml") };
}

export function ensureLocalConfig(filename) {
  if (fs.existsSync(filename)) return;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, YAML.stringify({
    decision: { kind: "codex", bin: "codex" },
    max_jobs_per_run: 20,
    projects: [],
  }), { mode: 0o600, flag: "wx" });
}

function hostname(value) {
  try { return new URL(`http://${value}`).hostname.toLowerCase(); }
  catch { return ""; }
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": type.startsWith("text/html") ? "no-store" : "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  }).end(typeof body === "string" ? body : JSON.stringify(body));
}

async function jsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json."), { status: 415 });
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 1_000_000) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try { return JSON.parse(body || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function verifyOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin.toLowerCase())) throw Object.assign(new Error("Forbidden Origin"), { status: 403 });
}

function localStorageIdentity(store) {
  return {
    kind: store?.kind ?? (store?.shared ? "postgresql" : "local"),
    shared: Boolean(store?.shared),
    authoritative: true,
    checked: false,
    node: store?.node ? { id: store.node.id, name: store.node.name, capabilities: store.node.capabilities } : null,
  };
}

async function overviewFor(roundhouse, loop) {
  const storage = await roundhouse.getStorageStatus();
  if (!storage.connected) return { items: [], needs_you: [], counts: {},
    connection: { local_service: "connected", storage, worker: loop.status() } };
  const projection = await roundhouse.getDashboardProjection({ connection: {
    local_service: "connected",
    mcp: "available",
    endpoint: "/mcp",
    chatgpt: "managed externally; local connection state is not observable",
    worker: loop.status(),
    storage,
  } });
  return projection.overview;
}

export async function startRoundhouseServer({
  stateDirectory,
  configFile,
  host = "127.0.0.1",
  port = 8787,
  allowedHosts = [],
  service,
  worker,
  autoStartWorker = true,
  wakeSubscribeUrl = process.env.ROUNDHOUSE_WAKE_SUBSCRIBE_URL,
  wakeSource,
  remoteRelay,
  relayConnectionString,
} = {}) {
  const defaults = defaultLocalPaths();
  const state = stateDirectory ?? defaults.stateDirectory;
  const config = configFile ?? defaults.configFile;
  if (!service) ensureLocalConfig(config);
  const ownedStore = service ? null : await openStorage({ directory: state });
  const roundhouse = service ?? new RoundhouseService({ store: ownedStore, configFile: config });
  await roundhouse.initialize?.();
  const relay = remoteRelay === undefined
    ? (relayConnectionString ? openPostgresRelay({ connectionString: relayConnectionString }) : null)
    : remoteRelay;
  const ownsRelay = remoteRelay === undefined && Boolean(relay);
  const events = new McpEventBroker({ service: roundhouse });
  const eventDrain = new McpEventDrainScheduler({ broker: events, onError: (error) => process.stderr.write(`MCP event delivery: ${error.message}\n`) });
  const loop = worker ?? new WorkerLoop({ service: roundhouse, eventBroker: eventDrain, commandQueue: relay,
    onError: (error) => process.stderr.write(`Worker: ${error.message}\n`) });
  loop.eventBroker ??= eventDrain;
  loop.commandQueue ??= relay;
  let localSnapshot = {
    captured_at: null,
    items: [], needs_you: [], counts: { needs_you: 0, active: 0, queued: 0, completed: 0, blocked: 0 },
    notifications: [], cursor: null,
    connection: { local_service: "connected", worker: loop.status(), storage: localStorageIdentity(roundhouse.store) },
  };
  const notificationPositions = new Map();
  let cachedNotifications = [];
  // Advance the shared notification cursor once per refresh, even when reads overlap.
  let refreshTail = Promise.resolve();
  const refreshLocalSnapshot = () => {
    const refresh = refreshTail.then(async () => {
      try {
        const previousCursor = localSnapshot.cursor;
        const [overview, notices] = await Promise.all([overviewFor(roundhouse, loop), roundhouse.getNotifications({ after: previousCursor ?? undefined })]);
        if (previousCursor) notificationPositions.set(previousCursor, cachedNotifications.length);
        for (const notice of notices.notifications) {
          cachedNotifications.push(notice);
          notificationPositions.set(notice.id, cachedNotifications.length);
        }
        if (notices.cursor) notificationPositions.set(notices.cursor, cachedNotifications.length);
        localSnapshot = { ...overview, notifications: cachedNotifications, cursor: notices.cursor, captured_at: new Date().toISOString() };
      } catch (error) {
        localSnapshot = { ...localSnapshot, captured_at: new Date().toISOString(), snapshot_error: error.message,
          connection: { ...localSnapshot.connection, worker: loop.status() } };
      }
    });
    refreshTail = refresh;
    return refresh;
  };
  const projectionPublisher = new RelayProjectionPublisher({
    relay,
    project: async () => ({
      schema_version: 2,
      projection_revision: localSnapshot.projection_revision,
      overview: localSnapshot,
      configuration: roundhouse.getConfiguration().configuration,
    }),
    onError: (error) => process.stderr.write(`Relay projection: ${error.message}\n`),
  });
  const previousOnCycle = loop.onCycle ?? (async () => {});
  loop.onCycle = async (result) => {
    await previousOnCycle(result);
    await refreshLocalSnapshot();
    projectionPublisher.trigger();
  };
  await refreshLocalSnapshot();
  projectionPublisher.trigger();
  const wakes = wakeSource ?? new HttpWakeSource({ url: wakeSubscribeUrl, wake: () => loop.wake() });
  const allowed = new Set([host, "roundhouse", ...(host === "127.0.0.1" ? ["localhost", "::1"] : []), ...allowedHosts].map((value) => value.toLowerCase()));
  const origins = new Set([
    "http://roundhouse",
    `http://${host}:${port}`,
    `http://localhost:${port}`,
    ...allowedHosts.flatMap((allowedHost) => [`http://${allowedHost.toLowerCase()}`, `http://${allowedHost.toLowerCase()}:${port}`]),
  ]);
  const httpServer = createServer(async (request, response) => {
    try {
      if (!allowed.has(hostname(request.headers.host))) return send(response, 403, "Forbidden Host", "text/plain; charset=utf-8");
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (url.pathname === "/mcp") {
        if (!["POST", "GET", "DELETE", "OPTIONS"].includes(request.method ?? "")) return send(response, 405, { error: "Method Not Allowed" });
        return await handleMcpRequest(request, response, roundhouse, events, { onMutation: () => loop.wake() });
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        return send(response, 200, fs.readFileSync(path.join(webRoot, filename), "utf8"), type);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok", service: "roundhouse", storage: localStorageIdentity(roundhouse.store), worker: loop.status(), mcp: "/mcp" });
      }
      if (request.method === "GET" && url.pathname === "/api/local-snapshot") {
        await refreshLocalSnapshot();
        projectionPublisher.trigger();
        const after = url.searchParams.get("after");
        const notifications = after ? localSnapshot.notifications.slice(notificationPositions.get(after) ?? localSnapshot.notifications.length) : localSnapshot.notifications;
        return send(response, 200, { ...localSnapshot, notifications });
      }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const overview = await overviewFor(roundhouse, loop);
        if (overview.connection.storage.connected === false) return send(response, 503, overview);
        return send(response, 200, overview);
      }
      if (request.method === "GET" && url.pathname === "/api/config") return send(response, 200, roundhouse.getConfiguration());
      if (request.method === "PUT" && url.pathname === "/api/config") {
        verifyOrigin(request, origins);
        const result = roundhouse.saveConfiguration((await jsonBody(request)).configuration);
        loop.service = roundhouse;
        loop.wake();
        return send(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/notifications") {
        return send(response, 200, await roundhouse.getNotifications({ after: url.searchParams.get("after") ?? undefined }));
      }
      if (request.method === "POST" && url.pathname === "/api/intake") {
        verifyOrigin(request, origins);
        const result = await roundhouse.addToDepot(await jsonBody(request), { source: "web", actor: "local-user" });
        loop.wake();
        return send(response, 201, result);
      }
      const answer = url.pathname.match(/^\/api\/questions\/([^/]+)\/answer$/);
      if (request.method === "POST" && answer) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.answerQuestion({ id: decodeURIComponent(answer[1]), answer: input.answer, expected_revision: input.expected_revision, actor: "local-user" });
        loop.wake();
        return send(response, 200, result);
      }
      const decisionSession = url.pathname.match(/^\/api\/items\/([^/]+)\/decision-session$/);
      if (request.method === "POST" && decisionSession) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.answerDecisionSession({
          item_id: decodeURIComponent(decisionSession[1]),
          expected_item_revision: input.expected_item_revision,
          answers: input.answers,
          actor: "local-user",
        });
        loop.wake();
        return send(response, 200, result);
      }
      const approve = url.pathname.match(/^\/api\/items\/([^/]+)\/approve$/);
      if (request.method === "POST" && approve) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.approveItem({ id: decodeURIComponent(approve[1]), expected_revision: input.expected_revision, actor: "local-user" });
        loop.wake();
        return send(response, 200, result);
      }
      const reconsider = url.pathname.match(/^\/api\/items\/([^/]+)\/reconsider$/);
      if (request.method === "POST" && reconsider) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.reconsiderItem({ id: decodeURIComponent(reconsider[1]), expected_revision: input.expected_revision, actor: "local-user" });
        loop.wake();
        return send(response, 200, result);
      }
      const reevaluateImport = url.pathname.match(/^\/api\/items\/([^/]+)\/reevaluate-import$/);
      if (request.method === "POST" && reevaluateImport) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.reevaluateImportedItem({ id: decodeURIComponent(reevaluateImport[1]), expected_revision: input.expected_revision, actor: "local-user" });
        loop.wake();
        return send(response, 200, result);
      }
      const retryTriage = url.pathname.match(/^\/api\/items\/([^/]+)\/retry-triage$/);
      if (request.method === "POST" && retryTriage) {
        verifyOrigin(request, origins);
        const input = await jsonBody(request);
        const result = await roundhouse.retryTriage({ id: decodeURIComponent(retryTriage[1]), expected_revision: input.expected_revision, actor: "local-user" });
        loop.wake();
        return send(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/worker/tick") {
        verifyOrigin(request, origins);
        await jsonBody(request);
        const result = await loop.tick();
        return send(response, 200, { triaged: result.triaged ?? 0, executed: result.executed ?? 0, worker: loop.status() });
      }
      return send(response, 404, { error: "Not Found" });
    } catch (error) {
      if (!response.headersSent) send(response, error.status ?? (error.code === "decision_session_conflict" || /Locked:/.test(error.message) ? 409 : 400), {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details && Object.keys(error.details).length ? { conflict: error.details } : {}),
      });
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  for (const allowedHost of allowedHosts) origins.add(`http://${allowedHost.toLowerCase()}:${address.port}`);
  if (autoStartWorker) loop.start();
  wakes.start();
  return {
    server: httpServer,
    service: roundhouse,
    worker: loop,
    url: `http://${host}:${address.port}`,
    close: async () => {
      wakes.stop();
      eventDrain.stop();
      projectionPublisher.stop();
      await loop.stop();
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      if (ownedStore) await ownedStore.close();
      if (ownsRelay) await relay.close().catch(() => {});
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const defaults = defaultLocalPaths();
  const host = process.env.ROUNDHOUSE_HOST ?? "127.0.0.1";
  const port = Number(process.env.ROUNDHOUSE_PORT ?? 8787);
  const allowedHosts = (process.env.ROUNDHOUSE_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  try {
    const running = await startRoundhouseServer({
      stateDirectory: process.env.ROUNDHOUSE_STATE_DIR ?? defaults.stateDirectory,
      configFile: process.env.ROUNDHOUSE_CONFIG ?? defaults.configFile,
      host, port, allowedHosts,
      relayConnectionString: process.env.ROUNDHOUSE_RELAY_DATABASE_URL,
    });
    process.stderr.write(`Roundhouse local engine listening at ${running.url}; dashboard https://roundhouse.ryan.green\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
  }
}
