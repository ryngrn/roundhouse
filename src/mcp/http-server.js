#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RoundhouseService } from "../workflow/service.js";
import { callRoundhouseTool, createRoundhouseMcpServer, roundhouseToolCatalog, roundhouseToolChangesState } from "./server.js";
import { MCP_PROTOCOL_VERSION, McpEventBroker, McpEventDrainScheduler, principalFromRequest } from "./events.js";
import { openStorage } from "../storage/open.js";

function requestHostname(value) {
  try { return new URL(`http://${value}`).hostname.toLowerCase(); }
  catch { return ""; }
}

const serverInfo = { name: "roundhouse-depot", version: "0.1.0" };
const instructions = "Capture intent verbatim. Roundhouse owns project inference, material questions, planning, priority, readiness, execution policy, verification, and shipping. Use answer_question only with the current durable question revision. On event-capable ChatGPT surfaces, after add_to_depot succeeds, immediately subscribe this conversation to roundhouse.work.updated with the returned item ID; do not call a status tool first. Poll with get_work_status and get_needs_human when Events are unavailable.";

async function jsonRequest(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 1_000_000) throw Object.assign(new Error("Request body is too large."), { code: -32600 });
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error("Parse error"), { code: -32700 }); }
}

function modernMeta() {
  return { "io.modelcontextprotocol/serverInfo": serverInfo };
}

function modernResponse(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "MCP-Protocol-Version",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  }).end(JSON.stringify(payload));
}

async function handleModernRequest(request, response, service, events, onMutation) {
  let message;
  try {
    message = await jsonRequest(request);
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined || typeof message.method !== "string") throw Object.assign(new Error("Invalid Request"), { code: -32600 });
    const meta = message.params?._meta;
    const requested = meta?.["io.modelcontextprotocol/protocolVersion"];
    const header = request.headers["mcp-protocol-version"];
    if (requested !== MCP_PROTOCOL_VERSION || header !== MCP_PROTOCOL_VERSION) {
      return modernResponse(response, 400, { jsonrpc: "2.0", id: message.id, error: {
        code: -32022, message: "Unsupported protocol version", data: { supported: [MCP_PROTOCOL_VERSION], requested: requested ?? header ?? null },
      } });
    }
    if (!meta?.["io.modelcontextprotocol/clientCapabilities"] || typeof meta["io.modelcontextprotocol/clientCapabilities"] !== "object") {
      throw Object.assign(new Error("Invalid Request"), { code: -32600, data: { reason: "missing_client_capabilities" } });
    }
    let result;
    if (message.method === "server/discover") {
      result = {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {}, events: {} },
        instructions,
        ttlMs: 300_000,
        cacheScope: "public",
      };
    } else if (message.method === "tools/list") {
      result = { resultType: "complete", tools: roundhouseToolCatalog, ttlMs: 300_000, cacheScope: "public" };
    } else if (message.method === "tools/call") {
      try {
        result = { resultType: "complete", ...(await callRoundhouseTool(service, message.params?.name, message.params?.arguments ?? {})), isError: false };
        if (message.params?.name === "add_to_depot" && result.structuredContent?.item?.id) {
          await events.recordOriginatingItem(result.structuredContent.item.id, meta);
        }
        if (roundhouseToolChangesState(message.params?.name)) Promise.resolve().then(onMutation).catch(() => {});
      } catch (error) {
        if (error.code === -32602) throw error;
        result = { resultType: "complete", content: [{ type: "text", text: error.message }], isError: true };
      }
    } else if (message.method === "events/list") {
      result = events.list();
    } else if (message.method === "events/subscribe") {
      result = await events.subscribe(message.params, principalFromRequest(request), meta);
    } else if (message.method === "events/unsubscribe") {
      result = await events.unsubscribe(message.params, principalFromRequest(request));
    } else {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    }
    result._meta = { ...(result._meta ?? {}), ...modernMeta() };
    return modernResponse(response, 200, { jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    return modernResponse(response, error.code === -32600 || error.code === -32700 ? 400 : 200, {
      jsonrpc: "2.0", id: message?.id ?? null, error: { code: error.code ?? -32603, message: error.message || "Internal error", ...(error.data ? { data: error.data } : {}) },
    });
  }
}

export async function handleMcpRequest(request, response, service, eventBroker, { onMutation = async () => {} } = {}) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-expose-headers", "Mcp-Session-Id, MCP-Protocol-Version");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
    }).end();
    return;
  }
  if (request.method === "POST" && request.headers["mcp-protocol-version"] === MCP_PROTOCOL_VERSION) {
    return handleModernRequest(request, response, service, eventBroker ?? new McpEventBroker({ service }), onMutation);
  }
  const server = createRoundhouseMcpServer(service, { onMutation });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

export async function startMcpHttpServer({ stateDirectory, configFile, host = "127.0.0.1", port = 8787, allowedHosts = [], service, eventBroker } = {}) {
  if (!service && (!stateDirectory || !configFile)) throw new Error("MCP server requires stateDirectory and configFile.");
  const ownedStore = service ? null : await openStorage({ directory: stateDirectory });
  const roundhouse = service ?? new RoundhouseService({ store: ownedStore, configFile });
  await roundhouse.initialize?.();
  const events = eventBroker ?? new McpEventBroker({ service: roundhouse });
  const eventDrain = new McpEventDrainScheduler({ broker: events });
  eventDrain.trigger();
  const hostnames = new Set([host, ...(host === "127.0.0.1" ? ["localhost", "::1"] : []), ...allowedHosts].map((value) => value.toLowerCase()));
  const httpServer = createServer(async (request, response) => {
    if (!hostnames.has(requestHostname(request.headers.host))) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden Host");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Roundhouse MCP server");
      return;
    }
    if (url.pathname !== "/mcp" || !["POST", "GET", "DELETE", "OPTIONS"].includes(request.method ?? "")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }
    try {
      await handleMcpRequest(request, response, roundhouse, events, { onMutation: () => eventDrain.trigger() });
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Internal Server Error");
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  return {
    server: httpServer,
    url: `http://${host}:${address.port}/mcp`,
    eventBroker: events,
    close: async () => {
      eventDrain.stop();
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      if (ownedStore) await ownedStore.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateDirectory = process.env.ROUNDHOUSE_STATE_DIR;
  const configFile = process.env.ROUNDHOUSE_CONFIG;
  const host = process.env.ROUNDHOUSE_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.ROUNDHOUSE_MCP_PORT ?? 8787);
  const allowedHosts = (process.env.ROUNDHOUSE_MCP_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  try {
    const running = await startMcpHttpServer({ stateDirectory, configFile, host, port, allowedHosts });
    process.stderr.write(`Roundhouse MCP listening at ${running.url}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
  }
}
