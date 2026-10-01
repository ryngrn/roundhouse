import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RoundhouseError } from "./errors.js";

function parseTrace(text) {
  let finalMessage = "";
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalMessage = event.item.text ?? finalMessage;
      }
      if (event.type === "turn.completed") usage = event.usage ?? null;
    } catch {
      // Keep the original trace intact; malformed output is reported if execution fails.
    }
  }
  return { finalMessage, usage };
}

export async function runCodex({ codexBin, repo, prompt, runDir, timeoutMs }) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "prompt.md"), prompt, { mode: 0o600 });

  const args = ["exec", "--json", "--full-auto", "-C", repo, "-"];
  const child = spawn(codexBin, args, {
    cwd: repo,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end(prompt);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));

  fs.writeFileSync(path.join(runDir, "codex.jsonl"), stdout, { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, "codex.stderr.log"), stderr, { mode: 0o600 });
  const parsed = parseTrace(stdout);

  if (timedOut) {
    throw new RoundhouseError("CODEX_TIMEOUT", `Codex exceeded the configured timeout.`, {
      timeoutMs,
      runDir,
    });
  }
  if (exitCode !== 0) {
    throw new RoundhouseError("CODEX_FAILED", `Codex exited with code ${exitCode}.`, {
      exitCode,
      runDir,
      stderr: stderr.slice(-4_000),
    });
  }
  return { exitCode, runDir, ...parsed };
}
