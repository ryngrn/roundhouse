import { RoundhouseError } from "./errors.js";

function richTextToString(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((part) => part?.plain_text ?? part?.text?.content ?? "").join("");
}

function unwrap(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (value.select) return value.select.name;
  if (value.status) return value.status.name;
  if (value.title) return richTextToString(value.title);
  if (value.rich_text) return richTextToString(value.rich_text);
  if (value.checkbox !== undefined) return value.checkbox;
  if (value.number !== undefined) return value.number;
  return value;
}

function property(properties, ...names) {
  for (const name of names) {
    if (Object.hasOwn(properties, name)) return unwrap(properties[name]);
  }
  return undefined;
}

export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") {
    throw new RoundhouseError("INVALID_ITEM", "Notion item payload must be an object.");
  }
  const properties = raw.properties ?? raw;
  const item = {
    pageUrl: raw.url ?? raw.page_url ?? property(properties, "url", "URL"),
    title: property(properties, "Item", "Name", "Title") ?? raw.title,
    project: property(properties, "Project") ?? raw.project,
    status: property(properties, "Status") ?? raw.status,
    priority: property(properties, "Priority") ?? raw.priority,
    normalizedBrief:
      property(properties, "Normalized Brief") ?? raw.normalizedBrief ?? raw.normalized_brief,
    outcome: property(properties, "Outcome") ?? raw.outcome,
    acceptanceCriteria:
      property(properties, "Acceptance Criteria") ??
      raw.acceptanceCriteria ??
      raw.acceptance_criteria,
    rawIntake: property(properties, "Raw Intake") ?? raw.rawIntake ?? raw.raw_intake,
    content: raw.content ?? "",
  };

  for (const field of ["title", "project", "status"]) {
    if (typeof item[field] !== "string" || item[field].trim() === "") {
      throw new RoundhouseError(
        "INVALID_ITEM",
        `Notion item is missing required field ${field}.`,
        { field },
      );
    }
  }
  return item;
}

export function assertReady(item) {
  if (item.status !== "Ready") {
    throw new RoundhouseError(
      "ITEM_NOT_READY",
      `Only items with Status = Ready may execute; received ${JSON.stringify(item.status)}.`,
      { status: item.status },
    );
  }
}

export function itemKey(item) {
  const compactId = item.pageUrl?.match(/[0-9a-f]{32}/i)?.[0];
  if (compactId) return compactId.toLowerCase();
  return item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function buildCodexPrompt(item) {
  const sections = [
    "You are executing an approved Roundhouse work item.",
    "",
    `Title: ${item.title}`,
    `Project: ${item.project}`,
  ];
  if (item.priority) sections.push(`Priority: ${item.priority}`);
  if (item.pageUrl) sections.push(`Notion item: ${item.pageUrl}`);
  if (item.outcome) sections.push("", "Desired outcome:", item.outcome);
  if (item.normalizedBrief) sections.push("", "Normalized brief:", item.normalizedBrief);
  if (item.acceptanceCriteria) {
    sections.push("", "Acceptance criteria:", item.acceptanceCriteria);
  }
  if (item.rawIntake) sections.push("", "Original intake:", item.rawIntake);
  if (item.content) sections.push("", "Additional page context:", item.content);
  sections.push(
    "",
    "Execution requirements:",
    "- Read and follow repository instructions, including AGENTS.md.",
    "- Implement the smallest coherent change that satisfies the work item.",
    "- Run the relevant tests and checks.",
    "- Commit the completed work locally with a clear commit message.",
    "- Do not push, open a pull request, deploy, or mark the Notion item Done.",
    "- Preserve unrelated existing work.",
    "- If completion is unsafe or impossible, stop and explain the blocker without creating a misleading commit.",
  );
  return sections.join("\n");
}
