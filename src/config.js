import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { RoundhouseError } from "./errors.js";

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "roundhouse",
  "projects.yaml",
);

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new RoundhouseError(
      "CONFIG_READ_FAILED",
      `Could not read Roundhouse config at ${configPath}: ${error.message}`,
      { configPath },
    );
  }

  if (!parsed || typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) {
    throw new RoundhouseError(
      "INVALID_CONFIG",
      "Config must contain a projects mapping.",
      { configPath },
    );
  }

  const projects = {};
  for (const [name, project] of Object.entries(parsed.projects)) {
    if (!project || typeof project.repo !== "string" || project.repo.trim() === "") {
      throw new RoundhouseError(
        "INVALID_PROJECT_CONFIG",
        `Project ${name} must define a non-empty repo path.`,
        { project: name, configPath },
      );
    }
    projects[name] = { ...project, repo: path.resolve(expandHome(project.repo)) };
  }

  const execution = parsed.execution ?? {};
  return {
    projects,
    execution: {
      codexBin: path.resolve(expandHome(execution.codex_bin ?? "~/.local/bin/codex")),
      stateDir: path.resolve(
        expandHome(execution.state_dir ?? "~/.local/state/roundhouse"),
      ),
      timeoutMs: Number(execution.timeout_minutes ?? 120) * 60_000,
      requireCleanWorktree: execution.require_clean_worktree !== false,
    },
    configPath: path.resolve(configPath),
  };
}

export function resolveProject(config, projectName) {
  const project = config.projects[projectName];
  if (!project) {
    throw new RoundhouseError(
      "PROJECT_NOT_MAPPED",
      `No repository mapping exists for Notion project ${JSON.stringify(projectName)}. Add it under projects in ${config.configPath}.`,
      { project: projectName, configPath: config.configPath },
    );
  }
  return project;
}
