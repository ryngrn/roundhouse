import path from "node:path";
import {pathToFileURL} from "node:url";
import os from "node:os";
const home = os.homedir();
const root = path.join(home, "git/roundhouse/src/workflow");
const load = async (p) => import(pathToFileURL(path.join(root, p)).href);
const [{Store, acquireLock}, {loadWorkflowConfig}, {Engine}] =
  await Promise.all([load("store.js"), load("config.js"), load("engine.js")]);
const runtime = path.join(home, "Library/Application Support/Roundhouse");
const store = new Store(path.join(runtime, "state"));
const config = loadWorkflowConfig(path.join(runtime, "projects.yaml"));
const snapshot = store.read();
const active = [...Object.values(snapshot.items), ...Object.values(snapshot.jobs)].some(x =>
  ["Executing", "Verification", "Rework"].includes(x.state) ||
  (x.state === "Decision" && !x.awaiting_decision));
const targets = Object.values(snapshot.items).filter(x =>
  x.state === "Depot" || (x.state === "Decision" && x.awaiting_decision));
targets.sort((a,b) => {
  const rank = x => x.awaiting_decision ? 0 :
    /^\s*Priority:\s*P0\b/i.test(x.input?.text||"") ? 1 : 2;
  return rank(a)-rank(b) || Date.parse(a.created_at)-Date.parse(b.created_at);
});
const job = targets[0];
if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({mode:"dry-run",active, pending:targets.length, next:job&&{id:job.id,state:job.state,project:job.project_id},configuredDecision:config.decision.kind}));
  process.exit(0);
}
if (active || !job) {
  if (active) console.log(JSON.stringify({status:"deferred",reason:"inflight_work_requires_check"}));
  process.exit(0);
}
let release;
try {
  release=acquireLock(store.workerLock);
} catch(e) {
  if (String(e.message||"").includes("Locked:")) process.exit(0);
  throw e;
}
try {
  const current = store.read().items[job.id];
  if (!current || !(current.state === "Depot" || (current.state === "Decision" && current.awaiting_decision))) {
    process.exitCode=0;
  } else {
    const engine=new Engine({store,config});
    await engine.decide(current.id);
    const updated=store.read().items[current.id];
    console.log(JSON.stringify({status:"triaged",id:current.id,from:current.state,to:updated.state,project:updated.project_id,created_jobs:updated.job_ids?.length||0}));
  }
} finally { if(release) release(); }
