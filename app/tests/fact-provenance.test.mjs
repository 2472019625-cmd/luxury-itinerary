import assert from 'node:assert/strict';
import test from 'node:test';
import { applySafeCopyCorrections, buildFactProvenanceReport } from '../server/fact-provenance.mjs';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

test('one source fact can support several customer sentences without sentence-count false positives', () => {
  const source = {
    days: [{ theme:'草原初见', description:'入住草原帐篷营地，乘四驱动敞篷式越野车进入保护区。', hotel:'草原帐篷营地', vehicle:'四驱动敞篷式越野车', routeNodes:['机场','保护区'] }],
    hotels: [], transportSummary: [],
  };
  const customer = structuredClone(source);
  customer.days[0].description = '今天入住草原帐篷营地。随后乘四驱动敞篷式越野车进入保护区。';
  const report = buildFactProvenanceReport(customer, source);
  assert.equal(report.unsupported.length, 0, JSON.stringify(report.unsupported));
  assert.ok(report.entries.length >= 2);
  assert.ok(report.entries.every((entry) => entry.matchedSources.length > 0));
});

test('unsupported generated detail is removed while original deterministic facts stay unchanged', () => {
  const source = {
    days: [{ date:'2026-10-01', theme:'抵达草原', description:'抵达后入住营地。', hotel:'草原营地', vehicle:'专车', routeNodes:['机场','营地'], spots:[] }],
    hotels: [], transportSummary: [], included:[], excluded:[], cancellation:[],
  };
  const customer = structuredClone(source);
  customer.days[0].description = '抵达后入住草原营地。傍晚可以在营地泳池旁看到狮子。';
  const result = applySafeCopyCorrections(customer, source);
  assert.ok(result.corrections.some((item) => item.code === 'unsupported_generated_fact_removed'));
  assert.doesNotMatch(result.data.days[0].description, /泳池|狮子/);
  assert.equal(result.data.days[0].date, source.days[0].date);
  assert.deepEqual(result.data.days[0].routeNodes, source.days[0].routeNodes);
});

test('unverified visa amount becomes conservative copy without dropping the supplier fee item', () => {
  const source = { included:['坦桑签证费用（落地签，现金50美金）'], excluded:[], cancellation:[], days:[], hotels:[], transportSummary:[], authoritativeFacts:[] };
  const customer = { ...structuredClone(source), includedCustomer:['坦桑签证费用（落地签，现金50美金）'] };
  const result = applySafeCopyCorrections(customer, source);
  assert.equal(result.data.includedCustomer.length, 1);
  assert.doesNotMatch(result.data.includedCustomer[0], /50/);
  assert.match(result.data.includedCustomer[0], /官方最新信息复核/);
  assert.ok(result.corrections.some((item) => item.code === 'time_sensitive_safe_fallback'));
});

test('verified official hotel facts may enrich hotel copy but do not justify unrelated DAY animal scenes', () => {
  const source = {
    hotels:[{ officialName:'Serengeti Test Lodge', sourceEvidence:[], verifiedFacts:[{ statement:'酒店设有室外泳池。', sourceUrl:'https://hotel.example/facilities', verifiedAt:'2026-09-01', sourceType:'official' }] }],
    days:[{ hotel:'Serengeti Test Lodge', description:'入住 Serengeti Test Lodge。', theme:'入住休整', routeNodes:['机场','酒店'], spots:[] }],
    transportSummary:[], included:[], excluded:[], cancellation:[],
  };
  const customer = structuredClone(source);
  customer.hotels[0].editorialCopy = '酒店设有室外泳池，抵达后可在池畔放松。';
  customer.days[0].description = '抵达后入住酒店，并可在室外泳池休息。随后在池边观看狮群饮水。';
  const result = applySafeCopyCorrections(customer, source);
  assert.match(result.data.hotels[0].editorialCopy, /室外泳池/);
  assert.match(result.data.days[0].description, /室外泳池/);
  assert.doesNotMatch(result.data.days[0].description, /狮群|饮水/);
  const customerView = selectCustomerRenderData(result.data);
  assert.equal(JSON.stringify(customerView).includes('hotel.example'), false);
  assert.equal(JSON.stringify(customerView).includes('verifiedFacts'), false);
});

test('equivalent safari vehicle wording is supported without hiding a real accommodation mismatch', () => {
  const source = {
    days: [{
      description: '游猎日，独立包车敞篷越野游猎',
      vehicle: '四驱动敞篷式越野车',
      hotel: 'Singita Faru Faru Lodge',
    }],
    hotels: [{ officialName: 'Singita Faru Faru Lodge', nights: 1 }],
  };
  const draft = {
    days: [{
      description: '搭乘独立包车的敞篷越野车展开游猎，夜晚回到营地休息。',
    }],
  };
  const report = buildFactProvenanceReport(draft, source);
  assert.equal(report.unsupported.some((entry) => entry.missingClaims.includes('敞篷越野车')), false);
  assert.equal(report.unsupported.some((entry) => entry.missingClaims.includes('营地')), true);
});

test('unsupported detail inside one note item is corrected at the exact item path instead of blocking the whole notes group', () => {
  const source = { days:[{routeNodes:['机场','酒店'],hotel:'酒店'}], hotels:[], transportSummary:[], included:[], excluded:[], cancellation:[] };
  const customer = { ...structuredClone(source), notes:[{title:'出行提示',items:['贵重物品请随身携带，方便在营地间移动与转机。','请提前核对集合时间。']}] };
  const result = applySafeCopyCorrections(customer, source);
  assert.ok(result.corrections.some((item) => item.path === 'notes.0.items.0'));
  assert.doesNotMatch(result.data.notes[0].items[0], /营地/);
  assert.equal(result.data.notes[0].items[1], '请提前核对集合时间。');
  assert.equal(result.provenance.unsupported.length, 0);
});

test('scoped safe correction never changes an unrelated field during one-target repair', () => {
  const source = { days:[{description:'抵达营地。'},{description:'乘车前往保护区。'}], hotels:[], transportSummary:[], included:[], excluded:[], cancellation:[] };
  const customer = structuredClone(source);
  customer.days[0].description = '抵达营地后在泳池旁看狮子。';
  customer.days[1].description = '乘车前往保护区，并由KPSGA认证专家导游陪同。';
  const result = applySafeCopyCorrections(customer, source, { paths:['days.1'] });
  assert.equal(result.data.days[0].description, customer.days[0].description);
  assert.doesNotMatch(result.data.days[1].description, /KPSGA|认证专家导游/);
  assert.ok(result.corrections.every((item) => item.path.startsWith('days.1')));
});
