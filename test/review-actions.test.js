import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./support/harness.js";
import { RoundhouseService } from "../src/workflow/service.js";
import { WorkerLoop } from "../src/server/worker.js";

function reviewFixture(t, target = "Needs Clarification") {
  const h = harness();
  t.after(() => h.store && h.root && import("node:fs").then(fs => fs.rmSync(h.root, {recursive:true,force:true})));
  const item = h.submit("A meaningful project outcome", "review-actions-"+target);
  h.store.change(data => {
    const entity=data.items[item.id];
    h.store.move(data,entity,"Decision","Review requested.");
    if(target==="Needs Clarification") h.store.move(data,entity,"Needs Clarification","Scope needs input.");
    else if(target==="Review") h.store.move(data,entity,"Review","Plan awaits review.");
    else if(target==="Blocked") h.store.move(data,entity,"Blocked","Something went wrong.");
  });
  return {h,id:item.id,service:new RoundhouseService({store:h.store,engine:h.engine})};
}

test("Retire preserves the original item and audit history without replay or deletion", async t => {
  const {h,id,service}=reviewFixture(t,"Review");
  const revision=h.store.read().items[id].revision;
  const result=await service.reviewAction({item_id:id,expected_revision:revision,choice:"retire",actor:"ryan"});
  assert.equal(result.retired,true);
  assert.equal(result.result.state,"Archived");
  const item=h.store.read().items[id];
  assert.equal(item.state,"Archived");
  assert.equal(item.input.text,"A meaningful project outcome");
  assert.equal(item.job_ids.length,0);
  assert.ok(item.history.some(event=>event.reason.includes("Retired by ryan")));
  await assert.rejects(service.reviewAction({item_id:id,expected_revision:revision,choice:"retire"}),/changed/i);
});

test("Change uses a revision-guarded, nonexecuting replan path",async t=>{
  const {h,id,service}=reviewFixture(t,"Review");
  const revision=h.store.read().items[id].revision;
  const changed=await service.reviewAction({item_id:id,expected_revision:revision,choice:"change",note:"Keep this limited to research.",actor:"ryan"});
  assert.equal(changed.action,"replanning");
  const item=h.store.read().items[id];
  assert.equal(item.state,"Decision");
  assert.equal(item.awaiting_decision,true);
  assert.equal(item.job_ids.length,0);
  assert.ok(item.clarifications.some(c=>c.text==="Keep this limited to research."));
  await assert.rejects(service.reviewAction({item_id:id,expected_revision:revision,choice:"change",note:"A second change"}),/changed/i);
});

test("Approve refuses non-reviewable work without recording authorization",async t=>{
  const {h,id,service}=reviewFixture(t);
  const original=h.store.read().items[id];
  await assert.rejects(service.reviewAction({item_id:id,expected_revision:original.revision,choice:"approve"}),/not prepared|no approvable/i);
  const item=h.store.read().items[id];
  assert.equal(item.revision,original.revision);
  assert.equal(item.approval,undefined);
  assert.deepEqual(item.job_ids,[]);
});

test("Blocked cleanup option maps one Approve decision to exact existing option, not execution",async t=>{
  const {h,id,service}=reviewFixture(t,"Blocked");
  h.store.change(data=>{
    data.items[id].issue_resolution={status:"waiting",question:"What next?",options:[
      {id:"replan",label:"Replan useful outcome",description:"Find a smaller verified step.",resolution:"repurpose",
        effects:["Keep original failed attempt intact"]},
      {id:"delete",label:"Delete unverified work",resolution:"delete"},
      {id:"custom",label:"Take my path"}]};
  });
  const original=h.store.read().items[id];
  const result=await service.reviewAction({item_id:id,expected_revision:original.revision,choice:"approve",actor:"ryan"});
  assert.equal(result.action,"approved_existing_resolution");
  assert.equal(result.execution_approved,false);
  const item=h.store.read().items[id];
  assert.equal(item.issue_resolution.status,"answered");
  assert.match(item.issue_resolution.response.message,/Replan useful outcome/);
  assert.equal(item.approval,undefined);
});

test("Approve for a real Review item applies existing execution guards and creates ready work without deployment",async t=>{
  const h=harness();
  t.after(()=>import("node:fs").then(fs=>fs.rmSync(h.root,{recursive:true,force:true})));
  const item=h.submit("requires approval","review-action-approve");
  await h.engine.runTriage();
  const prepared=h.store.read().items[item.id];
  assert.equal(prepared.state,"Review");
  const service=new RoundhouseService({store:h.store,engine:h.engine});
  const result=await service.reviewAction({item_id:item.id,expected_revision:prepared.revision,choice:"approve",actor:"ryan"});
  assert.equal(result.accepted,true);
  assert.equal(result.action,"execution_approved");
  const current=h.store.read().items[item.id];
  assert.equal(current.state,"Ready");
  assert.ok(current.job_ids.length);
  assert.equal(Object.values(h.store.read().jobs).every(job=>job.state==="Ready"),true);
  assert.equal(current.approval.actor,"ryan");
  await assert.rejects(service.reviewAction({item_id:item.id,expected_revision:prepared.revision,choice:"approve"}),/changed/i);
});

