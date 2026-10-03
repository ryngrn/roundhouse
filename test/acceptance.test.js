import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startRoundhouseServer } from "../src/server/app-server.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { Store } from "../src/workflow/store.js";
import { Engine } from "../src/workflow/engine.js";
import { git } from "../src/workflow/delivery.js";

const provider = fileURLToPath(new URL("./support/acceptance-provider.mjs", import.meta.url));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function request(base, pathname, { method = "GET", body, host = "roundhouse" } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: { host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

test("acceptance: real browser UI works on insecure roundhouse-compatible HTTP", async (t) => {
  if (!fs.existsSync(chrome)) return t.skip("Google Chrome is not installed.");
  const fixture = tempProject({ approvalRequired: false, autonomous: true });
  const running = await startRoundhouseServer({
    stateDirectory: fixture.stateDirectory,
    configFile: fixture.configFile,
    allowedHosts: ["roundhouse-compatible"],
    port: 0,
    autoStartWorker: false,
  });
  t.after(() => running.close());
  await putJson(running.url, "/api/config", { configuration: fixture.configuration });

  const browser = await chromium.launch({
    executablePath: chrome,
    args: [`--host-resolver-rules=MAP roundhouse-compatible 127.0.0.1`],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://roundhouse-compatible:${new URL(running.url).port}/`, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-filter-key="needs"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");

  assert.equal(await page.locator(".brand-name").evaluate((element) => getComputedStyle(element).opacity), "0");
  await page.locator(".brand").hover();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector(".brand-name")).opacity) > 0.9);
  await page.locator("#open-intake").click();
  assert.equal(await page.locator("#intake-dialog").evaluate((dialog) => dialog.open), true);
  await page.waitForFunction(() => document.activeElement === document.querySelector("#intake-content"));
  await page.setViewportSize({ width: 390, height: 844 });
  const intakeBounds = await page.locator("#intake-dialog").boundingBox();
  assert.deepEqual({ x: Math.round(intakeBounds.x), y: Math.round(intakeBounds.y), width: Math.round(intakeBounds.width), height: Math.round(intakeBounds.height) }, { x: 0, y: 0, width: 390, height: 844 });
  await page.setViewportSize({ width: 1280, height: 720 });
  const intake = page.locator("#intake-content");
  await intake.fill("first line");
  await intake.press("Shift+Enter");
  assert.equal(await intake.inputValue(), "first line\n");
  await intake.fill("ime draft");
  await page.dispatchEvent("#intake-content", "keydown", { key: "Enter", isComposing: true });
  assert.equal(await page.locator("#intake-message").textContent(), "");

  await intake.fill("x".repeat(100_001));
  await page.locator("#project-hint").fill("acceptance");
  await intake.press("Enter");
  await expectText(page, "#intake-message", /exceeds 100,000/);
  assert.equal((await intake.inputValue()).length, 100_001);

  await intake.fill("autonomous small task");
  await page.locator("#project-hint").fill("acceptance");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/intake") && response.status() === 201),
    intake.press("Enter"),
    page.getByRole("button", { name: "Add to Depot" }).click(),
  ]);
  assert.equal(await intake.inputValue(), "");
  assert.equal(Object.values(new Store(fixture.stateDirectory).read().items).length, 1);
  await postJson(running.url, "/api/worker/tick", {});
  await page.locator("#refresh").click();
  await page.locator('[data-filter-key="all"]').click();
  await expectText(page, "#project-board", /Reached the station\s*1/);
  await expectText(page, "#project-board", /autonomous acceptance/);

  await page.locator("#edit-config").click();
  const configEditor = page.locator("#config-editor");
  const config = JSON.parse(await configEditor.inputValue());
  config.projects[0].id = "Bad ID";
  await configEditor.fill(JSON.stringify(config));
  await page.locator("#save-config").click();
  await expectText(page, "#config-message", /Project id must be a stable lowercase slug/);
});

