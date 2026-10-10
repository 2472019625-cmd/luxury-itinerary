import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgentSnapshot,simpleRenderedEditorState,simpleEditableEditorState,agentDisplayState,displayAgentStages,agentElapsed,agentFailurePresentation} from '../src/lib/agentConnection.js';
test('HTML gateway errors retain HTTP diagnostic, not HTML content',async()=>{
 await assert.rejects(readAgentSnapshot(new Response('<!DOCTYPE html><h1>gateway</h1>',{status:502,headers:{'content-type':'text/html','cf-ray':'test'}})),/HTTP 502.*text\/html.*HTML response/);
});
test('connection loss freezes elapsed time but preserves the last known business stage; recovery clears it',async()=>{
 const old={project:{status:'running',createdAt:'2026-09-08T00:00:00Z'},_observedAt:Date.parse('2026-09-08T00:01:00Z'),_connectionError:'HTML response'};
 assert.equal(agentElapsed(old),60);
 assert.equal(agentDisplayState(old).failed,false);
 assert.equal(displayAgentStages([{state:'active'}],agentDisplayState(old))[0].state,'active');
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
test('rendered simple draft opens the editor despite catalog/runtime status wording differences',()=>{
 // The batch waited one minute before starting; editing later must not extend it.
 const s={project:{flowKind:'simple_skill_v1',status:'partial',activeExecutionRunId:'run-1',createdAt:'2026-09-08T00:00:00Z',updatedAt:'2026-09-08T00:30:00Z'},executionRun:{executionRunId:'run-1',status:'partial',createdAt:'2026-09-08T00:01:00Z',updatedAt:'2026-09-08T00:12:00Z'},activeJob:{status:'awaiting_user_action',createdAt:'2026-09-08T00:01:00Z',startedAt:'2026-09-08T00:01:00Z',updatedAt:'2026-09-08T00:10:00Z'},result:{data:{title:'draft'},outputPath:'draft-2000.png',render:{status:'success',mode:'draft',outputPath:'draft-2000.png'}}};
 assert.equal(simpleRenderedEditorState(s),'draft');
 assert.equal(agentDisplayState(s).draft,true);
 assert.equal(agentDisplayState(s).failed,false);
 assert.equal(agentElapsed(s,Date.parse('2026-09-08T01:00:00Z')),540);
});
test('a blocked final render keeps saved content editable but does not masquerade as a rendered draft',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'partial',createdAt:'2026-09-08T00:00:00Z'},executionRun:{status:'partial'},activeJob:{status:'awaiting_user_action'},result:{data:{title:'draft'},outputPath:null,render:{status:'blocked',mode:'final',outputPath:null}}};
 assert.equal(simpleRenderedEditorState(s),null);
 assert.equal(simpleEditableEditorState(s),'draft');
 assert.equal(agentDisplayState(s).draft,true);
 assert.equal(agentDisplayState(s).renderFailed,true);
 assert.equal(agentDisplayState(s).failed,false);
 assert.equal(agentDisplayState(s).completed,false);
});
test('render failure never opens an unfinished, cancelled or mismatched run',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'partial',activeExecutionRunId:'current'},executionRun:{executionRunId:'current',status:'partial'},activeJob:{status:'partial'},result:{data:{title:'draft'},render:{status:'failed'}}};
 assert.equal(simpleEditableEditorState(s),'draft');
 assert.equal(simpleEditableEditorState({...s,activeJob:{status:'running'}}),null);
 assert.equal(simpleEditableEditorState({...s,project:{...s.project,status:'cancelled'}}),null);
 assert.equal(simpleEditableEditorState({...s,executionRun:{...s.executionRun,executionRunId:'old'}}),null);
 assert.equal(simpleEditableEditorState({...s,result:{render:{status:'failed'}}}),null);
});
test('invalid JSON and JSON errors cannot masquerade as snapshots',async()=>{
 await assert.rejects(readAgentSnapshot(Response.json({error:'failure'},{status:500})),/HTTP 500/);
 await assert.rejects(readAgentSnapshot(Response.json({})),/missing project status/);
});

test('successful Simple draft is editable and freezes elapsed time without claiming formal completion',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'awaiting_user_action',activeExecutionRunId:'run-1',createdAt:'2026-09-24T05:00:00Z',updatedAt:'2026-09-24T05:13:00Z'},executionRun:{executionRunId:'run-1',status:'awaiting_user_action',updatedAt:'2026-09-24T05:13:00Z'},activeJob:{status:'complete',imageSlotProgress:{completed:23,total:23}},result:{data:{title:'行程'},render:{status:'success'},outputPath:'draft.png',unresolvedItems:[{kind:'image'}]}};
 assert.equal(simpleRenderedEditorState(s),'draft');
 assert.deepEqual({draft:agentDisplayState(s).draft,completed:agentDisplayState(s).completed,frozen:agentDisplayState(s).frozen},{draft:true,completed:false,frozen:true});
 assert.equal(agentElapsed(s,Date.parse('2026-09-24T06:00:00Z')),780);
 assert.equal(simpleRenderedEditorState({...s,project:{...s.project,status:'partial'},executionRun:{...s.executionRun,status:'partial'}}),'draft');
 assert.equal(simpleRenderedEditorState({...s,project:{...s.project,status:'complete'},executionRun:{...s.executionRun,status:'complete'}}),'complete');
});

