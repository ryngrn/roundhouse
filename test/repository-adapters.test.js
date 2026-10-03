import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { saveWorkflowConfig } from "../src/workflow/config.js";
import { Store } from "../src/workflow/store.js";
import { GitDelivery } from "../src/workflow/delivery.js";
import { GitHubRepositoryAdapter, LocalGitRepositoryAdapter, ProjectBootstrapError, ProjectBootstrapper, RepositoryAdapter, RepositoryAdapterRegistry, RepositoryProvisioner, repositoryIdentity, sensitiveRepositoryActions } from "../src/workflow/repository-adapters.js";

function adapter(overrides = {}) {
  return {
    id: "fixture-repositories",
    async create(request) {
      return { identity: { provider_repository_id: `created:${request.name}`, display_name: request.name,
        github_owner: "must-not-cross-boundary", installation_id: 42 } };
    },
    async connect(request) {
      return { identity: { provider_repository_id: request.external_id, canonical_url: request.url } };
    },
    async inspect(identity) {
      return { identity, lifecycle_state: "ready", inspection: { ready: true, default_ref: "main", observed_revision: "abc123" } };
    },
    ...overrides,
  };
}

test("repository adapters: contract requires stable identity and create, connect, inspect operations", () => {
  const registry = new RepositoryAdapterRegistry([adapter()]);
  assert.equal(registry.require("fixture-repositories").id, "fixture-repositories");
  assert.throws(() => registry.register({ id: "incomplete", create() {}, connect() {} }), /inspect/);
  assert.throws(() => registry.register(adapter()), /Duplicate/);
  assert.deepEqual(repositoryIdentity({ adapter_id: "fixture-repositories", provider_repository_id: "opaque-17",
    display_name: "Example", owner: "octocat", github_node_id: "MDQ6" }), {
    adapter_id: "fixture-repositories", provider_repository_id: "opaque-17", display_name: "Example",
  });
});

test("repository authority: every sensitive action is blocked until exact current-revision approval", async () => {
  for (const kind of sensitiveRepositoryActions) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-sensitive-action-"));
    const calls = [];
    const provider = adapter({
      async performSensitiveAction(packet) { calls.push(packet); return { confirmed: true, action: packet.action }; },
    });
    const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [provider] });
    const created = await provisioner.create({ adapter_id: provider.id, request: { name: kind },
      idempotency_key: `create-${kind}` });
    const requested = await provisioner.requestSensitiveAction({ repository_id: created.repository.id, action: kind,
      parameters: { branch: "main", mode: "requested" }, idempotency_key: `sensitive-${kind}`, actor: "requester" });
    assert.equal(requested.action.status, "approval_required");
    assert.equal(calls.length, 0);
    await assert.rejects(provisioner.executeSensitiveAction({ action_id: requested.action.id, revision: 1 }),
      /requires exact current-revision approval/);
    await assert.rejects(provisioner.approveSensitiveAction({ action_id: requested.action.id, revision: 2, actor: "maintainer" }),
      /current sensitive repository action revision/);
    const approved = await provisioner.approveSensitiveAction({ action_id: requested.action.id, revision: 1, actor: "maintainer" });
    assert.equal(approved.action.approval.action, kind);
    assert.deepEqual(approved.action.approval.target, requested.action.target);
    assert.deepEqual(approved.action.approval.parameters, requested.action.parameters);
    assert.equal(approved.action.approval.request_digest, requested.action.request_digest);
    const completed = await provisioner.executeSensitiveAction({ action_id: requested.action.id, revision: 1 });
    assert.equal(completed.action.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization.actor, "maintainer");
  }
});

