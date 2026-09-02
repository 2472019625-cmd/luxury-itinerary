import assert from 'node:assert/strict';
import test from 'node:test';
import { applyContentSafetyGate, reviewCustomerContent } from '../server/content-quality.mjs';

function goodSample() {
  return {
    destination: '肯尼亚', dayCount: 2, title: '肯尼亚2天1晚Safari定制游',
    subtitle: '以私家节奏从城市抵达草原，在晨昏光线里完成一段从容的野奢初见',
    highlights: [
      '一家一团：专属节奏不用迁就陌生团友',
      '草原腹地：把清晨黄金时段留给深入游猎',
      '从容转场：合理衔接城市与保护区停留',
      '营地连住：减少反复收拾行李，把时间留给草原晨昏',
    ],
    hotels: [{ id:'h1', officialName:'Test Camp', sourceEvidence:['营地位于草原腹地','帐篷露台'], editorialCopy:'营地位于草原腹地，省去清晨长途折返；抵达后可在帐篷露台看暮色铺开，也让第二天的游猎动线更从容。', proofPoints:['草原腹地','帐篷露台','少走折返'] }],
    diningExperiences: [],
    transportSummary: [{ id:'t1', category:'专属游猎车', serviceLevel:'专属', seatCount:6, model:'', modelGuaranteed:false, editorialCopy:'专属游猎车贯穿草原段，充足空间让长距离移动更舒适，也为清晨出发和途中停靠保留从容节奏。' }],
    days: [
      { index:0, theme:'从城市走向旷野', routeNodes:['内罗毕','营地'], overnightType:'hotel', spots:[{id:'s1',status:'included',statusLabel:'已包含',feeBoundary:'included'}], description:'抵达后乘坐专车离开城市，沿途景色逐渐过渡到开阔旷野；傍晚入住草原营地，在露台休整，让第一天从容完成节奏转换。', dayNotices:[{type:'tip',text:'建议随身准备薄外套，应对傍晚温差。'}] },
      { index:1, theme:'晨光里的草原守候', routeNodes:['营地','保护区','机场'], overnightType:'none', spots:[{id:'s2',status:'included',statusLabel:'已包含',feeBoundary:'included'}], description:'清晨乘车深入保护区，在柔和晨光中守候草原动物；随后返回营地整理行装，再从容衔接机场，为这段旷野旅程留下完整收束。', dayNotices:[] },
    ],
    included:['住宿安排','专属交通'], excluded:['国际机票'], includedCustomer:['住宿安排：覆盖行程所列营地停留','专属交通：覆盖行程所列接送与游猎用车'], excludedCustomer:['国际机票：当前报价未包含往返国际段'],
    copyEvidence:{'hotels.0.editorialCopy':['草原腹地','帐篷露台']},
    notes:[
      {title:'气候与穿着',items:['建议准备分层衣物，并在清晨游猎时携带薄外套。']},
      {title:'活动安全',items:['请在保护区内听从向导安排，不擅自下车。']},
    ],
  };
}

test('qualified luxury brand copy passes all COPY-001—COPY-017 rule results', () => {
  const result = reviewCustomerContent(goodSample());
  assert.equal(result.passed, true, JSON.stringify(result.issues));
  assert.equal(result.ruleResults.length, 17);
  assert.ok(result.ruleResults.every((item) => ['complete_rule_pass','partial_check_pass','no_applicable_data'].includes(item.status)));
  assert.ok(result.ruleResults.some((item) => item.status === 'partial_check_pass'));
  assert.ok(result.ruleResults.some((item) => item.status === 'no_applicable_data'));
});

test('detects bare selling points, supplier logs, encyclopedia and discount language', () => {
  const data = goodSample();
  data.highlights = ['顶奢连住','私人保护区','一价全包'];
  data.days[0].description = '前往景点参观结束后返回酒店。';
  data.subtitle = '该公园面积约15000平方公里，是网红爆款超值之旅';
  data.highlights.push('春节特惠：现在预订更加划算');
  const result = reviewCustomerContent(data);
  const codes = result.issues.map((item) => item.code);
  assert.ok(codes.includes('highlight_bare_value'));
  assert.ok(codes.includes('day_supplier_log'));
  assert.ok(codes.includes('encyclopedia_tone'));
  assert.ok(codes.includes('discount_tone'));
});

test('detects facility dumps, missing daily scene, adjacent paraphrase and cold disclaimer', () => {
  const data = goodSample();
  data.hotels[0].editorialCopy = '酒店设有泳池、健身房、SPA、餐厅、酒吧和会议室。';
  data.days[0].description = '早餐后前往保护区，随后入住酒店，完成当天行程安排。';
  data.days[1].description = '早餐后前往另一个保护区，随后入住酒店，完成当天行程安排。';
  data.notes = [{title:'免责',items:['不能保证看到动物，一切以现场为准，后果自负。']}];
  const result = reviewCustomerContent(data);
  const codes = result.issues.map((item) => item.code);
  assert.ok(codes.includes('hotel_facility_dump'));
  assert.ok(codes.includes('day_no_scene'));
  assert.ok(codes.includes('day_near_duplicate'));
  assert.ok(codes.includes('notes_cold_tone'));
});

test('blocks internal language and unsupported guarantees without silently cleaning copy', () => {
  const data = goodSample();
  data.days[0].description += ' 供应商底价不展示，并保证看到狮子。';
  const result = applyContentSafetyGate(data);
  assert.equal(result.report.passed, false);
  assert.equal(result.report.fallbackUsed, false);
  assert.match(result.data.days[0].description, /供应商底价/);
  assert.ok(result.report.issues.some((item) => item.code === 'internal_leak' && item.action === 'block'));
  assert.ok(result.report.issues.some((item) => item.code === 'unsupported_promise'));
});

