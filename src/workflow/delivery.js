import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { acquireLock } from "../storage/file-lock.js";
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
  canDispatch(project) {
    if (!project.repository) return false;
    if (!project.self_hosting) return true;
    if (git(project.repository, ["status", "--porcelain"])) return false;
    const common = git(project.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return !fs.existsSync(path.join(common, "roundhouse-worker.lock"));
  }
  supports(projectOrPolicy) {
    if (typeof projectOrPolicy === "string") return ["commit_only", "push_branch"].includes(projectOrPolicy);
    if (!projectOrPolicy.repository) return false;
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
    const branch = `${project.executor?.kind === "claude" ? "claude" : "codex"}/roundhouse-${job.id}`;
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

const outputLimit = 8 * 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function outputFiles(root) {
  const files = [];
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Durable outputs cannot contain symbolic links.");
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const relative = path.relative(root, filename);
        const content = fs.readFileSync(filename);
        bytes += content.length;
        if (bytes > outputLimit) throw new Error(`Durable output exceeds ${outputLimit} bytes.`);
        files.push({ path: relative, bytes: content.length, sha256: hash(content),
          encoding: "base64", content: content.toString("base64") });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Repository-independent delivery. File bodies are retained in the authoritative
 * snapshot as well as written to a versioned local inspection directory, so a
 * PostgreSQL reader does not depend on the worker's filesystem to inspect them. */
export class DurableOutputDelivery {
  constructor(directory) { this.directory = directory; }
  canDispatch(project) { return ["durable_output", "artifact"].includes(project.policy.shipping); }
  supports(project, job) {
    return ["durable_output", "artifact"].includes(project.policy.shipping)
      && (job?.work?.repository_required ?? project.repository_required) === false;
  }
  lock(project) {
    const directory = path.join(this.directory, "outputs", `${project.id}.lock`);
    return acquireLock(directory);
  }
  prepare({ project, job, directory }) {
    if (!this.supports(project, job)) throw new Error("Durable output delivery requires repository-free work and durable_output shipping.");
    const workspace = path.join(directory, job.id);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return { kind: "durable_output", workspace, repository: null, branch: null };
  }
  snapshot({ job, prepared, execution, run }) {
    const files = outputFiles(prepared.workspace);
    if (!files.length && !execution.output) throw new Error("Execution produced no structured result or artifact files.");
    const manifest = { schema_version: 1, job_id: job.id, provider: execution.provider ?? null,
      run: { id: run.id, attempt: run.attempt, provider_id: execution.provider?.id ?? run.provider_id, input_digest: run.input_digest },
      result: execution.output ?? null, files };
    const version = hash(JSON.stringify(manifest));
    prepared.file_digest = hash(JSON.stringify(files));
    prepared.version = version;
    return { version, commit: null, manifest, evidence: [{ id: "durable-output-manifest", source: "automated", passed: true,
      summary: `Captured ${files.length} artifact file${files.length === 1 ? "" : "s"} in immutable output ${version.slice(0, 12)}.` }] };
  }
  unchanged(prepared, version) {
    return hash(JSON.stringify(outputFiles(prepared.workspace))) === prepared.file_digest && prepared.version === version;
  }
  async ship({ project, job, prepared, verification, snapshot, execution, run }) {
    if (!verification.passed || !verification.checks.length || !verification.checks.every((check) => check.passed)) {
      throw new Error("Durable output delivery requires passing verification evidence.");
    }
    const current = outputFiles(prepared.workspace);
    if (hash(JSON.stringify(current)) !== hash(JSON.stringify(snapshot.manifest.files))) throw new Error("Output changed after verification.");
    const reference = `roundhouse-output://${job.id}/${snapshot.version}`;
    const directory = path.join(this.directory, "outputs", job.id, snapshot.version);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manifestFile = path.join(directory, "manifest.json");
    if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, JSON.stringify({ ...snapshot.manifest, version: snapshot.version, reference }, null, 2), { mode: 0o600 });
    return { provider: "durable-output", policy: project.policy.shipping, repository: null, branch: null, commit: null,
      pushed: false, version: snapshot.version, reference, outputs: snapshot.manifest.files,
      result: snapshot.manifest.result, provenance: { job_id: job.id, provider: execution.provider ?? null,
        run_id: run.id, attempt: run.attempt, input_digest: job.input_digest ?? run.input_digest,
        candidate_digest: snapshot.version },
      verification, timestamp: new Date().toISOString() };
  }
}

export class DeliveryRouter {
  constructor({ directory, gitDelivery = new GitDelivery(), outputDelivery = new DurableOutputDelivery(directory) } = {}) {
    this.git = gitDelivery;
    this.output = outputDelivery;
  }
  provider(project, job, prepared) {
    return prepared?.kind === "durable_output" || (project && ["durable_output", "artifact"].includes(project.policy.shipping))
      ? this.output : this.git;
  }
  canDispatch(project) { return this.provider(project).canDispatch(project); }
  supports(project, job) { return this.provider(project, job).supports(project, job); }
  lock(project, job) { return this.provider(project, job).lock(project, job); }
  prepare(options) { return this.provider(options.project, options.job).prepare(options); }
  snapshot(options) { return this.provider(options.project, options.job, options.prepared).snapshot(options); }
  unchanged(prepared, version, project) { return this.provider(project, null, prepared).unchanged(prepared, version); }
  ship(options) { return this.provider(options.project, options.job, options.prepared).ship(options); }
}
