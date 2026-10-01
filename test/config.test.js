import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, resolveProject } from "../src/config.js";

test("project routing comes only from YAML config", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-config-"));
  const configPath = path.join(directory, "projects.yaml");
  fs.writeFileSync(configPath, "projects:\n  New Project:\n    repo: /tmp/new-project\n");
  const config = loadConfig(configPath);
  assert.equal(resolveProject(config, "New Project").repo, "/tmp/new-project");
});

test("an unmapped project fails with a clear code", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-config-"));
  const configPath = path.join(directory, "projects.yaml");
  fs.writeFileSync(configPath, "projects:\n  Inclusion:\n    repo: /tmp/inclusion\n");
  const config = loadConfig(configPath);
  assert.throws(
    () => resolveProject(config, "Unknown"),
    (error) => error.code === "PROJECT_NOT_MAPPED" && error.message.includes("Unknown"),
  );
});
