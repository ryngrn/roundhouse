import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callRoundhouseTool, createRoundhouseMcpServer, roundhouseToolCatalog, roundhouseToolChangesState } from "./server.js";
import { MCP_PROTOCOL_VERSION, McpEventBroker, principalFromRequest } from "./events.js";

const serverInfo = { name: "roundhouse-depot", version: "0.1.0" };
const instructions = "Capture intent verbatim. Roundhouse owns project inference, material questions, planning, priority, readiness, execution policy, verification, and shipping. Use answer_question only with the current durable question revision.";

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
        if (roundhouseToolChangesState(message.params?.name)) Promise.resolve().then(onMutation).catch(() => {});
      } catch (error) {
        if (error.code === -32602) throw error;
        result = { resultType: "complete", content: [{ type: "text", text: error.message }], isError: true };
      }
    } else if (message.method === "events/list") {
      result = events.list();
    } else if (message.method === "events/subscribe") {
      result = await events.subscribe(message.params, principalFromRequest(request));
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
