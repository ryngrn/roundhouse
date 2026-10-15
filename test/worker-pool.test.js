import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleWorkers } from '../src/workflow/worker-pool.js';
const now=Date.parse('2026-10-15T20:00:00Z');
const node=(id,status,age,capabilities)=>({id,status,last_heartbeat_at:new Date(now-age).toISOString(),capabilities});
test('available workers require full capability match, fresh heartbeats, and online status',()=>{
  const nodes=[node('studio','online',1000,['research','artifact']),node('imac','online',2000,['research','artifact']),node('old','online',100000,['research','artifact']),node('offline','offline',1000,['research','artifact']),node('partial','online',1000,['research'])];
  assert.deepEqual(eligibleWorkers(nodes,['research','artifact'],{now}).map(n=>n.id),['imac','studio']);
  assert.deepEqual(eligibleWorkers(nodes,['missing'],{now}),[]);
});
test('future heartbeats and invalid age threshold never advertise capacity',()=>{
  assert.deepEqual(eligibleWorkers([node('future','online',-1000,['research'])],['research'],{now}),[]);
  assert.throws(()=>eligibleWorkers([],[],{maxAgeMs:0}));
});
