import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateWorkflowConfig } from "../src/workflow/config.js";
import { resolveProjectIdentity } from "../src/workflow/project-model.js";
import { dashboardProjection } from "../src/workflow/views.js";
import { Store } from "../src/workflow/store.js";
import { connectRoundhouseRepositories } from "../scripts/prepare-roundhouse-repositories.mjs";

const core = { id: "core", github_url: "https://github.com/ryngrn/roundhouse" };
const dashboard = { id: "dashboard", github_url: "https://github.com/ryngrn/roundhouse.ryan.green" };
const definition = { id: "roundhouse", name: "Roundhouse", purpose: "One product", success_state: "Reviewable", status: "active" };
const snapshot = () => ({ schema_version: 1, projects: {}, items: {}, jobs: {}, outbox: [], system_metadata: {} });
const config = (repositories, extra = {}) => validateWorkflowConfig({ projects: [{ ...definition, repositories, ...extra }] }, path.resolve("config/test.yaml"));

for (const repositories of [[], [core], [core, dashboard]]) {
  test(`${repositories.length} connected repositories round-trip through configuration, storage, and projection`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-connections-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configuration = config(repositories);
    const store = new Store(directory);
    store.change((data) => resolveProjectIdentity(data, configuration.projects, "Roundhouse"));
    const data = new Store(directory).read();
    assert.deepEqual(data.projects.roundhouse.repositories.map(({ id, github_url }) => ({ id, github_url })), repositories);
    const project = dashboardProjection(data, configuration).overview.projects.roundhouse;
    assert.equal(project.id, "roundhouse");
    assert.deepEqual(project.repositories.map(({ id, github_url }) => ({ id, github_url })), repositories);
    assert.equal(project.repository, null);
  });
}

test("legacy singular local repository retains its stable ID and private optional checkout", () => {
  const configuration = config(undefined, { repository: "..", verification: [{ id: "tests", command: ["npm", "test"] }] });
  const project = configuration.projects[0];
  assert.equal(project.repositories[0].id, "default");
  assert.equal(project.repository, fs.realpathSync("."));
  const data = snapshot();
  resolveProjectIdentity(data, configuration.projects, "roundhouse");
  assert.equal(data.projects.roundhouse.repositories[0].checkout_path, project.repository);
  const projected = dashboardProjection(data, configuration).overview.projects.roundhouse;
  assert.equal(projected.repositories[0].id, "default");
  assert.equal(JSON.stringify(projected).includes(project.repository), false);
});

test("GitHub HTTPS and SSH URLs normalize; unsafe URLs and duplicate IDs fail validation", () => {
  for (const url of [core.github_url, `${core.github_url}.git`, "git@github.com:ryngrn/roundhouse.git", "ssh://git@github.com/ryngrn/roundhouse.git"]) {
    assert.equal(config([{ ...core, github_url: url }]).projects[0].repositories[0].github_url, core.github_url);
  }
  for (const github_url of ["https://secret@github.com/ryngrn/roundhouse", `${core.github_url}?token=secret`,
    `${core.github_url}#secret`, "https://github.com.evil.test/ryngrn/roundhouse", "/Users/private/repo", "https://github.com/ryngrn/..", null]) {
    assert.throws(() => config([{ ...core, github_url }]), /github_url/);
  }
  assert.throws(() => config([core, core]), /Duplicate repository id/);
  assert.throws(() => config([{ ...core, token: "secret" }]), /unknown or unsafe/);
  const local = config([{ ...core, checkout_path: ".." }], { verification: [{ id: "tests", command: ["npm", "test"] }] }).projects[0];
  assert.equal(local.repositories[0].checkout_path, fs.realpathSync("."));
  assert.equal(local.repositories[0].github_url, core.github_url);
});

test("configured and stored-only project projections sanitize repository metadata and preserve connections", () => {
  const data = snapshot();
  data.projects.roundhouse = { id: "roundhouse", repository: "/private/secret", repositories: [
    { ...dashboard, checkout_path: "/private/secret", token: "credential", remote: "https://credential@github.com/x/y" },
  ], features: [{ id: "feature", title: "Keep this" }] };
  data.projects.other = { id: "other", repository: "/private/other", repositories: [
    { id: "unsafe", github_url: "https://credential@github.com/x/y", checkout_path: "/private/other", credentials: "credential" },
  ] };
  const before = structuredClone(data);
  const projected = dashboardProjection(data, config([core]));
  assert.deepEqual(projected.overview.projects.roundhouse.repositories.map((entry) => entry.id), ["dashboard", "core"]);
  assert.equal(projected.overview.projects.other.repositories[0].github_url, null);
  const serialized = JSON.stringify(projected.overview.projects);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("credential"), false);
  assert.deepEqual(data, before);
  resolveProjectIdentity(data, config([core]).projects, "Roundhouse");
  assert.deepEqual(data.projects.roundhouse.repositories.map((entry) => entry.id), ["dashboard", "core"]);
  assert.deepEqual(data.projects.roundhouse.features, before.projects.roundhouse.features);
  assert.notEqual(dashboardProjection(snapshot(), config([core])).projection_revision,
    dashboardProjection(snapshot(), config([core, dashboard])).projection_revision);
});

