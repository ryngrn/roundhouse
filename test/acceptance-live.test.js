import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { git } from "../src/workflow/delivery.js";

const provider = fileURLToPath(new URL("./support/acceptance-provider.mjs", import.meta.url));

function request(base, pathname, { method = "GET", body, host } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { ...(host ? { host } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body === undefined) req.end(); else req.end(JSON.stringify(body));
  });
}

async function postJson(base, pathname, body) {
  const response = await request(base, pathname, { method: "POST", body });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response.json();
}

async function putJson(base, pathname, body) {
  const response = await request(base, pathname, { method: "PUT", body });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response.json();
}

test("acceptance: live Codex executor completes disposable Roundhouse workflow when available", { timeout: 240_000 }, async (t) => {
  if (process.env.npm_lifecycle_event !== "acceptance:live" && process.env.ROUNDHOUSE_LIVE_CODEX !== "1") {
    return t.skip("Live Codex acceptance runs only via npm run acceptance:live.");
  }
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (codex.status !== 0) return t.skip("Codex CLI is not installed or not runnable.");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-live-acceptance-"));
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  const stateDirectory = path.join(root, "state");
  const configFile = path.join(root, "projects.yaml");
  fs.mkdirSync(repository);
  git(root, ["init", "--bare", remote]);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Roundhouse Live Acceptance"]);
  git(repository, ["config", "user.email", "acceptance@roundhouse.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "Disposable live Codex acceptance project\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Initial"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "-u", "origin", "main"]);

  const running = await startRoundhouseServer({ stateDirectory, configFile, port: 0, autoStartWorker: false });
  t.after(() => running.close());
  await putJson(running.url, "/api/config", {
    configuration: {
      decision: { kind: "command", command: [process.execPath, provider, "decide"] },
      max_jobs_per_run: 5,
      projects: [{
        id: "live-codex",
        name: "Live Codex",
        purpose: "Disposable authenticated Codex executor acceptance",
        success_state: "Codex made and verified a local fixture change",
        status: "active",
        repository,
        executor: { kind: "codex", bin: "codex" },
        policy: { allow_autonomous: true, approval_required: false, shipping: "commit_only", max_rework_attempts: 0 },
        verification: [{
          id: "feature",
          command: [process.execPath, "-e", "const fs=require('fs'); const s=fs.readFileSync('feature.txt','utf8'); if(!s.includes('implemented: live codex acceptance')) process.exit(1)"],
        }],
      }],
    },
  });
  await postJson(running.url, "/api/intake", {
    content: "live codex acceptance",
    project_hint: "live-codex",
    idempotency_key: "live-codex-acceptance",
  });
  const tick = await postJson(running.url, "/api/worker/tick", {});
  assert.equal(tick.executed, 1);
  const overview = (await request(running.url, "/api/overview")).json();
  assert.equal(overview.items[0].state, "Shipped");
  assert.equal(overview.items[0].evidence.checks[0].passed, true);
  assert.equal(overview.items[0].evidence.deliveries[0].pushed, false);
});
