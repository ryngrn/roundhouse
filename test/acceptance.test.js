import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { Store } from "../src/workflow/store.js";
import { git } from "../src/workflow/delivery.js";

const provider = fileURLToPath(new URL("./support/acceptance-provider.mjs", import.meta.url));

function request(base, pathname, { method = "GET", body } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
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

function tempProject({ logFile, approvalRequired = true, autonomous = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-acceptance-"));
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  const stateDirectory = path.join(root, "state");
  const configFile = path.join(root, "projects.yaml");
  fs.mkdirSync(repository);
  git(root, ["init", "--bare", remote]);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Roundhouse Acceptance"]);
  git(repository, ["config", "user.email", "acceptance@roundhouse.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "Disposable acceptance project\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Initial"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "-u", "origin", "main"]);
  const command = [process.execPath, provider];
  const decideCommand = logFile ? [...command, "decide", logFile] : [...command, "decide"];
  return {
    root,
    repository,
    remote,
    stateDirectory,
    configFile,
    configuration: {
      decision: { kind: "command", command: decideCommand },
      max_jobs_per_run: 10,
      projects: [{
        id: "acceptance",
        name: "Acceptance",
        purpose: "Disposable Roundhouse workflow acceptance",
        success_state: "Verified fixture changes are deployed",
        status: "active",
        repository,
        context_sources: ["README.md"],
        executor: { kind: "command", command },
        policy: {
          allow_autonomous: autonomous,
          approval_required: approvalRequired,
          shipping: "deploy",
          continuation: "continue_project_queue",
          max_rework_attempts: 0,
        },
        deployment: { kind: "command", environment: "fixture", command: [...command, "deploy"] },
        verification: [{
          id: "feature",
          command: [process.execPath, "-e", "const fs=require('fs'); const s=fs.readFileSync('feature.txt','utf8'); if(!/implemented: (human review acceptance|autonomous acceptance)/.test(s)) process.exit(1)"],
        }, {
          id: "clean-git",
          command: [process.execPath, "-e", "const {execSync}=require('child_process'); if(execSync('git status --porcelain',{encoding:'utf8'}).trim()) process.exit(1)"],
        }],
      }],
    },
  };
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

async function overview(base) {
  const response = await request(base, "/api/overview");
  assert.equal(response.status, 200, response.text);
  return response.json();
}

test("acceptance: HTTP workflow clarifies once, approves, executes, verifies, fixture-ships, and survives restart", async (t) => {
  const logFile = path.join(os.tmpdir(), `roundhouse-acceptance-${process.pid}.jsonl`);
  fs.rmSync(logFile, { force: true });
  const fixture = tempProject({ logFile, approvalRequired: true, autonomous: false });
  const running = await startRoundhouseServer({
    stateDirectory: fixture.stateDirectory,
    configFile: fixture.configFile,
    port: 0,
    autoStartWorker: false,
  });
  t.after(() => running.close());

  await putJson(running.url, "/api/config", { configuration: fixture.configuration });
  const savedConfig = await request(running.url, "/api/config");
  assert.equal(savedConfig.json().configuration.projects[0].repository, fixture.repository);

  const submitted = await postJson(running.url, "/api/intake", {
    content: "human review acceptance",
    project_hint: "acceptance",
    idempotency_key: "human-review-acceptance",
  });
  assert.equal(submitted.item.state, "Depot");
  assert.equal(new Store(fixture.stateDirectory).read().items[submitted.item.id].input.text, "human review acceptance");

  await postJson(running.url, "/api/worker/tick", {});
  let state = await overview(running.url);
  assert.equal(state.needs_you.length, 1);
  assert.equal(state.needs_you[0].kind, "clarification");
  assert.match(state.needs_you[0].prompt, /manual README inspection/);

  const clarification = state.needs_you[0];
  await postJson(running.url, `/api/questions/${encodeURIComponent(clarification.id)}/answer`, {
    answer: "Manual README inspection plus the configured clean-git check is acceptable.",
    expected_revision: clarification.revision,
  });
  state = await overview(running.url);
  assert.equal(state.needs_you.length, 1);
  assert.equal(state.needs_you[0].kind, "review");
  assert.equal(state.items[0].state, "Review");
  assert.doesNotMatch(state.needs_you[0].prompt, /manual README inspection/);

  const packets = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const secondDecision = packets.filter((entry) => entry.mode === "decide").at(-1).packet;
  assert.equal(secondDecision.resolved_decisions[0].decision_key, "verification-method");
  assert.match(secondDecision.resolved_decisions[0].prompt, /manual README inspection/);
  assert.equal(secondDecision.resolved_decisions[0].answer.text, "Manual README inspection plus the configured clean-git check is acceptable.");

  const review = state.needs_you[0];
  await postJson(running.url, `/api/items/${encodeURIComponent(review.item_id)}/approve`, { expected_revision: review.item_revision });
  await postJson(running.url, "/api/worker/tick", {});
  state = await overview(running.url);
  assert.equal(state.counts.completed, 1);
  assert.equal(state.needs_you.length, 0);
  assert.equal(state.items[0].state, "Shipped");
  assert.match(state.items[0].outcome, /verified and shipped/);
  assert.equal(state.items[0].evidence.checks[0].passed, true);
  assert.equal(state.items[0].evidence.deliveries[0].deployment.provider, "command");
  assert.equal(state.items[0].evidence.deliveries[0].deployment.status, "succeeded");

  const persisted = new Store(fixture.stateDirectory).read();
  const job = Object.values(persisted.jobs)[0];
  assert.equal(job.state, "Shipped");
  assert.equal(job.shipping.verification.passed, true);
  assert.equal(job.shipping.deployment.status, "succeeded");
  assert.match(git(job.prepared.workspace, ["show", `${job.shipping.commit}:feature.txt`]), /implemented: human review acceptance/);

  const restarted = new RoundhouseService({ stateDirectory: fixture.stateDirectory, configFile: fixture.configFile });
  const restartedStatus = restarted.getWorkStatus();
  assert.equal(restartedStatus.items[0].state, "Shipped");
  assert.equal(restartedStatus.items[0].evidence.deliveries[0].deployment.status, "succeeded");
});

test("acceptance: autonomous HTTP workflow reaches Completed without human interaction", async (t) => {
  const fixture = tempProject({ approvalRequired: false, autonomous: true });
  const running = await startRoundhouseServer({
    stateDirectory: fixture.stateDirectory,
    configFile: fixture.configFile,
    port: 0,
    autoStartWorker: false,
  });
  t.after(() => running.close());

  await putJson(running.url, "/api/config", { configuration: fixture.configuration });
  await postJson(running.url, "/api/intake", {
    content: "autonomous small task",
    project_hint: "acceptance",
    idempotency_key: "autonomous-acceptance",
  });
  await postJson(running.url, "/api/worker/tick", {});
  const state = await overview(running.url);
  assert.equal(state.needs_you.length, 0);
  assert.equal(state.items[0].state, "Shipped");
  assert.equal(state.items[0].evidence.checks[0].passed, true);
  assert.equal(state.items[0].evidence.deliveries[0].deployment.status, "succeeded");
});

test("acceptance: resolved decision identity blocks repeated clarification loops after restart", async (t) => {
  const fixture = tempProject({ approvalRequired: true, autonomous: false });
  const running = await startRoundhouseServer({
    stateDirectory: fixture.stateDirectory,
    configFile: fixture.configFile,
    port: 0,
    autoStartWorker: false,
  });
  t.after(() => running.close());
  await putJson(running.url, "/api/config", { configuration: fixture.configuration });
  await postJson(running.url, "/api/intake", {
    content: "repeat resolved decision",
    project_hint: "acceptance",
    idempotency_key: "repeat-resolved-decision",
  });
  await postJson(running.url, "/api/worker/tick", {});
  let state = await overview(running.url);
  const question = state.needs_you[0];
  await postJson(running.url, `/api/questions/${encodeURIComponent(question.id)}/answer`, {
    answer: "Manual README inspection plus the configured clean-git check is acceptable.",
    expected_revision: question.revision,
  });
  state = await overview(running.url);
  assert.equal(state.items[0].state, "Blocked");
  assert.equal(state.needs_you.length, 0);
  assert.match(state.items[0].reason, /already resolved decision verification-method/);

  const restarted = new RoundhouseService({ stateDirectory: fixture.stateDirectory, configFile: fixture.configFile });
  const persisted = restarted.getWorkStatus();
  assert.equal(persisted.items[0].state, "Blocked");
  assert.match(persisted.items[0].reason, /already resolved decision verification-method/);
});
