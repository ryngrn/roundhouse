#!/usr/bin/env node
import http from "node:http";
import { pathToFileURL } from "node:url";

export function startFrontDoor({ host = "127.0.0.1", port = 80, targetHost = "127.0.0.1", targetPort = 8787 } = {}) {
  const server = http.createServer((request, response) => {
    const incomingHost = (request.headers.host ?? "").split(":")[0].toLowerCase();
    if (incomingHost !== "roundhouse") {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Use http://roundhouse");
      return;
    }
    const upstream = http.request({
      hostname: targetHost, port: targetPort, method: request.method, path: request.url,
      headers: { ...request.headers, host: "roundhouse" },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) return response.end();
      if ((request.url ?? "").startsWith("/api/")) {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Roundhouse service unavailable. The local service is not running.", code: "service_unavailable" }));
        return;
      }
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Roundhouse is starting.");
    });
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startFrontDoor({
      port: Number(process.env.ROUNDHOUSE_FRONT_PORT ?? 80),
      targetPort: Number(process.env.ROUNDHOUSE_PORT ?? 8787),
    });
    process.stderr.write("Roundhouse front door listening at http://roundhouse\\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
