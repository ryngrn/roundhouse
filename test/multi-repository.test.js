import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { resolveRepositoryContext } from "../src/workflow/repositories.js";
import { routeDecision } from "../src/workflow/decision.js";
import { executionReservation } from "../src/workflow/scheduler.js";
import { dashboardProjection } from "../src/workflow/views.js";
import { Store } from "../src/workflow/store.js";
import { Engine } from "../src/workflow/engine.js";
import { git } from "../src/workflow/delivery.js";

function fixture(t, repositories, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-repositories-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const repository of repositories) fs.mkdirSync(path.join(root, repository));
  const verification = [{ id: "tests", command: [process.execPath, "-e", "process.exit(0)"] }];
  const raw = { projects: [{ id: "example", name: "Example", purpose: "Test", success_state: "Done", status: "active",
    executor: { kind: "command", command: [process.execPath, "-e", "process.exit(0)"] },
    policy: { allow_autonomous: true, shipping: repositories.length ? "commit_only" : "durable_output" },
    verification: repositories.length ? verification : [],
    ...(repositories.length ? { repositories: repositories.map((name) => ({ id: name, checkout_path: name })) }
      : { repositories: [], repository_required: false }), ...extra }] };
  return { root, raw, config: validateWorkflowConfig(raw, path.join(root, "projects.yaml")) };
}

function decision(repositoryId, repositoryRequired = true) {
  return { project: "example", project_confidence: 0.99, execution_confidence: 0.99, sufficient_context: true,
    safe_to_execute: true, approval_required: false, decision: "execute", reason: "Scoped fixture.", questions: [],
    question: null, decision_key: null, dependencies: [], executor: "command", runtime: "local",
    shipping_policy: repositoryRequired ? "commit_only" : "durable_output", should_decompose: false,
    reconcile_with: null, blocked_on: [], work_items: [{ title: "Change", outcome: "Make the scoped change.",
      repository_required: repositoryRequired, repository_id: repositoryId, required_capabilities: [],
      acceptance_criteria: [{ description: "Tests pass.", verification_ids: repositoryRequired ? ["tests"] : [] }] }] };
}

test("legacy repository configuration normalizes to one stable default repository", (t) => {
  const { root, raw } = fixture(t, ["legacy"]);
  delete raw.projects[0].repositories;
  raw.projects[0].repository = "legacy";
  const project = validateWorkflowConfig(raw, path.join(root, "projects.yaml")).projects[0];
  assert.equal(project.repositories.length, 1);
  assert.equal(project.repositories[0].id, "default");
  assert.equal(project.repository, project.repositories[0].checkout_path);
  assert.equal(resolveRepositoryContext(project, { repository_required: true }).repository_id, "default");
});

test("an unconfigured repository-free project defaults to durable-output delivery", (t) => {
  const { root } = fixture(t, []);
  const config = validateWorkflowConfig({
    projects: [{ id: "research", name: "Research", purpose: "Explore concepts",
      success_state: "Reviewed summary", status: "active", repositories: [] }],
  }, path.join(root, "projects.yaml"));
  assert.equal(config.projects[0].repositories.length, 0);
  assert.equal(config.projects[0].repository_required, false);
  assert.equal(config.projects[0].policy.shipping, "durable_output");
});

test("zero, one, and many repositories resolve without implicit multi-repo selection", (t) => {
  const none = fixture(t, []).config.projects[0];
  assert.deepEqual(none.repositories, []);
  assert.equal(resolveRepositoryContext(none, { repository_required: false }).ok, true);
  assert.equal(resolveRepositoryContext(none, { repository_required: true }).code, "repository_setup_required");

  const one = fixture(t, ["core"]).config.projects[0];
  assert.equal(resolveRepositoryContext(one, { repository_required: true }).repository_id, "core");

  const many = fixture(t, ["api", "web"]).config.projects[0];
  assert.equal(resolveRepositoryContext(many, { repository_required: true }).code, "repository_ambiguous");
  assert.equal(resolveRepositoryContext(many, { repository_required: true, repository_id: "missing" }).code, "unknown_repository");
  assert.equal(resolveRepositoryContext(many, { repository_required: true, repository_id: "web" }).repository_id, "web");
  assert.equal(resolveRepositoryContext(many, { repository_required: false, repository_id: "web" }).required, true,
    "an explicitly targeted checkout must always participate in repository locking");
});

