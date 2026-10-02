import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireLock } from "./store.js";
import { runProcess } from "./runtime.js";
import { deploymentProvider } from "./deployment.js";

export function git(cwd, args, optional = false) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 30000, maxBuffer: 4_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0 && !optional) throw new Error(`Git ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return optional ? result : result.stdout.trim();
}

export class GitDelivery {
  supports(projectOrPolicy) {
    if (typeof projectOrPolicy === "string") return ["commit_only", "push_branch"].includes(projectOrPolicy);
    return ["commit_only", "push_branch"].includes(projectOrPolicy.policy.shipping) ||
      (projectOrPolicy.policy.shipping === "deploy" && Boolean(deploymentProvider(projectOrPolicy)));
  }
  lock(project) {
    const common = git(project.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return acquireLock(path.join(common, "roundhouse-worker.lock"));
  }
  prepare({ project, job, directory, base }) {
    if (!this.supports(project)) throw new Error(`Shipping provider ${project.policy.shipping} is not installed.`);
    if (git(project.repository, ["status", "--porcelain"])) throw new Error("Source repository has uncommitted changes; preserve them before running.");
    const relative = path.relative(project.repository, directory);
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("State/workspace directory must be outside the target repository.");
    const shouldPush = project.policy.shipping === "push_branch" || (project.policy.shipping === "deploy" && project.deployment.push_branch);
    const remote = shouldPush ? git(project.repository, ["remote", "get-url", "--push", project.remote]) : null;
    const commit = git(project.repository, ["rev-parse", "--verify", `${base ?? project.base_ref}^{commit}`]);
    const branch = `codex/roundhouse-${job.id}`;
    const workspace = path.join(directory, job.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    git(project.repository, ["worktree", "add", "-b", branch, workspace, commit]);
    return { workspace, branch, base: commit, remote, repository: project.repository };
  }
  snapshot({ job, project, prepared }) {
    const { workspace, branch } = prepared;
    if (git(workspace, ["branch", "--show-current"]) !== branch) throw new Error("Executor changed the delivery branch.");
    if (prepared.remote && git(project.repository, ["remote", "get-url", "--push", project.remote]) !== prepared.remote) throw new Error("Executor changed the remote configuration.");
    git(workspace, ["merge-base", "--is-ancestor", prepared.base, "HEAD"]);
    git(workspace, ["add", "--all"]);
    if (git(workspace, ["diff", "--cached", "--quiet"], true).status !== 0) {
      git(workspace, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", `Roundhouse: ${job.work.title}`]);
    }
    const commit = git(workspace, ["rev-parse", "HEAD"]);
    if (commit === prepared.base) throw new Error("Executor produced no delivery change.");
    if (git(workspace, ["status", "--porcelain"])) throw new Error("Worktree is not clean after committing.");
    const changed_files = git(workspace, ["diff", "--name-only", prepared.base, commit]).split("\n").filter(Boolean);
    return { commit, changed_files };
  }
  unchanged(prepared, commit) {
    return git(prepared.workspace, ["rev-parse", "HEAD"]) === commit &&
      git(prepared.workspace, ["branch", "--show-current"]) === prepared.branch &&
      git(prepared.workspace, ["status", "--porcelain"]) === "";
  }
  async ship({ project, prepared, verification, onStart }) {
    if (!verification.passed || !verification.checks.length || !verification.checks.every((c) => c.passed)) throw new Error("Shipping requires passing verification evidence.");
    if (!this.unchanged(prepared, verification.commit)) throw new Error("Tested version changed before shipping.");
    if (prepared.remote && git(project.repository, ["remote", "get-url", "--push", project.remote]) !== prepared.remote) throw new Error("Remote changed before shipping.");
    const result = { repository: project.repository, branch: prepared.branch, commit: verification.commit,
      policy: project.policy.shipping, remote: prepared.remote, pr_url: null, deployment: null, verification, timestamp: new Date().toISOString() };
    if (project.policy.shipping === "push_branch" || (project.policy.shipping === "deploy" && project.deployment.push_branch)) {
      const pushed = await runProcess(["git", "-c", "core.hooksPath=/dev/null", "-C", prepared.workspace, "push", project.remote,
        `${verification.commit}:refs/heads/${prepared.branch}`], { cwd: prepared.workspace, timeout: project.timeout_ms, onStart });
      if (!pushed.passed) throw new Error(`Push failed: ${pushed.stderr}`);
      const confirmed = await runProcess(["git", "-C", prepared.workspace, "ls-remote", project.remote, `refs/heads/${prepared.branch}`], { timeout: project.timeout_ms, onStart });
      if (!confirmed.passed || confirmed.stdout.split(/\s+/)[0] !== verification.commit) throw new Error("Could not confirm remote delivery; reconcile before retrying.");
      result.pushed = true;
    } else result.pushed = false;
    if (project.policy.shipping === "deploy") {
      const provider = deploymentProvider(project);
      result.deployment = await provider.deploy({ project, prepared, verification, onStart });
    }
    return result;
  }
}