test("acceptance: real browser Needs a signal drafts survive explicit refreshes", async (t) => {
  if (!fs.existsSync(chrome)) return t.skip("Google Chrome is not installed.");
  const fixture = tempProject({ approvalRequired: false, autonomous: true });
  const running = await startRoundhouseServer({
    stateDirectory: fixture.stateDirectory,
    configFile: fixture.configFile,
    allowedHosts: ["roundhouse-compatible"],
    port: 0,
    autoStartWorker: false,
  });
  t.after(() => running.close());
  await putJson(running.url, "/api/config", { configuration: fixture.configuration });
  await postJson(running.url, "/api/intake", {
    content: "human review acceptance",
    project_hint: "acceptance",
    idempotency_key: "browser-needs-you",
  });
  await postJson(running.url, "/api/worker/tick", {});

  const browser = await chromium.launch({
    executablePath: chrome,
    args: [`--host-resolver-rules=MAP roundhouse-compatible 127.0.0.1`],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://roundhouse-compatible:${new URL(running.url).port}/`, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-filter-key="needs"]').getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: /Open human review acceptance, Needs a signal/ }).click();
  const answer = page.locator("#decision-answer");
  await answer.fill("Manual README inspection");
  await answer.press("Shift+Enter");
  assert.equal(await answer.inputValue(), "Manual README inspection\n");
  await page.dispatchEvent("#decision-answer", "keydown", { key: "Enter", isComposing: true });
  assert.equal((await overview(running.url)).needs_you.length, 1);
  await answer.fill("Manual README inspection plus the configured clean-git check is acceptable.");
  await page.evaluate(() => document.querySelector("#refresh").click());
  assert.equal(await page.locator("#decision-answer").inputValue(), "Manual README inspection plus the configured clean-git check is acceptable.");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/decision-session") && response.status() === 200),
    page.getByRole("button", { name: "Submit 1 answer" }).click(),
  ]);
  await page.getByRole("button", { name: /Open human review acceptance, Needs a signal/ }).click();
  await expectText(page, "#work-modal-content", /Approve the verified disposable change/);
  await page.locator("#decision-answer").fill("approve");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/decision-session") && response.status() === 200),
    page.getByRole("button", { name: "Submit 1 answer" }).click(),
  ]);
  await postJson(running.url, "/api/worker/tick", {});
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/overview") && response.status() === 200),
    page.locator("#refresh").click(),
  ]);
  await page.locator('[data-filter-key="all"]').click();
  await expectText(page, "#project-board", /Reached the station\s*1/);
  assert.equal(Object.values(new Store(fixture.stateDirectory).read().jobs)[0].state, "Shipped");
});