test("ambiguous and unknown development targets require clarification and cannot reserve a repository", (t) => {
  const project = fixture(t, ["api", "web"]).config.projects[0];
  const ambiguous = decision(null);
  const unknown = decision("other");
  assert.match(routeDecision(ambiguous, [project]).reason, /must select one repository_id/);
  assert.equal(routeDecision(ambiguous, [project]).state, "Needs Clarification");
  assert.equal(routeDecision(unknown, [project]).state, "Needs Clarification");
  const reservation = executionReservation(project, { work: ambiguous.work_items[0] });
  assert.equal(reservation.repository.configured, false);
  assert.deepEqual(reservation.locks, []);
});

test("job creation binds repository-specific context, policy hash, locks, and public projection", async (t) => {
  const { root, config } = fixture(t, ["api", "web"]);
  const store = new Store(path.join(root, "state"));
  const item = store.submit({ text: "Change only the web repository", project_id: "example", source: "test", actor: "test" }, "multi-repo-job");
  const engine = new Engine({ store, config, decision: { decide: async () => decision("web") } });
  await engine.decide(item.id);
  const state = store.read();
  const job = state.jobs[`${item.id}-1`];
  assert.equal(job.repository_id, "web");
  assert.equal(job.work.repository_id, "web");
  assert.equal(job.project_context.repository_id, "web");
  assert.equal(job.project_context.repository, config.projects[0].repositories.find((entry) => entry.id === "web").checkout_path);
  assert.ok(job.policy_hash);
  assert.deepEqual(executionReservation(config.projects[0], job).locks,
    [`repository:${job.project_context.repository}`]);
  const projected = dashboardProjection(state, config).overview;
  assert.deepEqual(projected.projects.example.repositories.map((entry) => entry.id), ["api", "web"]);
  assert.equal(projected.items.find((entry) => entry.id === job.id).repository_id, "web");
  assert.equal(JSON.stringify(projected).includes("command"), false);
  assert.equal(JSON.stringify(projected.projects.example.repositories).includes(job.project_context.repository), false,
    "UI projection must not expose local repository checkout paths");
});

test("engine creates no jobs for an ambiguous multi-repository decision", async (t) => {
  const { root, config } = fixture(t, ["api", "web"]);
  const store = new Store(path.join(root, "state"));
  const item = store.submit({ text: "Change the code", project_id: "example", source: "test", actor: "test" }, "ambiguous-target");
  const engine = new Engine({ store, config, decision: { decide: async () => decision(null) } });
  await engine.decide(item.id);
  const state = store.read();
  assert.equal(state.items[item.id].state, "Needs Clarification");
  assert.deepEqual(state.items[item.id].job_ids, []);
  assert.match(state.items[item.id].questions[0].prompt, /repository_id/);
});

test("e2e: a selected repository is the only checkout prepared, changed, verified, and shipped", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-multi-repo-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["api", "web"]) {
    const repository = path.join(root, name);
    fs.mkdirSync(repository);
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Roundhouse Test"]);
    git(repository, ["config", "user.email", "test@roundhouse.invalid"]);
    fs.writeFileSync(path.join(repository, "README.md"), `${name}\n`);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initial"]);
  }
  const check = [process.execPath, "-e", "if(!require('fs').existsSync('selected.txt'))process.exit(1)"];
  const raw = { max_jobs_per_run: 1, projects: [{ id: "example", name: "Example", purpose: "Test", success_state: "Done", status: "active",
    executor: { kind: "command", command: [process.execPath, "-e", "process.exit(0)"] },
    policy: { allow_autonomous: true, shipping: "commit_only", max_rework_attempts: 0 },
    repositories: [
      { id: "api", checkout_path: "api", verification: [{ id: "tests", command: check }] },
      { id: "web", checkout_path: "web", verification: [{ id: "tests", command: check }] },
    ] }] };
  const config = validateWorkflowConfig(raw, path.join(root, "projects.yaml"));
  const store = new Store(path.join(root, "state"));
  const item = store.submit({ text: "Change web", project_id: "example", source: "test", actor: "test" }, "selected-web");
  const runtime = { execute: async ({ workspace }) => {
    fs.writeFileSync(path.join(workspace, "selected.txt"), "web only\n");
    return { passed: true, exit_code: 0, stdout: "done", stderr: "" };
  } };
  const engine = new Engine({ store, config, decision: { decide: async () => decision("web") }, runtime });
  const result = await engine.run();
  const job = result.jobs[`${item.id}-1`];
  assert.equal(job.state, "Shipped");
  assert.equal(job.repository_id, "web");
  assert.equal(job.shipping.repository_id, "web");
  assert.equal(job.shipping.repository, fs.realpathSync(path.join(root, "web")));
  assert.deepEqual(job.shipping.verification.checks.map((entry) => entry.id), ["tests"]);
  assert.equal(git(path.join(root, "api"), ["status", "--porcelain"]), "");
  assert.equal(git(path.join(root, "api"), ["log", "-1", "--pretty=%s"]), "Initial");
});