test("repository authority: stale or generalized approval cannot authorize changed work", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-sensitive-stale-"));
  let calls = 0;
  const provider = adapter({ async performSensitiveAction() { calls += 1; return { confirmed: true }; } });
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [provider] });
  const created = await provisioner.create({ adapter_id: provider.id, request: { name: "stale" }, idempotency_key: "create-stale" });
  const requested = await provisioner.requestSensitiveAction({ repository_id: created.repository.id, action: "force_push",
    parameters: { branch: "release", commit: "abc123" }, idempotency_key: "force-release" });
  await provisioner.approveSensitiveAction({ action_id: requested.action.id, revision: 1, actor: "maintainer" });
  provisioner.store.change((data) => { data.repository_actions[requested.action.id].parameters.commit = "changed"; });
  await assert.rejects(provisioner.executeSensitiveAction({ action_id: requested.action.id, revision: 1 }), /exact current-revision approval/);
  assert.equal(calls, 0);

  const fresh = await provisioner.requestSensitiveAction({ repository_id: created.repository.id, action: "change_visibility",
    parameters: { visibility: "public" }, idempotency_key: "make-public" });
  await provisioner.approveSensitiveAction({ action_id: fresh.action.id, revision: 1, actor: "maintainer" });
  provisioner.store.change((data) => { data.repositories[created.repository.id].revision += 1; });
  await assert.rejects(provisioner.executeSensitiveAction({ action_id: fresh.action.id, revision: 1 }), /stale.*repository revision/);
  assert.equal(calls, 0);
});

test("repository authority: adapters cannot expose direct sensitive-operation bypasses", () => {
  assert.throws(() => new RepositoryAdapterRegistry([adapter({ deleteRepository() {} })]), /outside the domain authorization boundary/);
  assert.throws(() => new RepositoryAdapterRegistry([adapter({ forcePush() {} })]), /outside the domain authorization boundary/);
});

test("repository authority: routine creation remains private", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-private-only-"));
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter()] });
  await assert.rejects(provisioner.create({ adapter_id: "fixture-repositories", request: { name: "public", visibility: "public" },
    idempotency_key: "public-create" }), /private-only/);
  assert.throws(() => new RepositoryAdapterRegistry([adapter({ change_visibility() {} })]), /outside the domain authorization boundary/);
  assert.equal(Object.keys(provisioner.store.read().repository_actions).length, 0);
});

test("repository authority: credential rotation persists references but rejects credential material", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-credential-boundary-"));
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter()] });
  const created = await provisioner.create({ adapter_id: "fixture-repositories", request: { name: "credentials" },
    idempotency_key: "create-credentials" });
  const requested = await provisioner.requestSensitiveAction({ repository_id: created.repository.id, action: "change_credentials",
    parameters: { credential_id: "deploy-key-1", operation: "rotate" }, idempotency_key: "rotate-key" });
  assert.equal(requested.action.parameters.credential_id, "deploy-key-1");
  await assert.rejects(provisioner.requestSensitiveAction({ repository_id: created.repository.id, action: "change_credentials",
    parameters: { token: "must-not-persist" }, idempotency_key: "unsafe-rotate" }), /credential material/);
  assert.doesNotMatch(JSON.stringify(provisioner.store.read()), /must-not-persist/);
});

