import fs from "node:fs";
import path from "node:path";
import { Engine } from "./engine.js";
import { loadWorkflowConfig } from "./config.js";
import { submitToDepot } from "./intake-contract.js";
import { statusView } from "./views.js";
import { openStorage } from "../storage/open.js";

export { statusView } from "./views.js";

export async function depotCommand(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    submit: ["--state-dir", "--input", "--key", "--text", "--project"],
    run: ["--state-dir", "--config", "--project"],
    triage: ["--state-dir", "--config", "--project", "--limit"],
    status: ["--state-dir"], outbox: ["--state-dir"],
    approve: ["--state-dir", "--config", "--id", "--revision", "--actor"],
    clarify: ["--state-dir", "--config", "--id", "--text", "--actor", "--project"],
    "reevaluate-import": ["--state-dir", "--config", "--id", "--revision", "--actor"],
    "retry-triage": ["--state-dir", "--config", "--id", "--revision", "--actor"],
    "reconcile-job": ["--state-dir", "--config", "--id", "--actor", "--note", "--commit", "--branch"],
    "refresh-job-context": ["--state-dir", "--config", "--id", "--actor"],
    stop: ["--state-dir", "--project"], resume: ["--state-dir", "--project", "--actor", "--note"],
    recover: ["--state-dir"],
  };
  if (!allowed[command]) throw new Error("Usage: roundhouse depot <submit|triage|run|status|outbox|approve|clarify|reevaluate-import|retry-triage|reconcile-job|refresh-job-context|stop|resume|recover> --state-dir <path> [...]");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed[command].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--") || options[rest[i]]) throw new Error(`Invalid option ${rest[i]}`);
    options[rest[i]] = rest[i + 1];
  }
  const required = (key) => { if (!options[key]) throw new Error(`${command} requires ${key}.`); return options[key]; };
  const store = await openStorage({ directory: required("--state-dir") });
  try {
  if (command === "status") return statusView(await store.read());
  if (command === "outbox") {
    const data = await store.read();
    return { events: data.outbox, current: statusView(data) };
  }
  if (command === "recover") {
    if (store.shared) await store.recoverExpiredClaims();
    else store.recover();
    return statusView(await store.read());
  }
  if (["stop", "resume"].includes(command)) {
    const id = required("--project");
    return await store.change((data) => {
      const state = data.projects[id] ?? {};
      if (command === "resume") {
        if (state.blocked) required("--note");
        state.resume_approval = { actor: required("--actor"), note: options["--note"] ?? "", at: new Date().toISOString() };
        state.blocked = false;
      }
      data.projects[id] = { ...state, stop: command === "stop", review_required: command === "resume" ? false : state.review_required };
      return data.projects[id];
    });
  }
  if (command === "submit") {
    const modes = [options["--input"], options["--text"]].filter(Boolean);
    if (modes.length !== 1) throw new Error("Use exactly one of --input or --text.");
    const input = options["--input"] ? JSON.parse(fs.readFileSync(options["--input"], "utf8")) : { text: options["--text"], source: "cli", actor: "operator" };
    if (options["--project"]) input.project_id = options["--project"];
    const item = await submitToDepot(store, input, required("--key"), { source: "cli", actor: "operator" });
    return { id: item.id, state: item.state, message: "Saved in Depot. Run the worker to interpret and execute eligible work." };
  }
  const engine = new Engine({ store, config: loadWorkflowConfig(path.resolve(required("--config"))) });
  if (command === "approve") return await engine.approve(required("--id"), Number(required("--revision")), required("--actor"));
  if (command === "clarify") return await engine.clarify(required("--id"), required("--text"), required("--actor"), options["--project"]);
  if (command === "reevaluate-import") return engine.reevaluateImported(required("--id"), Number(required("--revision")), required("--actor"));
  if (command === "retry-triage") return engine.retryTriage(required("--id"), Number(required("--revision")), required("--actor"));
  if (command === "reconcile-job") return engine.reconcileJob(required("--id"), { actor: required("--actor"), note: required("--note"), commit: required("--commit"), branch: required("--branch") });
  if (command === "refresh-job-context") return engine.refreshJobContext(required("--id"), { actor: required("--actor") });
  if (command === "triage") {
    const limit = options["--limit"] === undefined ? Infinity : Number(options["--limit"]);
    if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) throw new Error("--limit must be a positive integer.");
    const result = await engine.runTriage({ projectId: options["--project"], limit });
    return { triaged: result.triaged, triage_limit_reached: result.triage_limit_reached, ...statusView(result) };
  }
  const result = await engine.run({ projectId: options["--project"] });
  return { executed: result.executed, limit_reached: result.limit_reached, ...statusView(result) };
  } finally {
    await store.close();
  }
}
