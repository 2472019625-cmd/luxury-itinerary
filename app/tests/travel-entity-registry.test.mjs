import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRAVEL_ENTITY_REGISTRY, TRAVEL_ENTITY_REGISTRY_SCHEMA_VERSION } from '../src/data/travelEntityRegistry.js';
import { buildCustomerTravelEntityData, resolveTravelEntity, synchronizeTravelEntityDisplayFields } from '../src/lib/travelEntityDisplay.js';
import { normalizeItineraryFacts } from '../src/lib/itineraryRules.js';
import { materializeSimpleSkillPlan } from '../server/simple-plan-adapter.mjs';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { validateCopyCommitments } from '../server/simple-copy-skill.mjs';

const kenya = () => JSON.parse(readFileSync(new URL('../data/kenya-luxury-8d.json', import.meta.url), 'utf8'));

test('Registry 使用 locale 展示名且 canonicalName 保持稳定', () => {
  assert.equal(TRAVEL_ENTITY_REGISTRY_SCHEMA_VERSION, '1.0.0');
  const cases = [
    ['The Ritz-Carlton, Masai Mara Safari Camp', '马赛马拉丽思卡尔顿营地'],
    ['JW Marriott Hotel Nairobi', '内罗毕JW万豪'],
    ['Observation Hill', '安博塞利观景山'],
  ];
  for (const [canonicalName, displayName] of cases) {
    const resolved = resolveTravelEntity(canonicalName, { locale: 'zh-CN' });
    assert.equal(resolved.canonicalName, canonicalName);
    assert.equal(resolved.displayName, displayName);
    assert.equal(resolved.status, 'resolved');
  }
});

test('酒店复用 shortName，DAY hotelShortName 从酒店确定性同步', () => {
  const source = kenya();
  const next = synchronizeTravelEntityDisplayFields(source, { locale: 'zh-CN' });
  assert.equal(next.hotels[0].officialName, source.hotels[0].officialName);
  assert.equal(next.hotels[0].shortName, 'Angama安博塞利');
  assert.equal(next.hotels[1].shortName, '马赛马拉丽思卡尔顿营地');
  assert.equal(next.hotels[2].shortName, 'Saruni豹山营地');
  assert.equal(next.hotels[3].shortName, '内罗毕JW万豪');
  assert.equal(next.days[0].hotelShortName, next.hotels[0].shortName);
  assert.equal(next.days[4].hotelShortName, next.hotels[2].shortName);
  assert.equal(next.days[6].hotelShortName, next.hotels[3].shortName);
  assert.equal(source.hotels[0].shortName, 'Angama Amboseli');
});

test('routeNodes 原始值不改写，Step4 与最终 customer render 共用展示结果', () => {
  const source = normalizeItineraryFacts(kenya(), { mapDates: false });
  const originalRoutes = structuredClone(source.days.map((day) => day.routeNodes));
  const step4 = buildCustomerTravelEntityData(source, { locale: 'zh-CN' });
  const finalData = selectCustomerRenderData(source, { locale: 'zh-CN' });
  assert.deepEqual(source.days.map((day) => day.routeNodes), originalRoutes);
  assert.deepEqual(finalData.days.map((day) => day.routeNodes), step4.days.map((day) => day.routeNodes));
  assert.ok(step4.days[1].routeNodes.includes('安博塞利观景山'));
  assert.ok(step4.days[4].routeNodes.includes('Naboisho私人保护区'));
  assert.ok(step4.days[6].routeNodes.includes('内罗毕JW万豪'));
  const workspaceSource = readFileSync(new URL('../src/Workspace.jsx', import.meta.url), 'utf8');
  assert.match(workspaceSource, /visibilityData\(buildCustomerTravelEntityData\(project\.data\), visibility\)/);
});

test('Planner、图片和 searchIntent 继续使用 canonical/source 名称', () => {
  const data = {
    locale: 'zh-CN', destination: '肯尼亚', highlights: [], hotels: [], diningExperiences: [], transportSummary: [], notes: [],
    days: [{ city: '安博塞利', routeNodes: ['Observation Hill'], description: '登 Observation Hill 俯瞰湿地。', spots: [{ name: 'Observation Hill', description: '登高俯瞰湿地。', images: [] }] }],
  };
  const agentPlan = {
    selectedHighlights: [], dayRoles: [{ index: 0, role: '安博塞利湿地观察', sourceRefs: ['days.0.spots.0'] }],
    imagePlan: { slots: [{ role: 'day:1', required: true, primaryVisualSubject: 'Observation Hill', searchIntent: 'Amboseli Observation Hill', sourceRefs: ['days.0.spots.0'] }] },
  };
  const plan = materializeSimpleSkillPlan({ data, agentPlan });
  const slot = plan.imageSlots.find((item) => item.moduleType === 'day');
  const visualCopy = plan.copyTasks.find((item) => item.moduleType === 'visual_card');
  assert.equal(slot.subject, 'Observation Hill');
  assert.deepEqual(slot.searchIntent, ['Amboseli Observation Hill']);
  assert.deepEqual(plan.preparedData.days[0].routeNodes, ['Observation Hill']);
  assert.equal(visualCopy.facts.entityCanonicalName, 'Observation Hill');
  assert.equal(visualCopy.facts.entityDisplayName, '安博塞利观景山');
});