test('rendered state requires a current successful render while a failed render retains only draft editing',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'awaiting_user_action'},executionRun:{status:'awaiting_user_action'},activeJob:{status:'complete',imageSlotProgress:{completed:23,total:23}},result:{data:{title:'行程'},render:{status:'success'},outputPath:'draft.png'}};
 assert.equal(simpleRenderedEditorState({...s,result:null}),null);
 assert.equal(simpleRenderedEditorState({...s,result:{...s.result,render:{status:'failed'}}}),null);
 assert.equal(simpleRenderedEditorState({...s,result:{...s.result,outputPath:null}}),null);
 assert.equal(simpleRenderedEditorState({...s,executionRun:{status:'running'}}),null);
 assert.equal(simpleRenderedEditorState({...s,project:{...s.project,activeExecutionRunId:'another-run'}}),null);
 assert.equal(simpleRenderedEditorState({...s,activeJob:{status:'failed'}}),null);
 assert.equal(simpleRenderedEditorState({...s,activeJob:{status:'cancelled'}}),null);
 assert.equal(simpleRenderedEditorState({...s,project:{...s.project,status:'cancelled'}}),null);
 assert.equal(agentDisplayState({...s,result:null}).completed,false);
 const failedRender=agentDisplayState({...s,result:{...s.result,render:{status:'failed'}}});
 assert.deepEqual({failed:failedRender.failed,draft:failedRender.draft,renderFailed:failedRender.renderFailed,completed:failedRender.completed},
   {failed:false,draft:true,renderFailed:true,completed:false});
});

test('whole-trip admission waiting does not start the generation clock',()=>{
 const submitted='2026-10-08T09:00:00Z';
 const s={project:{flowKind:'simple_skill_v1',status:'queued',createdAt:submitted,generationQueue:{state:'queued',queuedAt:Date.parse(submitted)}},activeJob:{status:'queued',createdAt:submitted}};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:12:00Z')),0);
 assert.equal(agentElapsed({...s,_connectionError:'network',_observedAt:Date.parse('2026-10-08T09:12:00Z')},Date.parse('2026-10-08T09:15:00Z')),0);
});

test('execution clock excludes admission waiting but includes planning and internal resource waiting',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'planning',createdAt:'2026-10-08T09:00:00Z'},activeJob:{status:'running',startedAt:'2026-10-08T09:12:00Z',generationQueue:{state:'running',startedAt:Date.parse('2026-10-08T09:12:00Z'),waitMs:720000}}};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:12:00Z')),0);
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:12:30Z')),30);
 s.project.status='ready_for_execution'; s.executionRun={status:'running',createdAt:'2026-10-08T09:13:00Z'};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:15:00Z')),180);
});

test('persisted running queue keeps its execution clock when there is no in-memory job',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'running',createdAt:'2026-10-08T09:00:00Z',generationQueue:{state:'running',startedAt:Date.parse('2026-10-08T09:12:00Z'),waitMs:720000}},executionRun:{status:'running',createdAt:'2026-10-08T09:13:00Z'}};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:15:00Z')),180);
 s.project.generationQueue={state:'running',waitMs:720000};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:15:00Z')),180);
});

test('finished queue duration remains fixed after reopening and later editor saves',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'partial',activeExecutionRunId:'run',createdAt:'2026-10-08T09:00:00Z',updatedAt:'2026-10-08T10:00:00Z',generationQueue:{state:'complete',waitMs:720000,executionMs:900123}},executionRun:{executionRunId:'run',status:'partial',updatedAt:'2026-10-08T10:00:00Z'},result:{data:{title:'fresh fixture'},render:{status:'success'},outputPath:'draft.png'}};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T11:00:00Z')),900);
 assert.equal(agentElapsed({...s,activeJob:{status:'complete',updatedAt:'2026-10-08T12:00:00Z'}},Date.parse('2026-10-08T13:00:00Z')),900);
});

test('cancelling or interrupting an unstarted queued batch has zero execution time',()=>{
 for(const state of ['cancelled','interrupted']){
  const s={project:{flowKind:'simple_skill_v1',status:state,createdAt:'2026-10-08T09:00:00Z',updatedAt:'2026-10-08T09:12:00Z',generationQueue:{state,waitMs:720000}}};
  assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:15:00Z')),0);
 }
});

test('disconnection and running cancellation freeze elapsed time from actual execution start',()=>{
 const s={project:{flowKind:'simple_skill_v1',status:'running',createdAt:'2026-10-08T09:00:00Z'},activeJob:{status:'running',startedAt:'2026-10-08T09:12:00Z'},_observedAt:Date.parse('2026-10-08T09:15:00Z'),_connectionError:'network'};
 assert.equal(agentElapsed(s,Date.parse('2026-10-08T09:30:00Z')),180);
 const cancelled={...s,project:{...s.project,status:'cancelled',updatedAt:'2026-10-08T09:16:00Z'},activeJob:{...s.activeJob,status:'cancelled',updatedAt:'2026-10-08T09:16:00Z'},_connectionError:null};
 assert.equal(agentElapsed(cancelled,Date.parse('2026-10-08T09:30:00Z')),240);
});
