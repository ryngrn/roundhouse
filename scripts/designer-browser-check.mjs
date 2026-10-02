import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const target = path.resolve(process.argv[2] ?? "dist");
const root = fs.statSync(target).isDirectory() ? target : path.dirname(target);
const entry = fs.statSync(target).isDirectory() ? "index.html" : path.basename(target);
const evidenceDirectory = process.env.ROUNDHOUSE_EVIDENCE_DIR;
if (!evidenceDirectory) throw new Error("ROUNDHOUSE_EVIDENCE_DIR is required.");
fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });

const types = new Map([[".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"], [".mjs", "text/javascript"], [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".woff2", "font/woff2"]]);
const server = http.createServer((request, response) => {
  const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = requested === "/" ? entry : requested.replace(/^\//, "");
  const filename = path.resolve(root, relative);
  const withinRoot = filename === root || filename.startsWith(`${root}${path.sep}`);
  if (!withinRoot || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": types.get(path.extname(filename)) ?? "application/octet-stream" });
  fs.createReadStream(filename).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
let browser;
try {
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const results = [];
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    const response = await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    const inspection = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const unnamed = [...document.querySelectorAll("a,button,input,select,textarea")].filter((element) => visible(element) && !((element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || element.getAttribute("placeholder") || "").trim()));
      const imagesWithoutAlt = [...document.querySelectorAll("img")].filter((image) => !image.hasAttribute("alt"));
      return {
        title: document.title,
        lang: document.documentElement.lang,
        h1_count: document.querySelectorAll("h1").length,
        unnamed_controls: unnamed.length,
        images_without_alt: imagesWithoutAlt.length,
        horizontal_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        scroll_width: document.documentElement.scrollWidth,
        viewport_width: window.innerWidth,
      };
    });
    const screenshot = path.join(evidenceDirectory, `${viewport.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ viewport: viewport.name, status: response?.status() ?? 0, screenshot, errors, ...inspection });
    await page.close();
  }
  const failed = results.some((result) => result.status >= 400 || !result.title || !result.lang || result.h1_count !== 1 || result.unnamed_controls || result.images_without_alt || result.horizontal_overflow || result.errors.length);
  process.stdout.write(`${JSON.stringify({ passed: !failed, note: "Automated render, overflow, and basic semantic checks; screenshots require agent visual review.", results })}\n`);
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
