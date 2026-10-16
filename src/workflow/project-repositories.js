// Product metadata only. This module does not select execution targets.
export function githubRepositoryUrl(value) {
  if (typeof value !== "string") throw new Error("Repository github_url must be a GitHub repository URL.");
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match || [".", ".."].includes(match[2])) throw new Error("Repository github_url must be a credential-free GitHub repository URL.");
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function projectRepositories(project) {
  // Older execution code also uses `repositories` for a per-repository state
  // map. Keep durable connections separate so those writes cannot erase them.
  return project?.repository_connections ?? (Array.isArray(project?.repositories) ? project.repositories : null) ?? (project?.repository
    ? [{ id: "default", checkout_path: project.repository }] : []);
}

// Keep durable connections when execution configuration is narrower. Stable IDs
// are never inferred from array positions or mutable local paths.
export function mergeProjectRepositories(stored, configured) {
  const entries = new Map(projectRepositories(stored).map((entry) => [entry.id, { ...entry }]));
  for (const entry of projectRepositories(configured)) entries.set(entry.id, { ...entries.get(entry.id), ...entry });
  return [...entries.values()];
}

export function publicProjectRepositories(project) {
  return projectRepositories(project).map((entry) => {
    let github_url = null;
    try { if (entry.github_url != null) github_url = githubRepositoryUrl(entry.github_url); } catch { /* Omit unsafe historical URLs. */ }
    return { id: entry.id, label: entry.label ?? entry.id, github_url,
      verification_ids: (entry.verification ?? []).map((rule) => rule.id),
      shipping_policy: entry.policy?.shipping ?? project.policy?.shipping ?? null };
  });
}
