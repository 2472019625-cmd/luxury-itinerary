import { isUsableFinalImageSource, validateItineraryFacts } from '../src/lib/itineraryRules.js';
import { selectCustomerRenderData } from './customer-render-data.mjs';
import { reviewCustomerContent } from './content-quality.mjs';

const INTERNAL_VISIBLE = /图片未通过终审|审核分数|候选状态|来源账本|经地点核验|原始资料照片|成本|利润|供应商底价|内部报价/i;

export function reviewFinalOutputData(data = {}, layout = null, options = {}) {
  const issues = [];
  const add = (severity, code, message, path = '') => issues.push({ severity, code, message, path });
  const customer = selectCustomerRenderData(data);
  const facts = validateItineraryFacts(data);
  facts.errors.forEach((message) => add('blocker', 'fact_conflict', message));
  if (INTERNAL_VISIBLE.test(JSON.stringify(customer))) add('blocker', 'internal_visible_text', '客户输出包含内部审核或成本术语');
  if (!customer.title || !customer.days?.length) add('blocker', 'required_module_missing', '封面标题或每日行程缺失');
  const sourceData = data.copySourceFacts || data;
  const brand = reviewCustomerContent(data, { sourceData });
  const copyQuality = data.copyQuality || {};
  const agentSuggestionPolicyPassed = String(copyQuality.version || '').startsWith('agent-copy-v2-hard-vs-suggestion')
    && copyQuality.passed === true
    && copyQuality.blocked !== true
    && Number(copyQuality.hardIssueCount || 0) === 0;
  brand.issues.forEach((item) => {
    const hardCopyIssue = ['fact','safety','structure'].includes(item.severity) || item.action === 'block';
    const preserveAsSuggestion = !hardCopyIssue && (options.allowCopyReviewPending || agentSuggestionPolicyPassed);
    add(preserveAsSuggestion ? 'warning' : 'blocker', `brand_${item.code}`, `${item.ruleIds.join('/')}: ${item.message}`, item.path);
  });
  if (copyQuality.blocked === true || Number(copyQuality.hardIssueCount || 0) > 0) add('blocker', 'copy_hard_block_pending', '仍有事实、费用、安全或结构问题，不能生成正式版本');
  if (copyQuality.passed !== true && !brand.issues.length) add(options.allowCopyReviewPending ? 'warning' : 'blocker', 'copy_revision_pending', '文案修订尚未完成同规则复检');
  if (customer.heroImage && !isUsableFinalImageSource(customer.heroImage)) add('blocker', 'remote_final_image', '封面仍使用未本地化远程图片', 'heroImage');
  const allImages = [customer.heroImage, ...(customer.hotels || []).flatMap((item) => item.images || []), ...(customer.diningExperiences || []).flatMap((item) => item.images || []), ...(customer.transportSummary || []).flatMap((item) => item.images || []), ...(customer.days || []).flatMap((day) => (day.spots || []).flatMap((spot) => spot.images || []))]
    .map((item) => typeof item === 'string' ? item : item?.src).filter(Boolean);
  allImages.filter((source) => !isUsableFinalImageSource(source)).forEach((source) => add('blocker', 'unsafe_final_image', `成品图片不是本地或用户资源：${source.slice(0, 80)}`));
  if (new Set(allImages).size !== allImages.length) add('blocker', 'duplicate_final_image', '成品存在完全重复图片');
  if (layout) {
    if (layout.width !== 2000) add('blocker', 'wrong_width', `正式成品宽度为${layout.width}px，不是2000px`);
    (layout.overflows || []).forEach((item) => add('blocker', 'text_overflow', `文字或模块溢出：${item.selector}`, item.selector));
    (layout.brokenImages || []).forEach((item) => add('blocker', 'broken_image', `图片未能正常渲染：${item.src}`, item.selector));
    (layout.largeGaps || []).forEach((item) => add('warning', 'large_gap', `检测到异常大空白 ${item.gap}px`, item.after));
    if (!layout.footerPresent) add('blocker', 'footer_missing', '固定品牌页脚缺失');
  }
  return { passed: !issues.some((item) => item.severity === 'blocker'), issues, checkedAt: new Date().toISOString() };
}
