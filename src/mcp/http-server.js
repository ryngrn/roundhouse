#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RoundhouseService } from "../workflow/service.js";
import { createRoundhouseMcpServer } from "./server.js";

function requestHostname(value) {
  try { return new URL(`http://${value}`).hostname.toLowerCase(); }
  catch { return ""; }
}

export async function handleMcpRequest(request, response, service) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-expose-headers", "Mcp-Session-Id");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version",
    }).end();
    return;
  }
  const server = createRoundhouseMcpServer(service);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

export async function startMcpHttpServer({ stateDirectory, configFile, host = "127.0.0.1", port = 8787, allowedHosts = [], service } = {}) {
  if (!service && (!stateDirectory || !configFile)) throw new Error("MCP server requires stateDirectory and configFile.");
  const roundhouse = service ?? new RoundhouseService({ stateDirectory, configFile });
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
      await handleMcpRequest(request, response, roundhouse);
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
    close: () => new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
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
