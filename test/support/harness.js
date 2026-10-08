import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../../src/workflow/delivery.js";
import { Store } from "../../src/workflow/store.js";
import { loadWorkflowConfig } from "../../src/workflow/config.js";
import { Engine } from "../../src/workflow/engine.js";

export const provider = fileURLToPath(new URL("./providers.mjs", import.meta.url));
export const fakeClaude = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
export const fakeCodex = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
export function harness({ policy = {}, verification, executor, decision, deployment } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roundhouse-flow-"));
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repository);
  git(root, ["init", "--bare", remote]);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Roundhouse Test"]);
  git(repository, ["config", "user.email", "test@roundhouse.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "Fixture project\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "Initial"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "-u", "origin", "main"]);
  const configuration = {
    decision: decision ?? { kind: "command", command: [process.execPath, provider, "decide"] },
    max_jobs_per_run: 10,
    projects: [{ id: "example", name: "Example", purpose: "Prove delivery", success_state: "Verified changes are delivered", status: "active",
      repository, context_sources: ["README.md"], executor: executor ?? { kind: "command", command: [process.execPath, provider, "execute"] },
      policy: { allow_autonomous: true, continuation: "continue_project_queue", ...policy },
      ...(deployment ? { deployment } : {}),
      verification: verification ?? [{ id: "feature", command: [process.execPath, "-e", "const fs=require('fs'); const s=fs.readFileSync('feature.txt','utf8'); if(!s.includes('implemented:') || s.includes('invalid')) process.exit(1)"] }],
    }],
  };
  const configFile = path.join(root, "projects.json");
  fs.writeFileSync(configFile, JSON.stringify(configuration));
  const config = loadWorkflowConfig(configFile);
  const store = new Store(path.join(root, "state"));
  const engine = new Engine({ store, config });
  const submit = (text, key = text) => store.submit({ text, project_id: "example", source: "fixture", actor: "test" }, key);
  return { root, repository, remote, configFile, config, store, engine, submit };
}
