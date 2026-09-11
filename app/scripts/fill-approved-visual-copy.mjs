import assert from 'node:assert/strict';
import { AgentPlanStore } from '../server/agent-plan-store.mjs';

// User-authorized, project-scoped editorial correction. No model, image search or renderer.
const projectId = '781ac2af-d275-444f-afe5-74c5d351e4ea';
const executionRunId = 'a9194e64-97fa-4640-bf57-680864c1b214';
const copy = {
  'image:day:1:primary': '傍晚在安博塞利营地周边展开游猎，寻找象群在草原上活动的身影。黄昏的光线让抵达后的第一场观察更有层次。',
  'image:day:1:supporting:1': '登上 Angama 专属观景台，远眺乞力马扎罗。天气与能见度允许时，可以欣赏日落光线映照雪山的景致。',
  'image:day:2:primary': '午后登上 Observation Hill，从高处俯瞰安博塞利湿地。相比车上的近距离观察，这里更适合看清草原与湿地交织的开阔景观。',
  'image:day:2:supporting:1': '跟随专业向导展开夜间游猎，在暗夜中寻找花豹等夜行动物的踪迹。动物是否现身取决于当晚情况，观察方式也与白天截然不同。',
  'image:day:2:supporting:2': '跟随专业向导步行进入草原，以脚步放慢观察节奏。离开车厢后，可以从更贴近地面的视角感受安博塞利的自然环境。',
  'image:day:3:primary': '傍晚返回营地，参加 Bush Sundowner 落日酒会，在日色渐暗时放慢节奏。把目光留给草原的黄昏，让这段品饮成为营地生活的一部分。',
  'image:day:3:supporting:1': '在营地天际甲板享用星空晚宴，让晚餐与草原夜色相伴。天气晴好时，抬头观察星空，为用餐增添不同于室内餐厅的体验。',
  'image:day:4:primary': '随向导深入马拉核心区，沿迁徙队伍的活动范围寻找角马渡河的机会。渡河属于自然发生的行为，耐心观察比预设必见场面更重要。',
  'image:day:4:supporting:1': '可选择走进马赛村庄，了解当地民族遗产与传统工艺。从村落参访到串珠制作，让草原之行多一层与当地文化的接触。',
  'image:day:5:primary': '跟随专属向导探索 Naboisho 私人保护区，在远离人群的游猎路线上寻找花豹踪迹。以更从容的节奏观察栖息环境，不把动物现身作为保证。',
  'image:day:6:primary': '入睡前打开帐篷屋顶，从星空床仰望非洲夜空。天气与能见度允许时，让观星成为居停体验，而不必另行出发。',
  'image:day:6:supporting:1': '可自费选择清晨热气球之旅，从空中俯瞰马赛马拉草原的日出景观。换一个高度观察辽阔地貌，与地面游猎形成不同视角。',
  'image:day:6:supporting:2': '日间可参与丛林徒步，用脚步感受草原环境。与乘车游猎相比，步行更适合放慢节奏，留意身边的自然细节。',
  'image:day:7:primary': '来到长颈鹿中心，与罗特希尔德长颈鹿近距离互动。在返城后换一种观察方式，感受这些动物的体态与动作。',
  'image:day:7:supporting:1': '前往 Karen 区的凯伦·布里克森博物馆，探访与《走出非洲》相关的人文地点。把注意力从草原转向建筑与故事，为旅程补上一段城市体验。',
  'image:day:8:primary': '酒店早餐后，按国际航班时间由专人送往机场。用简洁的离境安排收束旅程，为返程留出从容衔接。',
};
const store = new AgentPlanStore('output/simple-pipeline/projects');
const project = store.getProject(projectId);
assert.equal(project.activeExecutionRunId, executionRunId);
assert.notEqual(project.status, 'running');
const result = store.getFinalResult(projectId, executionRunId);
const before = structuredClone(result);
const ids = new Set();
for (const [slotId, description] of Object.entries(copy)) {
  const binding = result.data.simpleImageSlotBindings[slotId];
  assert.equal(binding.useSpotCopy, false);
  if (binding.description === description) continue;
  assert.equal(binding.description || '', '', `Refuse to overwrite existing copy: ${slotId}`);
  binding.description = description;
  const targetId = `copy:visual:${slotId}`;
  const taskResult = result.copyExecution.results.find(item => item.targetId === targetId);
  assert.ok(taskResult, targetId);
  Object.assign(taskResult, { status: 'success', value: description, manuallyEdited: true });
  delete taskResult.error;
  ids.add(targetId);
}
if (ids.size) {
  result.unresolvedItems = result.unresolvedItems.filter(item => !ids.has(item.id));
  const restored = structuredClone(result.data);
  for (const slotId of Object.keys(copy)) restored.simpleImageSlotBindings[slotId].description = before.data.simpleImageSlotBindings[slotId].description;
  assert.deepEqual(restored, before.data, 'Only card descriptions may change in customer data');
  assert.deepEqual(result.imageExecution, before.imageExecution);
  const evidenceId = `manual-visual-copy-${Date.now()}`;
  store.saveEvidence(projectId, executionRunId, evidenceId, { type: 'user_authorized_visual_copy_only', before, changedTargetIds: [...ids], source: 'original Excel DAY facts; manually composed', savedAt: new Date().toISOString() });
  store.saveFinalResult(projectId, executionRunId, result);
  console.log(JSON.stringify({ projectId, filled: ids.size, evidenceId, imageSearchCalls: 0, rendererCalls: 0 }));
} else console.log(JSON.stringify({ projectId, filled: 0, alreadyApplied: true }));
