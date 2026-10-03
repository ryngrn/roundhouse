import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve("src/web");
const output = path.resolve(process.env.ROUNDHOUSE_VISUAL_DIR ?? "artifacts/dark-control-room");
fs.mkdirSync(output, { recursive: true });

const now = new Date().toISOString();
const item = (overrides) => ({
  id: "item", state: "Depot", revision: 1, project: "roundhouse", project_candidate: null, priority: "P2",
  title: "Untitled work", summary: "Representative control-room work.", raw_intake: "Representative control-room work.",
  brief: "Keep the local control plane calm, inspectable, and reliable.", context: "Local operator workflow.",
  acceptance_criteria: ["Desktop and mobile renders pass visual gates.", "Existing browser behavior remains intact."],
  reason: "Waiting in the local queue.", question: null, question_id: null, question_revision: null, questions: [], needs_you: false,
  display_state: "Depot", outcome: null, imported: false, provenance: null, legacy: null, requires_reevaluation: false,
  execution_eligible: true, created_at: now, updated_at: now, agent_role: "designer", owning_node: "ryans-mac",
  verification_status: "Not run", shipping_status: "Not shipped", prior_decisions: [],
  history: [{ from: null, to: "Depot", reason: "Added to the Depot.", at: now }],
  evidence: { checks: [], deliveries: [], completion_reports: [] }, jobs: [],
  ...overrides,
});

const items = [
  item({
    id: "signal-1", state: "Needs Clarification", display_state: "Needs You", needs_you: true, priority: "P1",
    title: "Resolve deployment access for the private dashboard",
    reason: "A bounded operator choice is needed before work can continue.",
    outcome: "The dashboard deploys through the approved private route.",
    questions: [
      { id: "q-1", revision: 2, prompt: "Which private deployment target should Roundhouse use for this release?" },
      { id: "q-2", revision: 1, prompt: "Who should receive the first verification link?" },
    ],
    history: [{ from: "Decision", to: "Needs Clarification", reason: "Deployment target is ambiguous.", at: now }],
  }),
  item({
    id: "moving-1", state: "Executing", display_state: "Executing", priority: "P1", title: "Dark control room visual system",
    reason: "Designer is implementing the approved interface direction.", outcome: "A genuinely dark, compact operations surface.",
    verification_status: "Running", jobs: [{ id: "job-moving", title: "Implement dark UI", state: "Executing", reason: "CSS and browser states in progress.", attempts: 1, agent_role: "designer", shipping: null }],
  }),
  item({ id: "ready-1", state: "Ready", display_state: "Ready", title: "Polling-safe focus regression", reason: "Ready for the next worker slot.", agent_role: "general" }),
  item({ id: "held-1", state: "Blocked", display_state: "Blocked", priority: "P1", title: "Legacy preview host handoff", reason: "Remote host did not return a usable preview URL.", outcome: "Blocked: external preview host unavailable.", agent_role: "general" }),
  item({
    id: "shipped-1", state: "Shipped", display_state: "Shipped", project: "inclusion", title: "Homepage hierarchy refinement",
    reason: "Verified preview delivered.", outcome: "Homepage hierarchy refined and delivered to preview.",
    verification_status: "Passed", shipping_status: "Delivered",
    history: [{ from: "Verification", to: "Shipped", reason: "Desktop and mobile visual review passed.", at: now }],
    evidence: {
      checks: [{ id: "browser-render", passed: true, summary: "Desktop and mobile rendered without overflow." }, { id: "contrast", passed: true, summary: "Text contrast meets WCAG AA." }],
      deliveries: [{ pushed: true, branch: "codex/homepage-hierarchy", commit: "89abcdef01234567", deployment: { status: "succeeded", environment: "preview", url: "https://example.invalid/preview" } }],
      completion_reports: [],
    },
  }),
];

const overview = {
  items,
  projects: {},
  project_candidates: {},
  counts: { needs_you: 1, active: 1, queued: 1, completed: 1, blocked: 1 },
  connection: { worker: { running: true }, storage: { kind: "postgres", node: { name: "control-room" } } },
};
const configuration = { projects: [
  { id: "roundhouse", name: "Roundhouse", purpose: "Local autonomous-work control plane." },
  { id: "inclusion", name: "Inclusion", purpose: "Public website and client delivery." },
] };