test("repository delivery: coordinator routes routine work through an adapter and alone authorizes push", async () => {
  const calls = [];
  const adapter = {
    id: "fixture-delivery", create() {}, connect() {}, inspect() {},
    canDispatch: () => true,
    supportsDelivery: () => true,
    lock() { calls.push(["lock"]); return () => calls.push(["unlock"]); },
    prepare(args) {
      calls.push(["prepare", args.push]);
      return { adapter_id: this.id, workspace: "/workspace", branch: "codex/job", base: "base", remote: "remote",
        remote_name: "origin", repository: "/repo", mapping: {} };
    },
    snapshot() { calls.push(["snapshot"]); return { commit: "verified", changed_files: ["feature.txt"] }; },
    unchanged(_prepared, commit) { calls.push(["unchanged", commit]); return commit === "verified"; },
    async push({ commit }) { calls.push(["push", commit]); return { pushed: true, remote: "remote" }; },
  };
  const delivery = new GitDelivery({ adapters: [adapter] });
  const project = { repository: "/repo", repository_adapter: adapter.id, remote: "origin", timeout_ms: 1000,
    policy: { shipping: "push_branch" } };
  const job = { id: "job", work: { title: "change" } };
  const release = delivery.lock(project);
  release();
  const prepared = delivery.prepare({ project, job, directory: "/state/workspaces" });
  const snapshot = delivery.snapshot({ project, job, prepared });
  assert.equal(delivery.unchanged(prepared, snapshot.commit, project), true);
  await assert.rejects(delivery.ship({ project, prepared,
    verification: { commit: snapshot.commit, passed: false, checks: [{ passed: false }] } }), /passing verification/);
  assert.equal(calls.some(([name]) => name === "push"), false);
  const shipped = await delivery.ship({ project, prepared,
    verification: { commit: snapshot.commit, passed: true, checks: [{ passed: true }] } });
  assert.equal(shipped.repository_adapter, adapter.id);
  assert.equal(shipped.commit, "verified");
  assert.deepEqual(calls, [["lock"], ["unlock"], ["prepare", true], ["snapshot"], ["unchanged", "verified"],
    ["unchanged", "verified"], ["push", "verified"]]);
});

test("repository delivery: local Git implementation is a RepositoryAdapter and is required for delivery operations", () => {
  const local = new LocalGitRepositoryAdapter();
  assert.ok(local instanceof RepositoryAdapter);
  assert.equal(new RepositoryAdapterRegistry([local]).requireDelivery("local-git"), local);
  assert.throws(() => new RepositoryAdapterRegistry([adapter()]).requireDelivery("fixture-repositories"), /delivery operation/);
});

test("repository provisioning: identities, lifecycle, actions, and workspace mappings survive restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-repository-provisioning-"));
  const first = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter()] });
  const created = await first.create({ adapter_id: "fixture-repositories", request: { name: "provider-neutral" },
    idempotency_key: "create-provider-neutral", actor: "operator" });
  assert.equal(created.action.status, "succeeded");
  assert.equal(created.repository.lifecycle_state, "connected");
  assert.deepEqual(created.repository.identity, {
    adapter_id: "fixture-repositories", provider_repository_id: "created:provider-neutral", display_name: "provider-neutral",
  });
  assert.equal(created.action.actor, "operator");
  assert.ok(created.action.request_digest);
  assert.equal(created.action.evidence[0].phase, "provider_result");

  const second = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter()] });
  const inspected = await second.inspect({ repository_id: created.repository.id, idempotency_key: "inspect-provider-neutral" });
  assert.equal(inspected.repository.lifecycle_state, "ready");
  assert.equal(inspected.repository.inspection.observed_revision, "abc123");
  assert.ok(inspected.repository.last_inspected_at);
  const mapped = await second.mapWorkspace({ repository_id: created.repository.id, project_id: "roundhouse",
    workspace: path.join(directory, "workspaces", "one"), idempotency_key: "map-provider-neutral" });
  assert.ok(mapped.action.result.workspace_mapping_id);

  const restarted = new Store(directory).read();
  assert.equal(Object.keys(restarted.repositories).length, 1);
  assert.equal(Object.keys(restarted.repository_actions).length, 3);
  assert.equal(restarted.workspace_mappings[mapped.action.result.workspace_mapping_id].project_id, "roundhouse");
  assert.equal(restarted.workspace_mappings[mapped.action.result.workspace_mapping_id].status, "active");

  const replay = await second.create({ adapter_id: "fixture-repositories", request: { name: "provider-neutral" },
    idempotency_key: "create-provider-neutral", actor: "ignored-on-replay" });
  assert.equal(replay.action.id, created.action.id);
  assert.equal(Object.keys(new Store(directory).read().repository_actions).length, 3);
  await assert.rejects(second.create({ adapter_id: "fixture-repositories", request: { name: "different" },
    idempotency_key: "create-provider-neutral" }), /different input/);
});

