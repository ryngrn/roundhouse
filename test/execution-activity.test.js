import assert from "node:assert/strict";
import test from "node:test";
import { correlateExecutionActivity, inspectExecutionActivity } from "../src/workflow/execution-activity.js";
import { statusView } from "../src/workflow/views.js";

const projects = [{ id: "roundhouse", repository: "/repo", runtime: "local", executor: { kind: "codex", bin: "/opt/codex" } }];

test("execution activity correlates durable process and worktree launch provenance", () => {
  const data = { items: {}, projects: {}, system_metadata: {}, jobs: {
    tracked: { id: "tracked", processes: [{ pid: 41, command: ["/opt/codex", "exec", "-"] }], prepared: { workspace: "/state/workspaces/tracked" } },
  } };
  const activity = correlateExecutionActivity({
    data,
    projects,
    observedProcesses: [
      { pid: 41, parent_pid: 1, command: "/opt/codex exec -" },
      { pid: 42, parent_pid: 1, command: "/opt/codex exec --ephemeral -" },
      { pid: 43, parent_pid: 1, command: "unrelated --worker" },
      { pid: 44, parent_pid: 1, command: "logger /opt/codex exec --ephemeral -" },
      { pid: 45, parent_pid: 1, command: "/opt/codex-experimental exec --ephemeral -" },
    ],
    observedWorktrees: [
      { repository: "/repo", path: "/repo", branch: "main" },
      { repository: "/repo", path: "/state/workspaces/tracked", branch: "codex/roundhouse-tracked" },
      { repository: "/repo", path: "/tmp/manual", branch: "manual-agent" },
    ],
  });
  assert.deepEqual(activity.map((entry) => [entry.kind, entry.pid ?? entry.path]), [
    ["process", 42],
    ["worktree", "/tmp/manual"],
  ]);
  assert.ok(activity.every((entry) => entry.status === "untracked" && entry.authoritative === false));
});

test("platform-limited activity inspection returns warnings and leaves authoritative status intact", () => {
  const data = { items: {}, jobs: {}, projects: {}, system_metadata: {}, outbox: [] };
  const inspection = inspectExecutionActivity({ data, projects,
    processLister: () => { throw new Error("ps denied"); },
    worktreeLister: () => { throw new Error("git unavailable"); } });
  assert.equal(inspection.process_inspection, "unavailable");
  assert.equal(inspection.worktree_inspection, "partial");
  assert.equal(inspection.activity.length, 0);
  assert.equal(inspection.warnings.length, 2);
  const status = statusView(data, {}, inspection);
  assert.deepEqual(status.active_jobs, []);
  assert.deepEqual(status.untracked_activity, []);
  assert.match(status.activity_inspection.warnings.join(" "), /ps denied.*git unavailable/);
});

test("untracked observations never become authoritative active jobs", () => {
  const data = { items: {}, jobs: {}, projects: {}, system_metadata: {}, outbox: [] };
  const inspection = inspectExecutionActivity({ data, projects,
    processLister: () => [{ pid: 99, parent_pid: 1, command: "/opt/codex exec -" }],
    worktreeLister: () => [{ repository: "/repo", path: "/tmp/orphan", branch: "codex/manual" }] });
  const status = statusView(data, {}, inspection);
  assert.equal(status.active_jobs.length, 0);
  assert.equal(status.untracked_activity.length, 2);
  assert.ok(status.untracked_activity.every((entry) => !("job_id" in entry) && !("state" in entry) && !("shipping" in entry)));
  assert.deepEqual(statusView(data, { project_id: "roundhouse" }, inspection).untracked_activity, []);
});

test("configured capability providers are feasible executor processes", () => {
  const data = { items: {}, jobs: {}, projects: {}, system_metadata: {}, outbox: [] };
  const activity = correlateExecutionActivity({ data, projects: [],
    providers: [{ id: "research", kind: "command", command: ["/opt/research-agent", "run"] }],
    observedProcesses: [{ pid: 77, command: "/opt/research-agent run --foreground" }] });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].executable, "research-agent");
});

test("custom Herdr binaries are observed without treating command mentions as executions", () => {
  const activity = correlateExecutionActivity({ data: { jobs: {} }, projects: [{
    id: "remote", runtime: "herdr", herdr: { bin: "/opt/herdr-custom" },
  }], observedProcesses: [
    { pid: 81, command: "/opt/herdr-custom --machine iMac agent prompt worker" },
    { pid: 82, command: "logger /opt/herdr-custom --machine iMac agent prompt worker" },
  ] });
  assert.deepEqual(activity.map((entry) => entry.pid), [81]);
  assert.equal(activity[0].executable, "herdr-custom");
});
