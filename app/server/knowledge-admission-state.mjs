import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Non-sensitive lifecycle state, owned by this application's knowledge lane.
// It survives service restart; only verified non-acceptance/terminal status
// permits clearing. No query text, endpoint, credentials or pictures are saved.
export function knowledgeAdmissionState(directory, endpoint, laneIndex = 0) {
  if (!directory) return null;
  if (![0, 1].includes(laneIndex)) throw new RangeError('Invalid knowledge lane');
  // Lane zero retains the legacy filename so accepted queries survive upgrades.
  const suffix = laneIndex === 0 ? '' : '.lane-1';
  const file = path.join(directory, `${createHash('sha256').update(endpoint).digest('hex')}${suffix}.json`);
  const save = async state => {
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.next`;
    await writeFile(temporary, JSON.stringify({ version: 1, owner: 'luxury-itinerary-knowledge-lane',
      consumers: ['automatic-images', 'manual-images'], retireWhen: 'Original query terminal state verified',
      laneIndex, ...state }), { mode: 0o600 });
    await rename(temporary, file);
  };
  return {
    file, save,
    async load() {
      try {
        const state = JSON.parse(await readFile(file, 'utf8'));
        if (state.version !== 1 || !['idle', 'submitting', 'accepted'].includes(state.phase)
          || state.phase === 'accepted' && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(state.queryId || '')) {
          throw new Error('Invalid admission state');
        }
        return state;
      } catch (error) {
        if (error.code === 'ENOENT') return { phase: 'idle' };
        throw Object.assign(new Error('知识库受理状态读取失败'), { code: 'knowledge_admission_state_failed', cause: error });
      }
    },
    clear: () => save({ phase: 'idle' }),
  };
}