test("repository provisioning: connect resolves an existing provider identity without granting delivery authority", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-repository-connect-"));
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter()] });
  const connected = await provisioner.connect({ adapter_id: "fixture-repositories",
    request: { external_id: "existing-42", url: "https://repositories.example/existing-42" },
    idempotency_key: "connect-existing-42" });
  assert.deepEqual(connected.repository.identity, { adapter_id: "fixture-repositories",
    provider_repository_id: "existing-42", canonical_url: "https://repositories.example/existing-42" });
  assert.equal(connected.repository.lifecycle_state, "connected");
  assert.equal(connected.action.kind, "connect");
  assert.equal("shipping" in connected.repository, false);
  assert.equal("push" in connected.action, false);
});

test("repository provisioning: uncertain mutations are durable and cannot be replayed automatically", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-repository-uncertain-"));
  let calls = 0;
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter({
    async create() { calls += 1; throw new Error("provider timeout after request"); },
  })] });
  await assert.rejects(provisioner.create({ adapter_id: "fixture-repositories", request: { name: "uncertain" },
    idempotency_key: "create-uncertain", actor: "operator" }), /provider timeout/);
  const action = Object.values(new Store(directory).read().repository_actions)[0];
  assert.equal(action.status, "reconciliation_required");
  assert.equal(action.request.name, "uncertain");
  assert.equal(action.node_id, provisioner.store.node.id);
  assert.equal(action.error.message, "provider timeout after request");
  assert.ok(action.started_at);
  assert.ok(action.finished_at);
  await assert.rejects(provisioner.create({ adapter_id: "fixture-repositories", request: { name: "uncertain" },
    idempotency_key: "create-uncertain" }), /requires reconciliation/);
  assert.equal(calls, 1);
});

test("project lifecycle: speculative previews stay repository-free until managed or purchased promotion", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-lifecycle-preview-"));
  let creates = 0;
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter({
    async create(request) { creates += 1; return { identity: { provider_repository_id: `customer:${request.name}` } }; },
  })] });
  const project = { id: "inclusion-customer", lifecycle: { stage: "speculative", repository_provisioning: {
    adapter_id: "fixture-repositories", provision_on: ["managed", "purchased"], request: { name: "customer-one" },
  } } };

  const preview = await provisioner.transitionProjectLifecycle({ project, from: "speculative", to: "speculative", actor: "sales" });
  assert.equal(preview.action, null);
  assert.equal(creates, 0);
  const speculative = new Store(directory).read();
  assert.equal(speculative.projects[project.id].customer_lifecycle.stage, "speculative");
  assert.equal(speculative.projects[project.id].customer_lifecycle.repository_status, "not_requested");
  assert.equal(Object.keys(speculative.repositories).length, 0);

  const promoted = await provisioner.transitionProjectLifecycle({ project, from: "speculative", to: "managed", actor: "operator" });
  assert.equal(promoted.project.customer_lifecycle.stage, "managed");
  assert.equal(promoted.project.customer_lifecycle.repository_status, "provisioned");
  assert.equal(promoted.action.project_id, project.id);
  assert.deepEqual(promoted.action.lifecycle_transition, { from: "speculative", to: "managed" });

  const purchased = await new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter({
    async create() { creates += 1; throw new Error("must not create twice"); },
  })] }).transitionProjectLifecycle({ project, from: "managed", to: "purchased", actor: "operator" });
  assert.equal(purchased.project.customer_lifecycle.stage, "purchased");
  assert.equal(purchased.repository.id, promoted.repository.id);
  assert.equal(creates, 1);
  assert.equal(Object.values(new Store(directory).read().repository_actions).filter((action) => action.kind === "create").length, 1);
});

