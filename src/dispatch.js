import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveProject } from "./config.js";
import { RoundhouseError } from "./errors.js";
import { inspectRepository, verifyCompletedRepository } from "./git.js";
import { assertReady, buildCodexPrompt, itemKey, normalizeItem } from "./item.js";
import { runCodex } from "./codex-executor.js";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function errorPayload(error) {
  if (error instanceof RoundhouseError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "UNEXPECTED_ERROR", message: error.message, details: {} };
}

export async function dispatch({
  configPath,
  itemPath,
  dryRun = false,
  emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  executeCodex = runCodex,
}) {
  let item;
  let lockPath;
  let runningEmitted = false;
  try {
    const config = loadConfig(configPath);
    item = normalizeItem(JSON.parse(fs.readFileSync(itemPath, "utf8")));
    assertReady(item);
    const project = resolveProject(config, item.project);
    const repository = inspectRepository(project.repo, config.execution.requireCleanWorktree);
    const prompt = buildCodexPrompt(item);

    if (dryRun) {
      emit({
        type: "dispatch.validated",
        notion_page_url: item.pageUrl ?? null,
        item: item.title,
        project: item.project,
        repo: project.repo,
        status: "Ready",
      });
      return 0;
    }

    const key = itemKey(item);
    const lockDir = path.join(config.execution.stateDir, "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    lockPath = path.join(lockDir, `${key}.lock`);
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new RoundhouseError(
          "ALREADY_RUNNING",
          `A run is already active for ${item.title}.`,
          { lockPath },
        );
      }
      throw error;
    }

    const runDir = path.join(config.execution.stateDir, "runs", key, timestamp());
    emit({
      type: "notion.status_requested",
      notion_page_url: item.pageUrl ?? null,
      item: item.title,
      project: item.project,
      repo: project.repo,
      status: "Running",
      run_dir: runDir,
    });
    runningEmitted = true;

    const execution = await executeCodex({
      codexBin: config.execution.codexBin,
      repo: project.repo,
      prompt,
      runDir,
      timeoutMs: config.execution.timeoutMs,
    });
    const commit = verifyCompletedRepository(project.repo, repository.head);
    const result = {
      type: "notion.status_requested",
      notion_page_url: item.pageUrl ?? null,
      item: item.title,
      project: item.project,
      repo: project.repo,
      status: "Review",
      commit: commit.headAfter,
      commit_subject: commit.subject,
      summary: execution.finalMessage,
      usage: execution.usage,
      run_dir: execution.runDir,
    };
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    emit(result);
    return 0;
  } catch (error) {
    const failure = errorPayload(error);
    if (item?.status === "Ready") {
      emit({
        type: "notion.status_requested",
        notion_page_url: item.pageUrl ?? null,
        item: item.title,
        project: item.project,
        status: "Blocked",
        running_was_requested: runningEmitted,
        error: failure,
      });
      return 2;
    }
    emit({ type: "dispatch.rejected", error: failure });
    return 4;
  } finally {
    if (lockPath) fs.rmSync(lockPath, { force: true });
  }
}
