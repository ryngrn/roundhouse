import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/workflow/engine.js";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { git } from "../src/workflow/delivery.js";
import { GitHubRepositoryAdapter, ProjectBootstrapper, RepositoryProvisioner } from "../src/workflow/repository-adapters.js";
import { Store } from "../src/workflow/store.js";

const provider = fileURLToPath(new URL("./support/providers.mjs", import.meta.url));

function response(payload, status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "x-github-request-id" ? "fixture-request" : null },
    async text() { return JSON.stringify(payload); },
  };
}

function withGitIdentity(callback) {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "Roundhouse Acceptance",
    GIT_AUTHOR_EMAIL: "acceptance@roundhouse.invalid",
    GIT_COMMITTER_NAME: "Roundhouse Acceptance",
    GIT_COMMITTER_EMAIL: "acceptance@roundhouse.invalid",
  });
  return Promise.resolve().then(callback).finally(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("acceptance: an approved name becomes a verified pushed branch with complete durable evidence and no manual Git lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-zero-touch-"));
  const stateDirectory = path.join(root, "state");
  const workspace = path.join(root, "project");
  const providerSource = path.join(root, "github-provider-source");
  const remote = path.join(root, "github-remote.git");
  fs.mkdirSync(providerSource);
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);

  let creates = 0;
  const repositoryPayload = {
    id: 901,
    full_name: "fixture/approved-project",
    html_url: "https://github.com/fixture/approved-project",
    clone_url: `file://${remote}`,
    default_branch: "main",
    private: true,
  };
  const github = new GitHubRepositoryAdapter({
    env: { GITHUB_TOKEN: "fixture-process-token" },
    fetchImpl: async (_url, options) => {
      creates += 1;
      const request = JSON.parse(options.body);
      assert.deepEqual({ name: request.name, private: request.private, auto_init: request.auto_init },
        { name: "approved-project", private: true, auto_init: true });
      // This is the fixture-backed GitHub side effect of auto_init, not caller
      // Git work: the adapter must discover and clone the resulting base.
      git(providerSource, ["init", "--initial-branch=main"]);
      fs.writeFileSync(path.join(providerSource, "README.md"), "Approved project context\n");
      git(providerSource, ["add", "README.md"]);
      git(providerSource, ["-c", "user.name=GitHub Fixture", "-c", "user.email=fixture@github.invalid",
        "commit", "-m", "Initial commit"]);
      git(providerSource, ["remote", "add", "origin", `file://${remote}`]);
      git(providerSource, ["push", "origin", "main"]);
      return response(repositoryPayload);
    },
  });

  const provisioner = new RepositoryProvisioner({ store: new Store(stateDirectory), adapters: [github] });
  const created = await provisioner.create({
    adapter_id: "github",
    request: { name: "approved-project", description: "Approved acceptance fixture", workspace },
    idempotency_key: "approved-project:create",
    actor: "approver",
  });
  assert.equal(created.repository.lifecycle_state, "ready");
  assert.equal(git(workspace, ["rev-parse", "HEAD"]), git(remote, ["rev-parse", "refs/heads/main"]));

  // Reconstruct both the store and domain service before retry/bootstrap to
  // prove restart recovery and exactly one provider mutation.
  const restarted = new ProjectBootstrapper({ store: new Store(stateDirectory), adapters: [github] });
  const replay = await restarted.create({
    adapter_id: "github",
    request: { name: "approved-project", description: "Approved acceptance fixture", workspace },
    idempotency_key: "approved-project:create",
    actor: "retrying-worker",
  });
  assert.equal(replay.action.id, created.action.id);
  assert.equal(creates, 1);

  const rawProject = {
    id: "approved-project",
    name: "Approved Project",
    purpose: "Prove zero-touch repository delivery",
    success_state: "Verified work is available on a reviewable branch",
    status: "active",
    repository: workspace,
    remote: "origin",
    base_ref: "main",
    context_sources: ["README.md"],
    executor: { kind: "command", command: [process.execPath, provider, "execute"] },
    policy: { allow_autonomous: true, approval_required: false, shipping: "push_branch", continuation: "stop_after_job" },
    verification: [{ id: "feature", command: [process.execPath, "-e",
      "const fs=require('fs');const s=fs.readFileSync('feature.txt','utf8');if(!s.includes('implemented: deliver accepted work'))process.exit(1)"] }],
  };
  const config = validateWorkflowConfig({
    decision: { kind: "command", command: [process.execPath, provider, "decide"] },
    projects: [rawProject],
  }, path.join(root, "projects.json"));
  const bootstrapped = await restarted.bootstrapProject({
    repository_id: created.repository.id,
    project: rawProject,
    idempotency_key: "approved-project:bootstrap",
    actor: "approver",
    config_file: path.join(root, "projects.json"),
  });
  assert.equal(bootstrapped.project.execution_eligible, true);

  const executionStore = new Store(stateDirectory);
  const item = executionStore.submit({ text: "deliver accepted work", project_id: rawProject.id,
    source: "acceptance", actor: "approver" }, "approved-project:work");
  const result = await withGitIdentity(() => new Engine({ store: executionStore, config }).run());
  const job = Object.values(result.jobs).find((candidate) => candidate.parent_id === item.id);
  assert.equal(job.state, "Shipped");
  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].execution.passed, true);
  assert.equal(job.attempts[0].verification.passed, true);
  assert.equal(job.delivery_intents.length, 1);
  assert.equal(job.delivery_intent.commit, job.shipping.commit);
  assert.equal(job.shipping.repository_adapter, "local-git");
  assert.equal(job.shipping.pushed, true);
  assert.equal(git(remote, ["rev-parse", `refs/heads/${job.shipping.branch}`]), job.shipping.commit);
  assert.equal(git(remote, ["show", `${job.shipping.commit}:feature.txt`]).trim(), "implemented: deliver accepted work");

  const audit = new Store(stateDirectory).read();
  const createAction = audit.repository_actions[created.action.id];
  const bootstrapAction = audit.repository_actions[bootstrapped.action.id];
  assert.equal(createAction.actor, "approver");
  assert.ok(createAction.node_id);
  assert.ok(createAction.request_digest);
  assert.ok(createAction.evidence.some((entry) => entry.phase === "provider_result"));
  assert.equal(bootstrapAction.result.project_id, rawProject.id);
  assert.ok(bootstrapAction.evidence.some((entry) => entry.phase === "bootstrap_validation"));
  assert.equal(audit.workspace_mappings[bootstrapped.project.workspace_mapping_id].repository_id, created.repository.id);
  assert.equal(audit.items[item.id].completed_at, job.shipping.timestamp);
  assert.doesNotMatch(JSON.stringify(audit), /fixture-process-token/);
});
