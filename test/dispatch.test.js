import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatch } from "../src/dispatch.js";

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("successful execution requests Running then Review and verifies the commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-dispatch-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  command("git", ["init", "-q"], repo);
  command("git", ["config", "user.name", "Roundhouse Test"], repo);
  command("git", ["config", "user.email", "test@example.com"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n");
  command("git", ["add", "README.md"], repo);
  command("git", ["commit", "-qm", "Initial commit"], repo);

  const configPath = path.join(root, "projects.yaml");
  fs.writeFileSync(
    configPath,
    `projects:\n  Test Project:\n    repo: ${repo}\nexecution:\n  state_dir: ${path.join(root, "state")}\n`,
  );
  const itemPath = path.join(root, "item.json");
  fs.writeFileSync(
    itemPath,
    JSON.stringify({
      url: "https://app.notion.com/p/0123456789abcdef0123456789abcdef",
      properties: { Item: "Implement fixture", Project: "Test Project", Status: "Ready" },
    }),
  );
  const events = [];
  const exitCode = await dispatch({
    configPath,
    itemPath,
    emit: (event) => events.push(event),
    executeCodex: async ({ runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(repo, "feature.txt"), "implemented\n");
      command("git", ["add", "feature.txt"], repo);
      command("git", ["commit", "-qm", "Implement fixture"], repo);
      return { runDir, finalMessage: "Implemented fixture", usage: null };
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(events.map((event) => event.status), ["Running", "Review"]);
  assert.match(events[1].commit, /^[0-9a-f]{40}$/);
});

test("missing mapping requests Blocked without invoking an executor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-unmapped-"));
  const configPath = path.join(root, "projects.yaml");
  fs.writeFileSync(configPath, "projects:\n  Inclusion:\n    repo: /tmp/inclusion\n");
  const itemPath = path.join(root, "item.json");
  fs.writeFileSync(
    itemPath,
    JSON.stringify({ Item: "Unknown task", Project: "Unknown", Status: "Ready" }),
  );
  const events = [];
  let invoked = false;
  const exitCode = await dispatch({
    configPath,
    itemPath,
    emit: (event) => events.push(event),
    executeCodex: async () => {
      invoked = true;
    },
  });
  assert.equal(exitCode, 2);
  assert.equal(invoked, false);
  assert.equal(events[0].status, "Blocked");
  assert.equal(events[0].error.code, "PROJECT_NOT_MAPPED");
});