test('Visual Card 不接受 Copy 自创实体译名', () => {
  const task = { moduleType: 'visual_card', facts: { entityCanonicalName: 'Observation Hill', entityDisplayName: '安博塞利观景山' }, factStatuses: {} };
  assert.match(validateCopyCommitments({ cardTitle: 'Observation Hill安博塞利观景台', cardDescription: '登高俯瞰湿地。' }, task)[0], /必须原样使用/);
  assert.deepEqual(validateCopyCommitments({ cardTitle: '安博塞利观景山', cardDescription: '登高俯瞰湿地。' }, task), []);
});

test('未知实体安全回退并标记缺名；新国家只追加 Registry 数据即可', () => {
  const missing = resolveTravelEntity('Unknown Lodge', { locale: 'zh-CN', entityType: 'hotel' });
  assert.equal(missing.displayName, 'Unknown Lodge');
  assert.equal(missing.issues[0].code, 'entity_display_name_missing');

  const registry = [...TRAVEL_ENTITY_REGISTRY, {
    id: 'hotel-aman-tokyo', entityType: 'hotel', canonicalName: 'Aman Tokyo', aliases: [],
    displayNames: { 'zh-CN': '东京安缦' }, country: 'Japan', region: 'Tokyo', scope: { country: 'Japan', region: 'Tokyo' },
  }];
  assert.equal(resolveTravelEntity('Aman Tokyo', { locale: 'zh-CN', entityType: 'hotel', registry }).displayName, '东京安缦');
});

test('匹配只接受标准化完整名称，并用 entityType 与 scope 消歧', () => {
  assert.equal(resolveTravelEntity('Observation Hill sunrise', { locale: 'zh-CN' }).status, 'unmapped');
  const registry = [
    { id: 'brand-sopa', entityType: 'brand', canonicalName: 'Sopa', aliases: [], displayNames: { 'zh-CN': 'Sopa' }, country: '', region: '', scope: {} },
    { id: 'hotel-sopa-ke', entityType: 'hotel', canonicalName: 'Sopa Kenya', aliases: ['Sopa'], displayNames: { 'zh-CN': '肯尼亚Sopa酒店' }, country: 'Kenya', region: 'Nairobi', scope: { country: 'Kenya', region: 'Nairobi' } },
    { id: 'hotel-sopa-tz', entityType: 'hotel', canonicalName: 'Sopa Tanzania', aliases: ['Sopa'], displayNames: { 'zh-CN': '坦桑尼亚Sopa酒店' }, country: 'Tanzania', region: 'Arusha', scope: { country: 'Tanzania', region: 'Arusha' } },
  ];
  assert.equal(resolveTravelEntity('Sopa', { locale: 'zh-CN', registry }).issues[0].code, 'entity_resolution_pending');
  assert.equal(resolveTravelEntity('Sopa', { locale: 'zh-CN', entityType: 'hotel', country: 'Kenya', registry }).displayName, '肯尼亚Sopa酒店');
});

test('每个 locale 独立解析，缺失时回退 canonicalName 而不是其他语言', () => {
  const registry = [{
    id: 'hotel-example', entityType: 'hotel', canonicalName: 'Example Official Hotel', aliases: [],
    displayNames: { 'zh-CN': '示例酒店', en: 'Example Hotel' }, country: 'Example', region: 'Example', scope: { country: 'Example', region: 'Example' },
  }];
  assert.equal(resolveTravelEntity('Example Official Hotel', { locale: 'en', registry }).displayName, 'Example Hotel');
  const missingLocale = resolveTravelEntity('Example Official Hotel', { locale: 'ms-MY', registry });
  assert.equal(missingLocale.displayName, 'Example Official Hotel');
  assert.equal(missingLocale.issues[0].code, 'entity_display_name_missing');
});
