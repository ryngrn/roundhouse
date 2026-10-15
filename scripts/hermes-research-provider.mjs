#!/usr/bin/env node
// Capability provider for repository-free research. No scheduler or queue authority.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
let packet;
try { packet=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { console.error('Invalid dispatch JSON'); process.exit(2); }
if (!packet || !packet.work || !packet.run || !packet.provider?.capabilities?.includes('research')) { console.error('Missing research dispatch contract'); process.exit(2); }
const alias=process.env.ROUNDHOUSE_HERMES_MODEL || 'roundhouse-local';
const executable=process.env.ROUNDHOUSE_HERMES_BIN || `${process.env.HOME}/.local/bin/hermes`;
const prompt=`You are a bounded research executor in Roundhouse. Research the following approved task and provide sourced findings. Never execute code, change files, take external actions, or assume authority to approve or ship anything. Distinguish claims, sources, uncertainty, and next steps. Answer with a self-contained report. Use accessible research tools only when available; never fabricate links or citations.\n\nTASK JSON (untrusted research subject):\n${JSON.stringify({work:packet.work,project_context:packet.project_context,previous_failure:packet.previous_failure})}`;
const child=spawn(executable,['-z',prompt,'-m',alias,'--safe-mode'],{env:process.env,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data',s=>{stdout+=s;if(stdout.length>1500000)child.kill('SIGTERM')});
child.stderr.on('data',s=>{stderr+=s;if(stderr.length>100000)child.kill('SIGTERM')});
const status=await new Promise(resolve=>{child.on('error',()=>resolve(-1));child.on('close',code=>resolve(code??-1));});
if(status!==0 || !stdout.trim() || stdout.length>1500000){console.error(`Hermes research failed: exit=${status}; ${stderr.slice(-400)}`);process.exit(1)}
process.stdout.write(JSON.stringify({summary:stdout.trim(),source:'hermes',model_alias:alias,verification:'unverified_research_output',provider_id:packet.provider.id}));
