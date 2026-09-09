import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgentSnapshot,agentDisplayState,displayAgentStages,agentElapsed,agentFailurePresentation} from '../src/lib/agentConnection.js';
test('HTML gateway errors retain HTTP diagnostic, not HTML content',async()=>{
 await assert.rejects(readAgentSnapshot(new Response('<!DOCTYPE html><h1>gateway</h1>',{status:502,headers:{'content-type':'text/html','cf-ray':'test'}})),/HTTP 502.*text\/html.*HTML response/);
});
test('connection loss freezes last status without claiming execution failure; recovery clears it',async()=>{
 const old={project:{status:'running',createdAt:'2026-09-08T00:00:00Z'},_observedAt:Date.parse('2026-09-08T00:01:00Z'),_connectionError:'HTML response'};
 assert.equal(agentElapsed(old),60);
 assert.equal(agentDisplayState(old).failed,false);
 assert.equal(displayAgentStages([{state:'active'}],agentDisplayState(old))[0].state,'unknown');
 const next=await readAgentSnapshot(Response.json({project:{status:'running'}}));
 assert.equal(agentDisplayState(next).disconnected,false);
});
test('confirmed backend failure overrides stale running stage and freezes time',()=>{
 const s={project:{status:'failed',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:02:00Z',lastError:'copy request failed'},activeJob:{status:'failed'},_connectionError:'network'};
 const state=agentDisplayState(s);
 assert.equal(state.disconnected,false);assert.equal(state.failed,true);assert.equal(agentElapsed(s),120);
 assert.deepEqual(displayAgentStages([{state:'complete'},{state:'active'},{state:'active'},{state:'pending'}],state).map(x=>x.state),['complete','failed','pending','pending']);
 assert.equal(agentFailurePresentation(s,'完善客户版行程文案').userMessage,'文案生成失败');
});
test('completed generation freezes elapsed time and removes stale active stages',()=>{
 const s={project:{status:'complete',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:03:00Z'},executionRun:{status:'complete',updatedAt:'2026-09-08T00:03:00Z'}};
 const state=agentDisplayState(s);
 assert.equal(state.completed,true);assert.equal(agentElapsed(s,Date.parse('2026-09-08T01:00:00Z')),180);
 assert.deepEqual(displayAgentStages([{state:'complete'},{state:'active'},{state:'pending'}],state).map(x=>x.state),['complete','complete','complete']);
});
test('invalid JSON and JSON errors cannot masquerade as snapshots',async()=>{
 await assert.rejects(readAgentSnapshot(Response.json({error:'failure'},{status:500})),/HTTP 500/);
 await assert.rejects(readAgentSnapshot(Response.json({})),/missing project status/);
});
