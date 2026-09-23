import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentPlanStore } from '../server/agent-plan-store.mjs';
import { createCopyResearchStateStore } from '../server/simple-copy-research-state.mjs';

test('facts research claims survive a new store instance and remain scoped to one run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copy-research-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentPlanStore(root);
  const first = createCopyResearchStateStore({ store, projectId: 'project-a', executionRunId: 'run-a' });
  assert.equal(first.claim('hotel-key', 'main').claimed, true);
  assert.equal(first.claim('hotel-key', 'main').claimed, false);
  first.save('hotel-key', { mainResult: { status: 'partial_success' } });
  const reloaded = createCopyResearchStateStore({ store: new AgentPlanStore(root), projectId: 'project-a', executionRunId: 'run-a' });
  assert.equal(reloaded.claim('hotel-key', 'main').claimed, false);
  assert.equal(reloaded.claim('hotel-key', 'supplement').claimed, true);
  assert.equal(reloaded.claim('hotel-key', 'supplement').claimed, false);
  reloaded.save('hotel-key', { result: { status: 'success' } });
  assert.equal(reloaded.load('hotel-key').mainResult.status, 'partial_success');
  assert.equal(reloaded.load('hotel-key').result.status, 'success');
  assert.equal(createCopyResearchStateStore({ store, projectId: 'project-a', executionRunId: 'run-b' }).claim('hotel-key', 'main').claimed, true);
});
