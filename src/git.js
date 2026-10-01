import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { RoundhouseError } from "./errors.js";

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new RoundhouseError(
      "GIT_COMMAND_FAILED",
      `git ${args.join(" ")} failed in ${repo}: ${(result.stderr || result.stdout).trim()}`,
      { repo, args, exitCode: result.status },
    );
  }
  return result;
}

export function inspectRepository(repo, requireCleanWorktree = true) {
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw new RoundhouseError("REPOSITORY_NOT_FOUND", `Mapped repository does not exist: ${repo}`, {
      repo,
    });
  }
  git(repo, ["rev-parse", "--is-inside-work-tree"]);
  const status = git(repo, ["status", "--porcelain"]).stdout.trim();
  if (requireCleanWorktree && status) {
    throw new RoundhouseError(
      "DIRTY_WORKTREE",
      `Repository has uncommitted changes and policy requires a clean worktree: ${repo}`,
      { repo, status: status.split("\n") },
    );
  }
  const headResult = git(repo, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return { head: headResult.status === 0 ? headResult.stdout.trim() : null, status };
}

export function verifyCompletedRepository(repo, headBefore) {
  const headResult = git(repo, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  const headAfter = headResult.status === 0 ? headResult.stdout.trim() : null;
  const status = git(repo, ["status", "--porcelain"]).stdout.trim();
  if (!headAfter || headAfter === headBefore) {
    throw new RoundhouseError(
      "COMMIT_NOT_CREATED",
      "Codex exited successfully but did not create a new local commit.",
      { repo, headBefore, headAfter, status: status ? status.split("\n") : [] },
    );
  }
  if (status) {
    throw new RoundhouseError(
      "WORKTREE_NOT_CLEAN",
      "Codex created a commit but left uncommitted changes in the repository.",
      { repo, headBefore, headAfter, status: status.split("\n") },
    );
  }
  const subject = git(repo, ["log", "-1", "--format=%s"]).stdout.trim();
  return { headBefore, headAfter, subject };
}