test("acceptance: project-first dashboard runs seven-question atomic sessions without polling away drafts", { timeout: 90_000 }, async (t) => {
  if (!fs.existsSync(chrome)) return t.skip("Google Chrome is not installed.");
  const fixture = tempProject({ approvalRequired: false, autonomous: true });
  fixture.configuration.projects[0].name = "Inclusion";
  fs.writeFileSync(fixture.configFile, JSON.stringify(fixture.configuration));
  const store = new Store(fixture.stateDirectory);
  let reevaluations = 0;
  const decision = { decide: async ({ projects }) => {
    reevaluations += 1;
    const project = projects[0];
    return {
      project: project.id, project_confidence: 0.99, execution_confidence: 0.99,
      sufficient_context: true, safe_to_execute: true, approval_required: false, decision: "execute",
      reason: "The complete decision session resolves the bounded fixture.", questions: [], dependencies: [],
      executor: project.executor.kind, runtime: project.runtime, shipping_policy: project.policy.shipping, should_decompose: false,
      work_items: [{ title: "Implement the resolved fixture", outcome: "All selected decisions are represented.",
        acceptance_criteria: [{ description: "Fixture verification passes.", verification_ids: [project.verification[0].id] }] }],
    };
  } };
  const engine = new Engine({ store, config: (await import("../src/workflow/config.js")).loadWorkflowConfig(fixture.configFile), decision });

  const ipad = store.submit({ text: "Old iPad display feasibility", source: "fixture", actor: "test", project_hint: "iPad Monitor" }, "ipad-dashboard");
  const drummer = store.submit({ text: "Create the Drummer You Aren't project", source: "fixture", actor: "test" }, "drummer-dashboard");
  const remote = store.submit({ text: "Build the private remote Roundhouse dashboard", source: "fixture", actor: "test", project_hint: "Roundhouse" }, "remote-dashboard");
  const inclusion = store.submit({ text: "Improve the Inclusion homepage", source: "fixture", actor: "test", project_id: "acceptance" }, "inclusion-dashboard");
  const compound = "1) Oldest iPad/iPadOS target. 2) Whether a jailbreak is acceptable only for the earliest transport proof, while the product target remains a normal signed iPad app. 3) First Linux desktop/compositor target. 4) Whether v1 includes touch or focuses only on reliable video. 5) Virtual monitor vs dedicated display surface default. 6) Automatic vs manual switching between monitor and face modes. 7) Licensing/permission before reusing code from unlicensed reference implementations.";
  store.change((data) => {
    data.project_candidates.ipad = { id: "ipad", name: "iPad Monitor", status: "candidate", executable: false, record_count: 1 };
    data.project_candidates.roundhouse = { id: "roundhouse", name: "Roundhouse", status: "candidate", executable: false, record_count: 1 };
    const open = (item, id, prompt, kind = "imported_decision") => ({ id, decision_id: null, decision_key: `fixture:${id}`, item_id: item.id,
      item_revision: item.revision, revision: 1, kind, prompt, status: "open", created_at: item.created_at, updated_at: item.updated_at });
    const ipadItem = data.items[ipad.id]; Object.assign(ipadItem, { state: "Needs Clarification", requires_reevaluation: false, execution_eligible: false,
      project_candidate_id: "ipad", priority: "P2", legacy_depot: { Item: "iPad Monitor — one-cable old iPad display", "Decisions Needed": compound },
      provenance: { source_system: "notion", source: "Roundhouse Depot prototype", source_id: "ipad-source", source_page_url: "https://www.notion.so/ipad" },
      questions: [open(ipadItem, "ipad-compound", compound)] });
    const drummerItem = data.items[drummer.id]; Object.assign(drummerItem, { state: "Needs Clarification", requires_reevaluation: false, execution_eligible: false,
      priority: "P2", legacy_depot: { Item: "Drummer You Aren’t — establish new project" },
      provenance: { source_system: "notion", source: "Roundhouse Depot prototype", source_id: "drummer-source" },
      questions: [open(drummerItem, "drummer-name", "Choose the durable project name.")] });
    const remoteItem = data.items[remote.id]; Object.assign(remoteItem, { state: "Needs Clarification", project_candidate_id: "roundhouse", priority: "P1",
      questions: [open(remoteItem, "remote-config", "Which private remote configuration should be used?", "clarification")] });
    const shipped = data.items[inclusion.id]; Object.assign(shipped, { state: "Ready", project_id: "acceptance", agent_role: "designer", job_ids: [`${inclusion.id}-1`], legacy_depot: { Item: "Designer homepage work" } });
    data.jobs[`${inclusion.id}-1`] = { id: `${inclusion.id}-1`, parent_id: inclusion.id, project_id: "acceptance", state: "Shipped", revision: 4,
      work: { title: "Designer homepage work", outcome: "A clearer responsive homepage shipped.", acceptance_criteria: [] }, agent_role: "designer",
      history: [{ from: "Verification", to: "Shipped", reason: "Verified preview delivered.", at: new Date().toISOString() }], attempts: [{ execution: { report: { summary: "Homepage hierarchy refined.", design_decisions: [], evidence: [] } } }],
      shipping: { commit: "abcdef1234567890", branch: "preview/homepage", pushed: false, timestamp: new Date().toISOString(),
        verification: { checks: [{ id: "designer-browser", passed: true, exit_code: 0, source: "automated", summary: "Desktop and mobile rendered." }] },
        deployment: { status: "succeeded", environment: "preview", url: "https://inclusion-preview.example" } } };
  });

  const service = new RoundhouseService({ store, engine });
  const running = await startRoundhouseServer({ service, allowedHosts: ["roundhouse-compatible"], port: 0, autoStartWorker: false });
  t.after(() => running.close());
  const browser = await chromium.launch({ executablePath: chrome, args: ["--host-resolver-rules=MAP roundhouse-compatible 127.0.0.1"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://roundhouse-compatible:${new URL(running.url).port}/`, { waitUntil: "networkidle" });

  assert.equal(await page.locator('[data-filter-key="needs"]').getAttribute("aria-pressed"), "true");
  await expectText(page, "#project-board", /iPad Monitor/);
  await expectText(page, "#project-board", /Unknown \/ Unassigned/);
  assert.equal((await page.locator("#project-board").innerText()).includes("Designer homepage work"), false);
  assert.equal((await page.locator("body").innerText()).includes("Oldest iPad/iPadOS target"), false);
  const rows = page.locator(".work-row"); assert.ok(await rows.count() >= 3);

  await page.getByRole("button", { name: /Open iPad Monitor — one-cable old iPad display, Needs a signal/ }).click();
  await expectText(page, ".progress-label", /Question 1 of 7/);
  const answer = page.locator("#decision-answer");
  const longDraft = "The oldest supported target should be iPadOS 15, balancing reused hardware with a maintainable signed application path.";
  await answer.fill(longDraft);
  await answer.evaluate((element) => { element.dataset.stabilityToken = "same-node"; element.setSelectionRange(28, 28); });
  await page.evaluate(async () => { await load(); await load(); });
  assert.equal(await answer.inputValue(), longDraft);
  assert.equal(await answer.evaluate((element) => `${element.dataset.stabilityToken}:${element.selectionStart}:${document.activeElement === element}`), "same-node:28:true");
  await answer.press("Enter");
  await answer.press("Shift+Enter");
  const editedDraft = `${longDraft.slice(0, 28)}\n\n${longDraft.slice(28)}`;
  assert.equal(await answer.inputValue(), editedDraft);
  assert.equal(reevaluations, 0);
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator("#decision-answer").fill("A jailbreak may be used only for a disposable transport proof; the product remains a normally signed app.");
  await page.getByRole("button", { name: "Back" }).click();
  assert.equal(await page.locator("#decision-answer").inputValue(), editedDraft);
  await page.getByRole("button", { name: "Next" }).click();
  assert.match(await page.locator("#decision-answer").inputValue(), /jailbreak/);
  await page.getByRole("button", { name: "Next" }).click();
  for (let index = 2; index < 7; index += 1) {
    await page.locator("#decision-answer").fill(`Focused answer ${index + 1} with enough durable detail for the selected product direction.`);
    assert.equal(reevaluations, 0);
    if (index < 6) await page.getByRole("button", { name: "Next" }).click();
  }
  const finalResponsePromise = page.waitForResponse((response) => response.url().includes("/decision-session"));
  await page.getByRole("button", { name: "Submit 7 answers" }).click();
  const finalResponse = await finalResponsePromise;
  assert.equal(finalResponse.status(), 200, await finalResponse.text());
  assert.equal(reevaluations, 1);
  const persistedIpad = store.read().items[ipad.id];
  assert.equal(persistedIpad.questions.filter((question) => question.status === "answered").length, 7);
  assert.equal(persistedIpad.decision_sessions[0].answers.length, 7);

  await page.getByRole("button", { name: /Open Build the private remote Roundhouse dashboard, Needs a signal/ }).click();
  await page.locator("#decision-answer").fill("Keep this draft through the conflict.");
  store.change((data) => {
    data.items[remote.id].revision += 1; data.items[remote.id].updated_at = new Date().toISOString();
    data.jobs[`${inclusion.id}-1`].history.push({ from: "Shipped", to: "Shipped", reason: "Background update is visible", at: new Date().toISOString() });
  });
  await page.evaluate(async () => { await load(); });
  await expectText(page, "#decision-message", /changed remotely/);
  assert.equal(await page.locator("#decision-answer").inputValue(), "Keep this draft through the conflict.");
  assert.equal(store.read().items[remote.id].clarifications.length, 0);
  page.once("dialog", (dialog) => dialog.dismiss()); await page.locator("#close-work").click(); assert.equal(await page.locator("#work-dialog").evaluate((dialog) => dialog.open), true);
  page.once("dialog", (dialog) => dialog.accept()); await page.locator("#close-work").click();
  await page.locator('[data-filter-key="all"]').click();
  await expectText(page, "#project-board", /Background update is visible/);

  await page.getByRole("button", { name: /Open Drummer You Aren’t — establish new project, Needs a signal/ }).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector("#decision-answer"));
  assert.equal(await page.locator("#decision-answer").evaluate((element) => document.activeElement === element), true);
  await page.locator("#decision-answer").fill("Pocket Orchestra");
  await page.getByRole("button", { name: "Submit 1 answer" }).click();
  assert.equal(reevaluations, 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Open Designer homepage work, Reached the station/ }).click();
  const bounds = await page.locator("#work-dialog").boundingBox();
  assert.deepEqual({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }, { x: 0, y: 0, width: 390, height: 844 });
  await page.getByRole("button", { name: "Evidence" }).click();
  await expectText(page, "#work-modal-content", /Desktop and mobile rendered/);
  assert.equal(await page.getByRole("link", { name: "Open preview" }).getAttribute("href"), "https://inclusion-preview.example");
});

async function expectText(page, selector, pattern) {
  await page.waitForFunction(({ selector, source, flags }) => {
    const element = document.querySelector(selector);
    return element && new RegExp(source, flags).test(element.textContent);
  }, { selector, source: pattern.source, flags: pattern.flags });
}
