import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentFactBasis, validateSimpleHighlightSelection, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { plannerRequestJson } from './helpers/simple-pipeline-fixture.mjs';

test('Planner请求统一视觉覆盖规则和一基DAY编号，保留丰富日辅助槽', async () => {
  const factBasis = buildAgentFactBasis({ destination: '肯尼亚', days: [{ description: '大象雪山，Observation Hill，步行Safari，夜间游猎' }, { description: '简单送机' }] });
  const result = await generateAgentPlan({ project: { projectId: 'visual-contract', inputFingerprint: 'test', factBasis }, simpleSkillContract: true, requestJson: async options => {
    const system = options.messages.filter(m => m.role === 'system');
    assert.equal(system.length, 1);
    assert.match(system[0].content, /多个明确、差异化、高价值体验时必须选择2—4个/);
    assert.match(system[0].content, /DAY2: dayRoles.index=1; imagePlan主图role=day:2/);
    const response = await plannerRequestJson({ delayMs: 0 })(options);
    response.json.imagePlan.slots.push(...['Observation Hill', '步行Safari', '夜间游猎'].map((subject, i) => ({ slotId: `extra-${i}`, role: `day:1:supporting:${i+1}`, required: false, removable: true, primaryVisualSubject: subject, label: subject, visualDuty: '当天独立体验', differentiation: subject, searchIntent: subject })));
    return response;
  } });
  assert.equal(result.plan.imagePlan.slots.filter(s => /^day:1(?:$|:)/.test(s.role)).length, 4);
  assert.equal(result.plan.imagePlan.slots.filter(s => /^day:2(?:$|:)/.test(s.role)).length, 1);
});

test("Planner 事实基座拆分原海报亮点并注入已确认奢游产品价值", () => {
  const facts = buildAgentFactBasis({
    destination: "坦桑尼亚",
    sourcePosterHighlights: ["Singita连住\n私人保护区徒步/夜游\n庄园帐篷双奢\n全程一价全包"],
    days: [],
  });
  assert.deepEqual(facts.sourcePosterHighlights, ["Singita连住", "私人保护区徒步/夜游", "庄园帐篷双奢", "全程一价全包"]);
  assert.ok(facts.officialProductValues.some((item) => item.sourceText.includes("一家一团")));
  assert.ok(facts.officialProductValues.some((item) => item.sourceText.includes("1V1")));
  const valid = {
    selectedHighlights: [
      ...facts.sourcePosterHighlights.map((sourceText) => ({ sourceText, sourceType: "source_designated" })),
      { sourceText: facts.officialProductValues[0].sourceText, sourceType: "official_product" },
    ],
  };
  assert.deepEqual(validateSimpleHighlightSelection(valid, facts), []);
});

test("热气球 DAY 体验不能伪装为 official_product，且不能越过正式服务候选", () => {
  const facts = buildAgentFactBasis({ destination: "坦桑尼亚", sourcePosterHighlights: ["Singita连住"], days: [{ description: "自费热气球 Safari", spots: [] }] });
  const errors = validateSimpleHighlightSelection({ selectedHighlights: [{ sourceText: "自费升级热气球Safari", sourceType: "official_product" }] }, facts);
  assert.ok(errors.some((item) => item.code === "official_product_untraceable"));
  assert.ok(errors.some((item) => item.code === "official_product_priority_missing"));
});

test("原海报指定亮点不能被低优先级候选越过，单DAY体验不能直接抬升", () => {
  const facts = buildAgentFactBasis({ destination: "坦桑尼亚", sourcePosterHighlights: ["Singita连住\n私人保护区徒步/夜游"], days: [] });
  const errors = validateSimpleHighlightSelection({ selectedHighlights: [
    { sourceText: "Singita连住", sourceType: "source_designated" },
    ...facts.officialProductValues.map((item) => ({ sourceText: item.sourceText, sourceType: "official_product" })),
    { sourceText: "自费热气球", sourceType: "planner_derived", sourceRefs: ["days.3.spots.1"] },
  ] }, facts);
  assert.ok(errors.some((item) => item.code === "source_highlight_priority_missing"));
  assert.ok(errors.some((item) => item.code === "ordinary_day_highlight_promoted"));
});