test("project lifecycle: uncertain promotion survives restart and never repeats repository creation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-lifecycle-uncertain-"));
  let creates = 0;
  const project = { id: "inclusion-preview", lifecycle: { stage: "speculative", repository_provisioning: {
    adapter_id: "fixture-repositories", provision_on: ["managed", "purchased"], request: { name: "uncertain-customer" },
  } } };
  const failing = adapter({ async create() { creates += 1; throw new Error("provider result unknown"); } });
  await assert.rejects(new RepositoryProvisioner({ store: new Store(directory), adapters: [failing] })
    .transitionProjectLifecycle({ project, from: "speculative", to: "purchased" }), /result unknown/);
  let snapshot = new Store(directory).read();
  assert.equal(snapshot.projects[project.id].customer_lifecycle.stage, "purchased");
  assert.equal(snapshot.projects[project.id].customer_lifecycle.repository_status, "reconciliation_required");
  assert.equal(Object.values(snapshot.repository_actions)[0].status, "reconciliation_required");

  await assert.rejects(new RepositoryProvisioner({ store: new Store(directory), adapters: [failing] })
    .transitionProjectLifecycle({ project, from: "speculative", to: "purchased" }), /requires reconciliation/);
  snapshot = new Store(directory).read();
  assert.equal(creates, 1);
  assert.equal(Object.keys(snapshot.repositories).length, 0);
  assert.equal(Object.keys(snapshot.repository_actions).length, 1);
});

function command(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function response(payload, { status = 200, requestId = "request-1" } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name === "x-github-request-id" ? requestId : null },
    async text() { return JSON.stringify(payload); } };
}

test("github repository adapter: creates private repositories and initializes an idempotently inspectable workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-github-create-"));
  const remote = path.join(directory, "remote.git");
  fs.mkdirSync(remote);
  command(remote, ["init", "--bare", "--initial-branch=main"]);
  const workspace = path.join(directory, "workspace");
  const requests = [];
  const repository = { id: 1729, full_name: "roundhouse/example", html_url: "https://github.com/roundhouse/example",
    clone_url: `file://${remote}`, default_branch: "main", private: true };
  const adapter = new GitHubRepositoryAdapter({ env: { GITHUB_TOKEN: "environment-only" },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return response(repository, { status: 201 }); } });
  const provisioner = new RepositoryProvisioner({ store: new Store(path.join(directory, "state")), adapters: [adapter] });
  const created = await provisioner.create({ adapter_id: "github", request: { name: "example", workspace, description: "Private project" },
    idempotency_key: "github-create-example" });

  assert.equal(JSON.parse(requests[0].options.body).private, true);
  assert.match(requests[0].options.headers.Authorization, /^Bearer /);
  assert.equal(created.repository.identity.provider_repository_id, "1729");
  assert.equal(created.repository.lifecycle_state, "ready");
  assert.equal(created.repository.inspection.workspace, workspace);
  assert.equal(command(workspace, ["remote", "get-url", "origin"]), `file://${remote}`);
  assert.equal(command(workspace, ["branch", "--show-current"]), "main");
  assert.doesNotMatch(JSON.stringify(new Store(path.join(directory, "state")).read()), /environment-only/);

  requests.length = 0;
  const inspected = await provisioner.inspect({ repository_id: created.repository.id, idempotency_key: "github-inspect-example" });
  assert.equal(requests[0].url, "https://api.github.com/repositories/1729");
  assert.equal(inspected.repository.lifecycle_state, "ready");
  assert.equal(inspected.repository.inspection.remote, `file://${remote}`);
});

