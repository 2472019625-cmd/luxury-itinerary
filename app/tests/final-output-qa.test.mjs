import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewFinalOutputData } from '../server/final-output-qa.mjs';

const data = {
  title:'坦桑尼亚2天1晚深度定制游', subtitle:'从城市走向旷野，以从容衔接完成草原初见', destination:'坦桑尼亚', dayCount:2, startDate:'2026-10-01', endDate:'2026-10-02',
  highlights:['一家一团：专属节奏不用迁就陌生团友','草原初见：把晨昏光线留给旷野体验','从容转场：减少城市与营地之间的无效折返'],
  days:[{date:'2026-10-01',theme:'从城市走向旷野',routeNodes:['城市','营地'],overnightType:'hotel',spots:[],description:'抵达后乘坐专车离开城市，眼前景色逐渐转向开阔旷野；傍晚在营地休整，让第一天从容完成节奏转换。'},{date:'2026-10-02',theme:'晨光中的草原收束',routeNodes:['营地','机场'],overnightType:'none',spots:[],description:'清晨乘车深入草原，在晨光中完成最后一段旷野体验；随后返回整理行装，再从容衔接机场，为旅程留下完整收束。'}],
  hotels:[], transportSummary:[], diningExperiences:[], included:[], excluded:[], pendingConfirmations:[], notes:[{title:'行程安排',items:['请在出发前与定制师核对集合时间。'],tone:'gold'}], copyQuality:{version:'5.0',passed:true,status:'passed'},
};

test('final output QA blocks internal terms, remote images and broken layout', () => {
  const result = reviewFinalOutputData({ ...data, heroImage: 'https://remote.example/a.jpg', subtitle: '图片未通过终审' }, { width: 2000, overflows: [], brokenImages: [{ selector: '.hero', src: '/missing.jpg' }], largeGaps: [], footerPresent: true });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((item) => item.code === 'internal_visible_text'));
  assert.ok(result.issues.some((item) => item.code === 'remote_final_image'));
  assert.ok(result.issues.some((item) => item.code === 'broken_image'));
});

test('final output QA accepts a complete 2000px structure with no images', () => {
  const result = reviewFinalOutputData(data, { width: 2000, overflows: [], brokenImages: [], largeGaps: [], footerPresent: true });
  assert.equal(result.passed, true);
});

test('formal output rechecks brand quality after editor changes', () => {
  const edited = { ...data, copyQuality: { version:'2.0', passed:true }, title:'坦桑尼亚2天1晚深度定制游', subtitle:'非凡之旅', highlights:['顶奢连住'], notes:[] };
  const result = reviewFinalOutputData(edited, { width:2000, overflows:[], brokenImages:[], largeGaps:[], footerPresent:true });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((item) => item.code.startsWith('brand_')));
});

test('generation preview may carry copy issues into editor but formal export still blocks them', () => {
  const edited = { ...data, copyQuality: { version:'3.2', passed:false, needsReview:true, blocked:false, hardIssueCount:0 }, subtitle:'非凡之旅' };
  const layout = { width:2000, overflows:[], brokenImages:[], largeGaps:[], footerPresent:true };
  const preview = reviewFinalOutputData(edited, layout, { allowCopyReviewPending:true });
  assert.equal(preview.passed, true);
  assert.ok(preview.issues.some((item) => item.severity === 'warning' && item.code.startsWith('brand_')));
  const formal = reviewFinalOutputData(edited, layout);
  assert.equal(formal.passed, false);
  assert.ok(formal.issues.some((item) => item.severity === 'blocker' && item.code.startsWith('brand_')));
});

test('agent final gate preserves accepted optimization suggestions as warnings', () => {
  const reviewed = {
    ...data,
    copyQuality: {
      version:'agent-copy-v2-hard-vs-suggestion',
      passed:true,
      status:'passed_with_suggestions',
      blocked:false,
      hardIssueCount:0,
    },
    subtitle:'非凡之旅',
  };
  const layout = { width:2000, overflows:[], brokenImages:[], largeGaps:[], footerPresent:true };
  const result = reviewFinalOutputData(reviewed, layout);
  assert.equal(result.passed, true);
  assert.ok(result.issues.some((item) => item.severity === 'warning' && item.code.startsWith('brand_')));
  assert.equal(result.issues.some((item) => item.severity === 'blocker' && item.code.startsWith('brand_')), false);
});

test('agent final gate still blocks hard copy and real layout failures', () => {
  const reviewed = {
    ...data,
    copyQuality: {
      version:'agent-copy-v2-hard-vs-suggestion',
      passed:false,
      status:'blocked_generation',
      blocked:true,
      hardIssueCount:1,
    },
    notes:['错误字符串'],
  };
  const layout = { width:2000, overflows:[{selector:'.day-description'}], brokenImages:[], largeGaps:[], footerPresent:true };
  const result = reviewFinalOutputData(reviewed, layout);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((item) => item.code === 'copy_hard_block_pending'));
  assert.ok(result.issues.some((item) => item.code === 'brand_notes_invalid_structure'));
  assert.ok(result.issues.some((item) => item.code === 'text_overflow'));
});

test('acknowledged ordinary copy warnings may export, but structure errors still block', () => {
  const warningDraft = { ...data, copyQuality:{passed:false,blocked:false,hardIssueCount:0}, subtitle:'非凡之旅' };
  const layout = { width:2000, overflows:[], brokenImages:[], largeGaps:[], footerPresent:true };
  assert.equal(reviewFinalOutputData(warningDraft, layout, {allowCopyReviewPending:true}).passed, true);
  const hardDraft = { ...warningDraft, copyQuality:{passed:false,blocked:true,hardIssueCount:1}, notes:['错误字符串'] };
  const result = reviewFinalOutputData(hardDraft, layout, {allowCopyReviewPending:true});
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((item) => item.code === 'copy_hard_block_pending'));
  assert.ok(result.issues.some((item) => item.code === 'brand_notes_invalid_structure'));
});
