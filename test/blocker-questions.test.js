import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {harness} from "./support/harness.js";
import {Unblocker} from "../src/workflow/unblocker.js";
import {diagnoseBlocker} from "../src/workflow/unblocker.js";
import {statusView,needsHumanView,notificationView} from "../src/workflow/views.js";
import {RoundhouseService} from "../src/workflow/service.js";
import {startRoundhouseServer} from "../src/server/app-server.js";
import {Store} from "../src/workflow/store.js";

const pending=(h)=>Object.values(h.store.read().items).filter(item=>item.blocker_followup);
async function setup() {
  const h=harness();
  const original=h.submit("Implement tested UI update");
  await h.engine.runTriage();
  const item=h.store.read().items[original.id];
  const jobId=item.job_ids[0];
  h.store.change(data=>{
    const j=data.jobs[jobId];
    j.attempts=[{
      number:1,execution:{passed:true,exit_code:0},
      verification:{passed:false,checks:[{id:"feature",passed:false,summary:"Feature did not pass"}]},
    }];
    h.store.move(data,j,"Blocked","Rework limit reached: Required verification failed.");
    data.projects.example={...data.projects.example,blocked:true};
  });
  return {h,jobId,original};
}
test("one root blocker creates one revision-guarded question visible in portal and MCP",async()=>{
  const {h,jobId}=await setup();
  const first=await h.engine.runUnblocker();
  assert.equal(first.questions_created_count,1);
  assert.equal(first.questions_created[0].original_id,jobId);
  const snapshot=h.store.read();
  assert.equal(snapshot.jobs[jobId].state,"Blocked");
  const recovery=pending(h)[0];
  assert.equal(recovery.state,"Needs Clarification");
  assert.equal(recovery.questions.length,1);
  assert.equal(recovery.questions[0].status,"open");
  assert.equal(recovery.questions[0].kind,"clarification");
  assert.match(recovery.questions[0].prompt,/fresh isolated repair/);
  assert.equal(recovery.input.context.blocker_entity_id,jobId);
  const web=statusView(snapshot).items.find(x=>x.id===recovery.id);
  assert.equal(web.needs_you,true);
  assert.equal(web.questions.length,1);
  const chat=needsHumanView(snapshot).questions.find(x=>x.item_id===recovery.id);
  assert.ok(chat);
  assert.equal(chat.revision,1);
  const notices=notificationView(snapshot).notifications;
  assert.ok(notices.some(x=>x.item_id===recovery.id&&x.kind==="needs_you"));
  const second=await h.engine.runUnblocker();
  assert.equal(second.questions_created_count,0);
  assert.equal(pending(h).length,1);
});