test("github repository adapter: connects an existing repository and checks out its initial branch", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-github-connect-"));
  const source = path.join(directory, "source");
  const remote = path.join(directory, "remote.git");
  fs.mkdirSync(source);
  fs.mkdirSync(remote);
  command(source, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(source, "README.md"), "existing\n");
  command(source, ["add", "README.md"]);
  command(source, ["-c", "user.name=Roundhouse Test", "-c", "user.email=test@roundhouse.invalid", "commit", "-m", "Initial"]);
  command(remote, ["init", "--bare", "--initial-branch=main"]);
  command(source, ["remote", "add", "origin", `file://${remote}`]);
  command(source, ["push", "origin", "main"]);
  const repository = { id: 42, full_name: "owner/existing", html_url: "https://github.com/owner/existing",
    clone_url: `file://${remote}`, default_branch: "main" };
  const adapter = new GitHubRepositoryAdapter({ env: { GH_TOKEN: "environment-only" },
    fetchImpl: async (url) => { assert.equal(url, "https://api.github.com/repos/owner/existing"); return response(repository); } });
  const connected = await adapter.connect({ repository: "https://github.com/owner/existing.git", workspace: path.join(directory, "workspace") });
  assert.equal(connected.lifecycle_state, "ready");
  assert.equal(command(connected.inspection.workspace, ["rev-parse", "HEAD"]), command(source, ["rev-parse", "HEAD"]));
  assert.equal(command(connected.inspection.workspace, ["branch", "--show-current"]), "main");
});

test("github repository adapter: rejects request credentials and records bounded uncertainty evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-github-failure-"));
  const adapter = new GitHubRepositoryAdapter({ env: { GITHUB_TOKEN: "environment-only" }, fetchImpl: async () => {
    throw new Error("network failure " + "x".repeat(10_000));
  } });
  const provisioner = new RepositoryProvisioner({ store: new Store(directory), adapters: [adapter] });
  await assert.rejects(provisioner.create({ adapter_id: "github", request: { name: "example", workspace: path.join(directory, "workspace") },
    idempotency_key: "github-uncertain" }), /did not return/);
  const action = Object.values(new Store(directory).read().repository_actions)[0];
  assert.equal(action.status, "reconciliation_required");
  assert.equal(action.error.evidence.external_repository_state, "unknown");
  assert.ok(JSON.stringify(action.error).length < 2_000);
  assert.doesNotMatch(JSON.stringify(action), /environment-only/);
  await assert.rejects(provisioner.create({ adapter_id: "github",
    request: { name: "example", workspace: path.join(directory, "other"), github_token: "forbidden" },
    idempotency_key: "must-not-persist" }), /must not contain credentials/);
  assert.equal(Object.values(new Store(directory).read().repository_actions).length, 1);
});

function bootstrapFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-project-bootstrap-"));
  const workspace = path.join(directory, "workspace");
  const remote = path.join(directory, "remote.git");
  fs.mkdirSync(workspace);
  fs.mkdirSync(remote);
  command(workspace, ["init", "--initial-branch=main"]);
  command(remote, ["init", "--bare", "--initial-branch=main"]);
  fs.writeFileSync(path.join(workspace, "README.md"), "Bootstrap context\n");
  command(workspace, ["add", "README.md"]);
  command(workspace, ["-c", "user.name=Roundhouse Test", "-c", "user.email=test@roundhouse.invalid", "commit", "-m", "Initial"]);
  command(workspace, ["remote", "add", "origin", remote]);
  const store = new Store(path.join(directory, "state"));
  const repositoryId = "repository-1";
  store.change((data) => {
    data.repositories[repositoryId] = { id: repositoryId, identity: { adapter_id: "fixture-repositories", provider_repository_id: "fixture-1" },
      lifecycle_state: "ready", revision: 1, inspection: { ready: true, workspace, remote, default_ref: "main" },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  });
  const project = { id: "bootstrap-example", name: "Bootstrap Example", purpose: "Exercise durable bootstrap",
    success_state: "Validated project can execute", status: "active", repository: workspace, remote: "origin", base_ref: "main",
    context_sources: ["README.md"], runtime: "local", executor: { kind: "command", command: [process.execPath, "executor.mjs"] },
    policy: { allow_autonomous: true, shipping: "push_branch" },
    verification: [{ id: "tests", command: [process.execPath, "--test"] }] };
  return { directory, workspace, remote, store, repositoryId, project };
}