test('rejects action-only and hotel-name daily themes', () => {
  const data = goodSample();
  data.days[0].theme = '全天游猎';
  data.days[1].theme = 'Test Camp';
  const codes = reviewCustomerContent(data).issues.map((item) => item.code);
  assert.ok(codes.includes('overview_theme_action_only'));
  assert.ok(codes.includes('overview_theme_hotel_name'));
});

test('requires source coverage counts for expenses and transport modules', () => {
  const data = goodSample();
  const source = structuredClone(data);
  source.included = Array.from({ length: 9 }, (_, index) => `费用${index + 1}`);
  source.sourceImportCoverage = { included: source.included.map((text) => ({ text })), dailyTransport:[{dayIndex:0,text:'商务车'}] };
  data.included = [];
  data.includedCustomer = [];
  data.transportSummary = [];
  const codes = reviewCustomerContent(data, { sourceData:source }).issues.map((item) => item.code);
  assert.ok(codes.includes('fee_included_count_mismatch'));
  assert.ok(codes.includes('transport_module_missing'));
});

test('a confirmed hidden expense module preserves source facts without requiring customer-facing fee rewrites', () => {
  const source = goodSample();
  const data = { ...structuredClone(source), showExpenseSection: false, includedCustomer: [], excludedCustomer: [], cancellationCustomer: [] };
  const codes = reviewCustomerContent(data, { sourceData: source }).issues.map((item) => item.code);
  assert.equal(codes.some((code) => code.startsWith('fee_')), false);
});

test('blocks unsupported animal details and unverified visa numbers with evidence status', () => {
  const data = goodSample();
  const source = structuredClone(data);
  data.days[0].description += ' 傍晚一定能在营地看到狮子。';
  data.notes.push({title:'签证',items:['落地签有效期6个月，费用50美元。']});
  const result = reviewCustomerContent(data, { sourceData:source });
  const codes = result.issues.map((item) => item.code);
  assert.ok(codes.includes('factual_sentence_without_evidence'));
  assert.ok(codes.includes('time_sensitive_specific_without_authority'));
  assert.equal(result.ruleResults.find((item) => item.ruleId === 'COPY-015').status, 'evidence_insufficient');
});

test('reports invalid notes schema as a blocking structure issue', () => {
  const data = goodSample();
  data.notes = ['签证请核对', '建议携带外套'];
  const result = reviewCustomerContent(data, { sourceData: data });
  const invalid = result.issues.find((item) => item.code === 'notes_invalid_structure');
  assert.equal(invalid.severity, 'structure');
  assert.equal(invalid.action, 'block');
});

test('detects comma-separated subtitle lists, incomplete highlights and overlong DAY fact dumps', () => {
  const data = goodSample();
  data.dayCount = 7;
  data.subtitle = '草原飞机直达，庄园帐篷连住，敞篷越野车，一价全包，私人保护区';
  data.highlights = ['一家一团：专属节奏不用迁就陌生团友','在地服务：定制师协同减少等待','草原腹地：把清晨时段留给游猎'];
  data.days[0].description = `抵达后乘车深入草原，眼前逐渐转为开阔旷野；${'随后安排一项具体体验并感受草原节奏；'.repeat(14)}让这一天承接整段旅程。`;
  const codes = reviewCustomerContent(data).issues.map((item) => item.code);
  assert.ok(codes.includes('subtitle_selling_point_list'));
  assert.ok(codes.includes('highlight_incomplete'));
  assert.ok(codes.includes('day_overlong'));
  assert.ok(codes.includes('day_fact_dump'));
});

test('detects unsupported guide credentials, photographer and activity inventions', () => {
  const data = goodSample();
  const source = structuredClone(data);
  data.days[0].description += ' 由KPSGA认证专家导游与驻场摄影师陪同，并参加文化大使主持的串珠制作课程。';
  const result = reviewCustomerContent(data, { sourceData: source });
  const unsupported = result.issues.filter((item) => item.code === 'factual_sentence_without_evidence');
  assert.ok(unsupported.length > 0);
  assert.match(unsupported.map((item) => item.message).join(' '), /KPSGA|驻场摄影师|文化大使|串珠制作/);
});

test('rejects a long-trip subtitle that uses facts but still lacks a narrative arc', () => {
  const data = goodSample();
  data.dayCount = 7;
  data.days = Array.from({length:7}, (_, index) => ({ ...structuredClone(data.days[index % 2]), index }));
  data.subtitle = '自乞力马扎罗降落，深入塞伦盖蒂西部私人保护区，从营地到草原飞机，一价全包的旷野之旅。';
  const codes = reviewCustomerContent(data).issues.map((item) => item.code);
  assert.ok(codes.includes('subtitle_narrative_arc_missing'));
});

test('accepts a long-trip subtitle with semantic progression and outcome without fixed connective words', () => {
  const data = goodSample();
  data.dayCount = 7;
  data.days = Array.from({length:7}, (_, index) => ({ ...structuredClone(data.days[index % 2]), index }));
  data.subtitle = '自乞力马扎罗乘草原飞机进入塞伦盖蒂西部，换乘敞篷越野深入保护区，在徒步与热气球间切换，于双营地完成一场私享旷野之旅。';
  const codes = reviewCustomerContent(data).issues.map((item) => item.code);
  assert.equal(codes.includes('subtitle_narrative_arc_missing'), false);
});