test("offline canonical connection migration is additive, idempotent, and preserves all history and identities", () => {
  const data = snapshot();
  data.projects.roundhouse = { id: "roundhouse", name: "Roundhouse", revision: 7, repository: "/private/core",
    features: [{ id: "feature" }], changelog: [{ text: "Keep history" }], goals: [{ id: "goal" }] };
  data.projects["roundhouse-dashboard"] = { id: "roundhouse-dashboard", features: [{ id: "dashboard-feature" }] };
  data.items.idea = { project_id: "roundhouse-dashboard", history: ["unchanged"] };
  data.jobs.job = { project_id: "roundhouse", project_context: { repository: "/private/core" } };
  const before = structuredClone(data);
  const proposed = connectRoundhouseRepositories(data);
  assert.deepEqual(data, before);
  assert.equal(proposed.projects.roundhouse.id, "roundhouse");
  assert.equal(proposed.projects.roundhouse.revision, 8);
  assert.deepEqual(proposed.projects.roundhouse.repositories, [{ id: "default", checkout_path: "/private/core" }, core, dashboard]);
  const { repositories, repository_connections, revision, ...preserved } = proposed.projects.roundhouse;
  const { revision: oldRevision, ...original } = before.projects.roundhouse;
  assert.deepEqual(preserved, original);
  assert.deepEqual(proposed.projects["roundhouse-dashboard"], before.projects["roundhouse-dashboard"]);
  assert.deepEqual(proposed.items, before.items);
  assert.deepEqual(proposed.jobs, before.jobs);
  assert.deepEqual(connectRoundhouseRepositories(proposed), proposed);
  assert.deepEqual(connectRoundhouseRepositories(snapshot()).projects.roundhouse.repositories, [core, dashboard]);
});

test("migration retains existing repository IDs and extra connections and rejects conflicting reserved IDs", () => {
  const data = snapshot();
  data.projects.roundhouse = { id: "roundhouse", repositories: [
    { id: "original", github_url: "git@github.com:ryngrn/roundhouse.git" }, { id: "docs", github_url: "https://github.com/ryngrn/docs" },
  ] };
  assert.deepEqual(connectRoundhouseRepositories(data).projects.roundhouse.repositories.map((entry) => entry.id), ["original", "docs", "dashboard"]);
  data.projects.roundhouse.repositories.push({ id: "dashboard", github_url: "https://github.com/ryngrn/unrelated" });
  assert.throws(() => connectRoundhouseRepositories(data), /occupied/);
});

test("legacy execution-state maps are preserved separately from durable repository connections", () => {
  const data = snapshot();
  const state = { core: { last_commit: "abc" } };
  data.projects.roundhouse = { id: "roundhouse", repositories: state, repository_connections: [core, dashboard] };
  resolveProjectIdentity(data, config([core]).projects, "Roundhouse");
  assert.deepEqual(data.projects.roundhouse.repositories, state);
  assert.deepEqual(data.projects.roundhouse.repository_connections.map((entry) => entry.id), ["core", "dashboard"]);
  const proposed = connectRoundhouseRepositories(data);
  assert.deepEqual(proposed.projects.roundhouse.repositories, state);
  const project = dashboardProjection(proposed, config([core])).overview.projects.roundhouse;
  assert.deepEqual(project.repositories.map((entry) => entry.id), ["core", "dashboard"]);
  assert.equal(project.repository_connections, undefined);
});

test("offline CLI creates a private proposal without modifying input or overwriting files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-proposal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "snapshot.json");
  const output = path.join(directory, "proposal.json");
  const original = JSON.stringify(snapshot());
  fs.writeFileSync(input, original);
  const run = (target) => spawnSync(process.execPath, ["scripts/prepare-roundhouse-repositories.mjs", input, target], { encoding: "utf8" });
  assert.equal(run(output).status, 0);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)).projects.roundhouse.repositories, [core, dashboard]);
  assert.notEqual(run(input).status, 0);
  assert.notEqual(run(output).status, 0);
  assert.equal(fs.readFileSync(input, "utf8"), original);
});
