import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { loadWorkflowConfig } from "./config.js";
import { pickup, updates, acknowledge } from "./notion-bridge.js";
import { submitToDepot } from "./intake-contract.js";
import { statusView } from "./views.js";

export { statusView } from "./views.js";

export function notionInput(raw, projects) {
  const props = raw.properties ?? raw;
  const value = (name) => {
    const v = props[name];
    if (typeof v === "string") return v;
    if (v?.select) return v.select.name;
    if (v?.rich_text || v?.title) return (v.rich_text ?? v.title).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
    return "";
  };
  const url = raw.url ?? props.url;
  if (typeof url !== "string" || !/^https:\/\/(?:app\.)?notion\.(?:com|so)\//.test(url)) throw new Error("Notion import requires a source page URL.");
  const name = value("Project");
  const matches = projects.filter((p) => p.name === name || p.id === name);
  if (name && name !== "Unassigned" && matches.length !== 1) throw new Error("Notion Project does not map uniquely to a configured project.");
  return { text: value("Raw Intake") || value("Normalized Brief") || value("Item"), source: url,
    actor: "notion-bridge", ...(matches.length === 1 ? { project_id: matches[0].id } : {}),
    context: { title: value("Item"), outcome: value("Outcome"), acceptance_criteria: value("Acceptance Criteria"), content: raw.content ?? "" } };
}

export async function depotCommand(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    pickup: ["--state-dir", "--config", "--input"],
    "notion-updates": ["--state-dir"],
    "notion-ack": ["--state-dir", "--input"],
    submit: ["--state-dir", "--input", "--key", "--text", "--project", "--config", "--notion"],
    run: ["--state-dir", "--config", "--project"],
    status: ["--state-dir"], outbox: ["--state-dir"],
    approve: ["--state-dir", "--config", "--id", "--revision", "--actor"],
    clarify: ["--state-dir", "--config", "--id", "--text", "--actor", "--project"],
    stop: ["--state-dir", "--project"], resume: ["--state-dir", "--project", "--actor", "--note"],
    recover: ["--state-dir"],
  };
  if (!allowed[command]) throw new Error("Usage: roundhouse depot <submit|run|status|outbox|approve|clarify|stop|resume|recover> --state-dir <path> [...]");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed[command].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--") || options[rest[i]]) throw new Error(`Invalid option ${rest[i]}`);
    options[rest[i]] = rest[i + 1];
  }
  const required = (key) => { if (!options[key]) throw new Error(`${command} requires ${key}.`); return options[key]; };
  const store = new Store(required("--state-dir"));
  if (command === "pickup") return pickup(store, JSON.parse(fs.readFileSync(required("--input"), "utf8")), loadWorkflowConfig(required("--config")).projects, notionInput);
  if (command === "notion-updates") return updates(store.read(), statusView);
  if (command === "notion-ack") return acknowledge(store, JSON.parse(fs.readFileSync(required("--input"), "utf8")), statusView);
  if (command === "status") return statusView(store.read());
  if (command === "outbox") {
    const data = store.read();
    return { events: data.outbox, current: statusView(data) };
  }
  if (command === "recover") return statusView(store.recover());
  if (["stop", "resume"].includes(command)) {
    const id = required("--project");
    return store.change((data) => {
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
    const modes = [options["--input"], options["--text"], options["--notion"]].filter(Boolean);
    if (modes.length !== 1) throw new Error("Use exactly one of --input, --text, --notion.");
    let input;
    if (options["--notion"]) input = notionInput(JSON.parse(fs.readFileSync(options["--notion"], "utf8")), loadWorkflowConfig(required("--config")).projects);
    else input = options["--input"] ? JSON.parse(fs.readFileSync(options["--input"], "utf8")) : { text: options["--text"], source: "cli", actor: "operator" };
    if (options["--project"]) input.project_id = options["--project"];
    const item = submitToDepot(store, input, options["--key"] ?? (options["--notion"] ? input.source : required("--key")), { source: "cli", actor: "operator" });
    return { id: item.id, state: item.state, message: "Saved in Depot. Run the worker to interpret and execute eligible work." };
  }
  const engine = new Engine({ store, config: loadWorkflowConfig(path.resolve(required("--config"))) });
  if (command === "approve") return engine.approve(required("--id"), Number(required("--revision")), required("--actor"));
  if (command === "clarify") return engine.clarify(required("--id"), required("--text"), required("--actor"), options["--project"]);
  const result = await engine.run({ projectId: options["--project"] });
  return { executed: result.executed, limit_reached: result.limit_reached, ...statusView(result) };
}