test("project bootstrap validates Git and execution policy before durably mapping an eligible project", async () => {
  const fixture = bootstrapFixture();
  const bootstrapper = new ProjectBootstrapper({ store: fixture.store, adapters: [] });
  const result = await bootstrapper.bootstrap({ repository_id: fixture.repositoryId, project: fixture.project,
    idempotency_key: "bootstrap-example", actor: "operator" });
  assert.equal(result.project.execution_eligible, true);
  assert.equal(result.project.repository_id, fixture.repositoryId);
  assert.equal(result.project.configuration.runtime, "local");
  assert.equal(result.project.configuration.policy.shipping, "push_branch");
  assert.deepEqual(result.project.bootstrap_evidence.verification_ids, ["tests"]);
  assert.deepEqual(result.project.bootstrap_evidence.context_sources, ["README.md"]);
  assert.equal(result.action.kind, "bootstrap_project");
  assert.ok(result.project.bootstrap_evidence.base_commit);
  assert.ok(result.project.bootstrap_evidence.remote_url_digest);

  const restarted = new Store(path.join(fixture.directory, "state")).read();
  assert.equal(restarted.projects[fixture.project.id].execution_eligible, true);
  assert.equal(restarted.workspace_mappings[result.project.workspace_mapping_id].purpose, "project");
  const replay = await bootstrapper.bootstrapProject({ repository_id: fixture.repositoryId, project: fixture.project,
    idempotency_key: "bootstrap-example", actor: "ignored" });
  assert.equal(replay.action.id, result.action.id);
  assert.equal(Object.values(fixture.store.read().repository_actions).filter((action) => action.kind === "bootstrap_project").length, 1);
});

test("project bootstrap rejects conflicting mappings with actionable evidence", async () => {
  const fixture = bootstrapFixture();
  const bootstrapper = new ProjectBootstrapper({ store: fixture.store, adapters: [] });
  await bootstrapper.bootstrap({ repository_id: fixture.repositoryId, project: fixture.project, idempotency_key: "bootstrap-first" });
  const conflict = { ...fixture.project, id: "other-project", name: "Other Project" };
  await assert.rejects(bootstrapper.bootstrap({ repository_id: fixture.repositoryId, project: conflict,
    idempotency_key: "bootstrap-other" }), (error) => {
    assert.ok(error instanceof ProjectBootstrapError);
    assert.equal(error.evidence.conflicting_project_id, fixture.project.id);
    assert.equal(error.evidence.phase, "mapping");
    return true;
  });
  await assert.rejects(bootstrapper.bootstrap({ repository_id: fixture.repositoryId, project: { ...fixture.project, base_ref: "missing" },
    idempotency_key: "bootstrap-invalid-base" }), /Git validation failed/);
});

test("project bootstrap and project configuration reject credentials before persistence", async () => {
  const fixture = bootstrapFixture();
  const bootstrapper = new ProjectBootstrapper({ store: fixture.store, adapters: [] });
  await assert.rejects(bootstrapper.bootstrap({ repository_id: fixture.repositoryId,
    project: { ...fixture.project, provider: { api_key: "must-never-persist" } }, idempotency_key: "bootstrap-secret" }),
  /must not contain credentials/);
  const serialized = JSON.stringify(fixture.store.read());
  assert.doesNotMatch(serialized, /must-never-persist|bootstrap-secret/);
  const configFile = path.join(fixture.directory, "private-projects.yaml");
  assert.throws(() => saveWorkflowConfig(configFile, { projects: [{ ...fixture.project,
    executor: { kind: "command", command: [process.execPath, "executor.mjs", "--api-key=must-never-persist"] } }] }),
  /credential arguments/);
  assert.equal(fs.existsSync(configFile), false);
});
