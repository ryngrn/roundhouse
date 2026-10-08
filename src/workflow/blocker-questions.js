/**
 * Creates one durable, actionable human question per root blocker.
 *
 * A recovery question is a NEW intake item. Answering it goes through the
 * established revision-guarded decision flow; no blocked attempt is replayed.
 */
import { randomUUID } from "node:crypto";
import { digest } from "../storage/repository.js";
import { record, transition } from "./state.js";

const MAX_PER_PASS = 3;
const short = (value, max = 145) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const titleOf = (entity, parent) => short(entity.work?.title ||
  parent?.legacy_depot?.Item || parent?.input?.context?.title ||
  parent?.input?.text?.split("\n")[0] || entity.id, 100);

function questionFor(entity, parent, diagnosis) {
  const title = titleOf(entity, parent);
  const reason = short(entity.history?.at(-1)?.reason, 200);
  if (diagnosis.category === "stale_context" || /policy or context changed/i.test(reason))
    return 'For "' + title + '", should Roundhouse re-evaluate the plan using current project settings, or keep it held?';
  if (diagnosis.category === "isolated_verification_failure" || /verification failed/i.test(reason)) {
    const checks=(entity.attempts?.at(-1)?.verification?.checks ?? [])
      .filter(c=>c.passed===false).map(c=>c.id).slice(0,3);
    return 'For "' + title + '"' + (checks.length ? ' (failed checks: ' + checks.join(", ") + ')' : '') +
      ', should Roundhouse investigate and propose a fresh isolated repair, or keep it held?';
  }
  if (/Locked:|repository.lock|another worker/i.test(reason))
    return 'For "' + title + '", should Roundhouse investigate the repository lock and confirm whether the owner is active, or leave it held?';
  if (diagnosis.category === "remote_or_external_outcome" ||
      diagnosis.category === "delivery_or_outcome_uncertain" || /herdr|remote.*evidence|completion report/i.test(reason))
    return 'Did "' + title + '" actually finish remotely? Provide a verified commit/branch, or answer "unknown—investigate only". No replay will occur from this answer.';
  if (/reconciliation was refused|no exact durable/i.test(reason))
    return 'Is "' + title + '" new work requiring a repair plan, or completed existing work? If complete, provide its exact Roundhouse job ID.';
  if (/capability|not configured|no repository|worktree|routable/i.test(reason))
    return 'Should Roundhouse plan the missing execution capability for "' + title + '", or keep this as non-executable future work?';
  return 'What should Roundhouse do about "' + title +
    '"? Choose investigate and propose a fresh repair, keep held, or provide exact evidence of completion.';
}

function blockerRoots(data, config, diagnose) {
  const projects=new Map(config.projects.map(p=>[p.id,p]));
  const jobs=Object.values(data.jobs ?? {}).filter(j=>j.state==="Blocked").map(entity=>({
    entity, parent:data.items[entity.parent_id],kind:"job",
    diagnosis:diagnose(entity,projects.get(entity.project_id)),
  }));
  const items=Object.values(data.items ?? {})
    .filter(i=>i.state==="Blocked" && !(i.job_ids?.length) && !i.blocker_followup &&
      i.input?.source!=="roundhouse:unblocker" &&
      !/repeated already resolved decision|already resolved decision/i.test(i.history?.at(-1)?.reason ?? ""))
    .map(entity=>({
      entity,parent:entity,kind:"item",
      diagnosis:{category:"unplanned_blocked_intake",action:"human_review"},
    }));
  return [...jobs,...items];
}
const questionIdFor=(root)=>digest("unblocker-root-question:v1:"+root.kind+":"+root.entity.id).slice(0,24);

export function pendingBlockerQuestions(data,config,diagnose) {
  return blockerRoots(data,config,diagnose).filter(root=>!data.items[questionIdFor(root)]);
}

export function createBlockerQuestions(data,config,diagnose,{limit=MAX_PER_PASS}={}) {
  if (!Number.isInteger(limit)||limit<0||limit>MAX_PER_PASS)throw new Error("Unblocker question limit must be 0–3.");
  const created=[];
  for (const root of pendingBlockerQuestions(data,config,diagnose).slice(0,limit)) {
    const {entity,parent,kind,diagnosis}=root;
    const id=questionIdFor(root);
    const prompt=questionFor(entity,parent,diagnosis);
    const title=titleOf(entity,parent);
    const originalReason=short(entity.history?.at(-1)?.reason,1200);
    const at=new Date().toISOString();
    const input={
      text:[
        "Recovery decision: "+title,
        "Original "+kind+": "+entity.id+" (project: "+(entity.project_id??"unassigned")+")",
        "Recorded blocker: "+originalReason,
        "Question: "+prompt,
        "Evaluate the human answer as a new, independently verified recovery plan. Inspect existing attempts and exact delivery evidence first. Do not replay, mark the original work shipped, clear a safety hold, change permissions, or perform destructive actions based solely on an answer. If the answer selects a repair, plan a separate task under current project policy; never assume the original failed job is safe to rerun. If the answer chooses keep held, archive this recovery decision without creating new jobs and retain the original blocker.",
      ].join("\n\n"),
      source:"roundhouse:unblocker",
      actor:"roundhouse-unblocker",
      ...(entity.project_id?{project_id:entity.project_id}:{}),
      context:{
        title:"Recovery: "+title,blocker_entity_id:entity.id,
        blocker_entity_type:kind,blocker_category:diagnosis.category,
        blocker_reason:originalReason,
        originating_item_id:kind==="job"?entity.parent_id:entity.id,
        conversation_id:parent?.input?.metadata?.conversation_id ??
          parent?.input?.metadata?.thread_id ?? null,
      },
    };
    const item=record(id,{
      input,project_id:entity.project_id??null,
      selected_project:entity.project_id??null,
      clarifications:[],questions:[],decision:null,decision_history:[],job_ids:[],
      blocker_followup:{original_id:entity.id,kind,category:diagnosis.category,at},
    });
    data.items[id]=item;
    item.questions.push({
      id:id+":question:1",decision_id:id+":decision:1",
      decision_key:"unblocker:"+kind+":"+entity.id,
      revision:1,status:"open",kind:"clarification",
      prompt,created_at:at,updated_at:at,
    });
    transition(item,"Decision","Unblocker identified a root blocker.");
    const event=transition(item,"Needs Clarification",prompt);
    data.outbox??=[];
    data.outbox.push({
      id:randomUUID(),entity_id:id,item_id:id,source:input.source,
      state:"Needs Clarification",reason:prompt,at:event.at,delivered:false,
    });
    created.push({item_id:id,original_id:entity.id,project_id:entity.project_id??null,
      question_id:item.questions[0].id,prompt});
  }
  return created;
}
