import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../agent", import.meta.url));
const MAX_SKILL_BYTES = 24_000;
const MAX_COMPOSED_BYTES = 96_000;

const roles = {
  general: {
    id: "general",
    name: "General",
    summary: "General-purpose software implementation using project instructions and configured verification.",
    skills: [],
    requiredEvidence: [],
  },
  designer: {
    id: "designer",
    name: "Designer",
    summary: "Product design implementation with bounded design context, browser inspection, and explicit visual-review evidence.",
    profile: "roles/designer.md",
    skills: [
      "skills/product-understanding.md",
      "skills/hierarchy-typography-layout.md",
      "skills/color-accessibility.md",
      "skills/responsive-interaction-imagery.md",
      "skills/conversion-design-system.md",
      "skills/visual-qa-implementation.md",
    ],
    requiredEvidence: [
      "existing-product-inspection",
      "design-context-review",
      "browser-render",
      "desktop-visual-review",
      "mobile-visual-review",
      "no-obvious-overflow",
      "accessibility-review",
      "scoped-change-review",
      "implementation-quality-review",
    ],
  },
};

export const agentRoleIds = Object.freeze(Object.keys(roles));

export function roleDefinition(id) {
  const role = roles[id];
  if (!role) throw new Error(`Unknown agent role: ${id}`);
  return role;
}

function readBounded(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error(`Agent skill exceeds ${MAX_SKILL_BYTES} bytes: ${filename}`);
  return fs.readFileSync(filename, "utf8");
}

function repositoryFile(repository, relative) {
  const realRepository = fs.realpathSync(repository);
  const filename = fs.realpathSync(path.resolve(realRepository, relative));
  const rel = path.relative(realRepository, filename);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Agent skill must remain inside the project repository.");
  return filename;
}

export function inferAgentRole({ item, decision, project }) {
  const configured = project.agent?.default_role ?? "auto";
  const allowed = project.agent?.allowed_roles ?? agentRoleIds;
  if (configured !== "auto") return configured;
  const text = [
    item?.input?.text,
    item?.input?.context && JSON.stringify(item.input.context),
    ...decision.work_items.flatMap((work) => [work.title, work.outcome]),
  ].filter(Boolean).join("\n").toLowerCase();
  const designSignals = [
    /\bdesigner\b/, /\bdesign(?:-heavy| system)?\b/, /\bvisual\b/, /\btypograph/, /\blayout\b/,
    /\bresponsive\b/, /\bhero\b/, /\bheader\b/, /\bcta\b/, /\buser interface\b/, /\bui\b/,
    /\bart direction\b/, /\bcolor\b/, /\bspacing\b/, /\binteraction\b/, /\bmotion\b/,
  ];
  const inferred = designSignals.some((pattern) => pattern.test(text)) ? "designer" : "general";
  return allowed.includes(inferred) ? inferred : (allowed.includes("general") ? "general" : allowed[0]);
}

export function composeAgentRole(roleId, project) {
  const role = roleDefinition(roleId);
  const sources = [];
  if (role.profile) sources.push({ source: `roundhouse:${role.profile}`, text: readBounded(path.join(root, role.profile)) });
  for (const relative of role.skills) sources.push({ source: `roundhouse:${relative}`, text: readBounded(path.join(root, relative)) });
  for (const relative of project.agent?.skill_sources?.[roleId] ?? []) {
    sources.push({ source: relative, text: readBounded(repositoryFile(project.repository, relative)) });
  }
  const total = sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0);
  if (total > MAX_COMPOSED_BYTES) throw new Error(`Composed agent skills exceed ${MAX_COMPOSED_BYTES} bytes.`);
  return { id: role.id, name: role.name, summary: role.summary, required_evidence: [...role.requiredEvidence], skills: sources };
}
