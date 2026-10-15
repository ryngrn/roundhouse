import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const provider = path.resolve('scripts/hermes-research-provider.mjs');
const run=(input,bin)=>spawnSync(process.execPath,[provider],{input,encoding:'utf8',env:{...process.env,ROUNDHOUSE_HERMES_BIN:bin,ROUNDHOUSE_HERMES_MODEL:'roundhouse-local'},timeout:10000});
test('rejects malformed or ineligible work before model execution',()=>{
  assert.notEqual(run('broken','/does/not/exist').status,0);
  assert.notEqual(run(JSON.stringify({work:{},run:{},provider:{capabilities:['local']}}),'/does/not/exist').status,0);
});
test('wraps model output in explicitly unverified research record',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'hermes-test-'));
  const stub=path.join(dir,'hermes');
  writeFileSync(stub,'#!/bin/sh\necho "Test model response"\n',{mode:0o755});
  const result=run(JSON.stringify({work:{title:'example'},run:{id:'a'},project_context:{},provider:{id:'hermes-test',capabilities:['research']}}),stub);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.summary,'Test model response');
  assert.equal(output.verification,'unverified_research_output');
  assert.equal(output.provider_id,'hermes-test');
});
