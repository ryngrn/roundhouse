import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubRepositoryUrl, projectRepositories } from "../src/workflow/project-repositories.js";

// Offline, additive snapshot transform. Never connects to a database or changes
// assignments, execution configuration, jobs, features, or other project records.
export function connectRoundhouseRepositories(snapshot) {
  if (!snapshot || snapshot.schema_version !== 1 || !snapshot.projects
    || typeof snapshot.projects !== "object" || Array.isArray(snapshot.projects)) {
    throw new Error("Expected a version 1 Roundhouse storage snapshot with projects.");
  }
  const result = structuredClone(snapshot);
  const existing = result.projects.roundhouse;
  if (existing?.id && existing.id !== "roundhouse") throw new Error("Canonical project identity is inconsistent.");
  const project = existing ? { ...existing } : { id: "roundhouse", name: "Roundhouse" };
  const repositories = projectRepositories(project).map((entry) => ({ ...entry }));
  for (const [id, github_url] of [
    ["core", "https://github.com/ryngrn/roundhouse"],
    ["dashboard", "https://github.com/ryngrn/roundhouse.ryan.green"],
  ]) {
    const sameUrl = repositories.find((entry) => {
      try { return githubRepositoryUrl(entry.github_url).toLowerCase() === github_url.toLowerCase(); } catch { return false; }
    });
    if (sameUrl) continue; // Retain any existing stable ID for this remote.
    if (repositories.some((entry) => entry.id === id)) throw new Error(`Repository ID ${id} is occupied; review its binding manually.`);
    repositories.push({ id, github_url });
  }
  if (!project.repositories || Array.isArray(project.repositories)) project.repositories = repositories;
  project.repository_connections = repositories;
  if (JSON.stringify(project) !== JSON.stringify(existing)) project.revision = (existing?.revision ?? 0) + 1;
  result.projects.roundhouse = project;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output, ...extra] = process.argv;
  if (!input || !output || extra.length) throw new Error("Usage: node scripts/prepare-roundhouse-repositories.mjs snapshot.json proposed.json");
  const proposed = connectRoundhouseRepositories(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, `${JSON.stringify(proposed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