test("answer from web decision session is evaluated as a new repair; old failed attempt is never replayed",async(t)=>{
  const {h,jobId}=await setup();
  await h.engine.runUnblocker();
  const repair=pending(h)[0];
  const q=repair.questions[0];
  const service=new RoundhouseService({store:h.store,engine:h.engine});
  const running=await startRoundhouseServer({service,port:0,autoStartWorker:false,wakeSource:{start(){},stop(){}},remoteRelay:null});
  t.after(()=>running.close());
  const post=(route,payload)=>new Promise((resolve,reject)=>{
    const target=new URL(route,running.url);
    const req=http.request(target,{method:"POST",headers:{host:"roundhouse","content-type":"application/json"}},res=>{
      let body="";res.on("data",x=>body+=x);res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on("error",reject);req.end(JSON.stringify(payload));
  });
  const first=await post("/api/items/"+repair.id+"/decision-session",{
    expected_item_revision:repair.revision,
    answers:[{question_id:q.id,expected_revision:q.revision,answer:"Investigate failure and plan an isolated repair. Do not replay the old attempt."}],
  });
  assert.equal(first.status,200,JSON.stringify(first.body));
  const newState=h.store.read();
  const changed=newState.items[repair.id];
  assert.ok(["Ready","Needs Clarification","Review","Blocked"].includes(changed.state));
  assert.equal(changed.questions[0].status,"answered");
  assert.equal(newState.jobs[jobId].state,"Blocked");
  assert.equal(newState.jobs[jobId].attempts.length,1);
  assert.equal(newState.projects.example.blocked,true,
    "An answer may authorize a new evaluated repair, not clear the original project quarantine.");
  assert.equal(changed.clarifications[0].text,"Investigate failure and plan an isolated repair. Do not replay the old attempt.");
  const again=await post("/api/items/"+repair.id+"/decision-session",{
    expected_item_revision:repair.revision,
    answers:[{question_id:q.id,expected_revision:q.revision,answer:"Replay it."}],
  });
  assert.notEqual(again.status,200);
  assert.equal(new Store(h.store.directory).read().jobs[jobId].attempts.length,1);
});

test("multiple dependent Ready jobs do not generate duplicate questions",async()=>{
  const {h,jobId}=await setup();
  h.submit("Next dependent update");
  await h.engine.runTriage();
  const depend=Object.values(h.store.read().jobs).find(x=>x.id!==jobId);
  h.store.change(d=>{d.jobs[depend.id].dependencies=[jobId];});
  const result=await h.engine.runUnblocker();
  assert.equal(result.questions_created_count,1);
  assert.equal(pending(h).length,1);
  assert.equal(h.store.read().jobs[depend.id].state,"Ready");
});

test("root remote outcomes produce a single evidence question without claiming success",async()=>{
  const h=harness();
  const item=h.submit("Repair Kubuntu iMac screen adapter");
  await h.engine.runTriage();
  const job=h.store.read().jobs[h.store.read().items[item.id].job_ids[0]];
  h.config.projects[0].runtime="herdr";
  h.store.change(d=>{
    const j=d.jobs[job.id];
    j.attempts=[{number:1,execution:{remote_execution:{machine_selector:"iMac"}}}];
    h.store.move(d,j,"Blocked","Machine-local Herdr outcome requires explicit reconciliation and will not be replayed automatically.");
  });
  const result=await new Unblocker({store:h.store,config:h.config}).run();
  assert.equal(result.questions_created_count,1);
  const question=pending(h)[0].questions[0].prompt;
  assert.match(question,/verified commit\/branch/);
  assert.match(question,/No replay/);
  assert.equal(h.store.read().jobs[job.id].state,"Blocked");
  assert.equal(h.store.read().jobs[job.id].shipping,undefined);
});

test("blocked recovery follow-ups never recursively spawn more follow-ups",async()=>{
  const {h}=await setup();
  await h.engine.runUnblocker();
  const repair=pending(h)[0];
  h.store.change(d=>{h.store.move(d,d.items[repair.id],"Blocked","Recovery decision could not be evaluated.");});
  const subsequent=await h.engine.runUnblocker();
  assert.equal(subsequent.questions_created_count,0);
  assert.equal(pending(h).length,1);
});

test("at most three new questions per pass; no file-store writes on fully idle repeat",async()=>{
  const {h}=await setup();
  const original=h.store.read().jobs;
  const firstJob=Object.values(original)[0];
  h.store.change(d=>{
    for(let i=1;i<=5;i++){
      const id="blocked-extra-"+i;
      d.jobs[id]={...structuredClone(d.jobs[firstJob.id]),id,parent_id:firstJob.parent_id,revision:1,
        attempts:[{number:1,execution:{remote_execution:{machine_selector:"iMac"}}}],
        history:[{from:"Executing",to:"Blocked",reason:"Uncertain machine-local Herdr outcome.",at:new Date().toISOString()}],
        state:"Blocked"};
    }
  });
  const a=await h.engine.runUnblocker();assert.equal(a.questions_created_count,3);
  const b=await h.engine.runUnblocker();assert.equal(b.questions_created_count,3);
  const file=path.join(h.store.directory,"state.json");
  const before=fs.readFileSync(file);
  const c=await h.engine.runUnblocker();
  const after=fs.readFileSync(file);
  assert.equal(c.questions_created_count,0);
  assert.deepEqual(before,after);
});


test("a repeated already-answered decision does not generate a second human question", async()=>{
  const h=harness();
  const i=h.submit("already answered decision");
  h.store.change(d=>{
    d.items[i.id].questions=[{id:"question-old",revision:2,status:"answered",decision_key:"fixture:resolved",kind:"clarification",prompt:"Resolved decision"}];
    h.store.move(d,d.items[i.id],"Blocked","Decision provider repeated already resolved decision fixture:resolved.");
  });
  const r=await h.engine.runUnblocker();
  assert.equal(r.questions_created_count,0);
  assert.equal(pending(h).length,0);
  assert.equal(h.store.read().items[i.id].state,"Blocked");
});