const types = new Map([[".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".svg", "image/svg+xml"]]);
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/overview") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(overview));
  if (request.method === "GET" && url.pathname === "/api/config") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configuration }));
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(`${root}${path.sep}`) || !fs.existsSync(filename)) return response.writeHead(404).end("Not found");
  response.writeHead(200, { "content-type": types.get(path.extname(filename)) ?? "application/octet-stream" });
  fs.createReadStream(filename).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function inspect(page, surface) {
  return page.evaluate(({ surface }) => {
    const toRgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const relativeLuminance = (value) => {
      const linear = toRgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = (foreground, background) => {
      const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const visible = (element) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const major = [...document.querySelectorAll("body *")].flatMap((element) => {
      if (!visible(element)) return [];
      const rect = element.getBoundingClientRect(); const color = getComputedStyle(element).backgroundColor;
      if (rect.width * rect.height < 12000 || color === "rgba(0, 0, 0, 0)") return [];
      return [{ tag: element.tagName.toLowerCase(), className: String(element.className), area: Math.round(rect.width * rect.height), color, luminance: relativeLuminance(color) }];
    });
    const surfaces = {};
    for (const selector of ["body", ".command-bar", ".project-group", ".project-heading", ".work-row", ".work-dialog", ".modal-content", ".decision-field", ".config-dialog"]) {
      const element = document.querySelector(selector);
      if (element && visible(element)) { const color = getComputedStyle(element).backgroundColor; surfaces[selector] = { color, luminance: relativeLuminance(color) }; }
    }
    const rowText = document.querySelector(".work-row strong");
    const row = document.querySelector(".work-row");
    const bodyStyle = getComputedStyle(document.body);
    return {
      surface,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBackground: bodyStyle.backgroundColor,
      bodyLuminance: relativeLuminance(bodyStyle.backgroundColor),
      bodyText: bodyStyle.color,
      bodyContrast: ratio(bodyStyle.color, bodyStyle.backgroundColor),
      primaryTextContrast: rowText && row ? ratio(getComputedStyle(rowText).color, getComputedStyle(row).backgroundColor) : null,
      surfaces,
      nearWhiteMajorElements: major.filter((entry) => entry.luminance > 0.8),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      focused: document.activeElement?.id || document.activeElement?.tagName?.toLowerCase(),
    };
  }, { surface });
}

const chrome = [process.env.PLAYWRIGHT_CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((candidate) => candidate && fs.existsSync(candidate));
let browser;
const results = [];
const errors = [];
try {
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "dark" });
    page.on("console", (message) => { if (message.type() === "error") errors.push(`${viewport.name} console: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`${viewport.name} page: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.locator(".work-row").first().waitFor();
    await page.screenshot({ path: path.join(output, `${viewport.name}.png`) });
    results.push(await inspect(page, `${viewport.name}-dashboard`));

    const targetId = viewport.name === "desktop" ? "signal-1" : "shipped-1";
    await page.locator(`[data-item-id="${targetId}"]`).click();
    await page.locator("#work-dialog[open]").waitFor();
    if (viewport.name === "desktop") {
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Submit 2 answers" }).click();
      await page.locator("#decision-message").waitFor();
      await page.locator("#decision-answer").focus();
    } else {
      await page.getByRole("button", { name: "Evidence" }).click();
    }
    await page.screenshot({ path: path.join(output, `${viewport.name}-modal.png`) });
    results.push(await inspect(page, `${viewport.name}-modal`));
    await page.close();
  }

  const violations = [];
  for (const result of results) {
    if (!result.colorScheme.includes("dark")) violations.push(`${result.surface}: color-scheme is ${result.colorScheme}`);
    if (result.bodyLuminance >= 0.08) violations.push(`${result.surface}: body luminance ${result.bodyLuminance.toFixed(4)} is not below 0.08`);
    if (result.bodyContrast < 4.5 || result.primaryTextContrast < 4.5) violations.push(`${result.surface}: primary text contrast is below WCAG AA`);
    if (result.horizontalOverflow) violations.push(`${result.surface}: horizontal overflow ${result.scrollWidth}px > ${result.viewportWidth}px`);
    if (result.nearWhiteMajorElements.length) violations.push(`${result.surface}: major near-white elements ${JSON.stringify(result.nearWhiteMajorElements)}`);
    for (const [selector, measurement] of Object.entries(result.surfaces)) {
      if (selector !== "body" && measurement.luminance >= 0.15) violations.push(`${result.surface}: ${selector} luminance ${measurement.luminance.toFixed(4)} is not below 0.15`);
    }
  }
  if (!results.find((result) => result.surface === "desktop-modal")?.focused.includes("decision-answer")) violations.push("desktop modal: decision textarea did not retain focus after validation error");
  violations.push(...errors);
  const report = { passed: violations.length === 0, generatedAt: new Date().toISOString(), screenshots: ["desktop.png", "desktop-modal.png", "mobile.png", "mobile-modal.png"], results, violations };
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (violations.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
