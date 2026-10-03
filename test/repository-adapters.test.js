import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/workflow/store.js";
import { RepositoryAdapterRegistry, RepositoryProvisioner, repositoryIdentity } from "../src/workflow/repository-adapters.js";

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