test("Change answers only the first question and never demands an entire decision session",async t=>{
 const {h,id,service}=reviewFixture(t,"Needs Clarification");
 h.store.change(data=>{
  const item=data.items[id];
  item.questions=[
   {id:"first-q",revision:1,status:"open",prompt:"Choose theme",decision_key:"theme",kind:"clarification"},
   {id:"second-q",revision:1,status:"open",prompt:"Choose audience",decision_key:"audience",kind:"clarification"},
  ];
 });
 let answerPayload;
 service.answerQuestion=async payload=>{answerPayload=payload;return {accepted:true}};
 const original=h.store.read().items[id];
 const result=await service.reviewAction({item_id:id,expected_revision:original.revision,choice:"change",note:"Parents first"});
 assert.equal(result.action,"direction_answered");
 assert.deepEqual({id:answerPayload.id,answer:answerPayload.answer,expected_revision:answerPayload.expected_revision},
  {id:"first-q",answer:"Parents first",expected_revision:1});
 assert.equal(h.store.read().items[id].state,"Needs Clarification","the delegated action owns the state transition");
});

test("Started failed-job Retire only records the verified cleanup choice, without replaying the attempt",async t=>{
 const {h,id,service}=reviewFixture(t,"Review");
 h.store.change(data=>{
  const parent=data.items[id];
  const jobId=id+"-1";
  parent.job_ids=[jobId];
  data.jobs[jobId]={
   id:jobId,parent_id:id,project_id:"example",state:"Blocked",revision:4,
   history:[{from:"Verification",to:"Blocked",reason:"Required checks failed",at:"2026-10-14"}],
   attempts:[{number:1,verification:{passed:false}}],
   work:{title:"Legacy attempt"},dependencies:[],
   issue_resolution:{status:"waiting",question:"Preserve or remove?",
    impact:{direct_dependents:[],descendants:[]},
    options:[{id:"delete-unverified-attempt",label:"Retire unverified job",
      description:"Remove without claiming success",effects:["Preserve audit"],resolution:"delete"}]}
  };
 });
 const idJob=id+"-1";
 const original=h.store.read().jobs[idJob];
 const res=await service.reviewAction({item_id:idJob,expected_revision:original.revision,choice:"retire",actor:"ryan"});
 assert.equal(res.action,"retirement_requested");
 assert.equal(res.retired,false);
 const after=h.store.read().jobs[idJob];
 assert.equal(after.state,"Blocked");
 assert.equal(after.attempts.length,1);
 assert.equal(after.issue_resolution.status,"answered");
 assert.equal(after.issue_resolution.response.actor,"ryan");
 assert.equal(h.store.read().items[id].job_ids.length,1);
});

test("Retire refuses dependent or started jobs without a verified cleanup option",async t=>{
  const {h,id,service}=reviewFixture(t,"Blocked");
  h.store.change(data=>{
    const child=data.items[id]; child.job_ids=["unrelated-live-job"];
    data.jobs["unrelated-live-job"]={id:"unrelated-live-job",state:"Ready",revision:1,dependencies:[],parent_id:id};
  });
  const revision=h.store.read().items[id].revision;
  await assert.rejects(service.reviewAction({item_id:id,expected_revision:revision,choice:"retire",actor:"ryan"}),/dependent/);
  assert.equal(h.store.read().items[id].state,"Blocked");
});

test("Worker remote queue handles review_action and reports outcome only after authority accepted",async()=>{
  const finished=[];
  const commands=[{id:"review-one",kind:"review_action",payload:{item_id:"review-id",expected_revision:3,choice:"change",note:"Update scope."}}];
  const worker=new WorkerLoop({service:{reviewAction:async input=>({accepted:true,id:input.item_id,choice:input.choice})},
    commandQueue:{claimRemoteCommand:async()=>commands.shift()??null,finishRemoteCommand:async(id,r)=>finished.push({id,...r})}});
  const run=await worker.remoteCommandTick();
  assert.equal(run.remote_commands,1);
  assert.deepEqual(finished[0],{id:"review-one",result:{accepted:true,id:"review-id",choice:"change"}});
});
