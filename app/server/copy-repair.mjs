import { COPY_RULE_VERSION, copyRuleCardsFor } from '../config/copy-rule-runtime.mjs';

const HARD_SEVERITIES = new Set(['fact','safety','structure']);
const COMPLEX_CODES = new Set(['day_no_value','day_no_progression','day_near_duplicate','day_no_scene','day_no_action_scene','day_thin','overview_theme','overview_theme_action_only','overview_theme_hotel_name','highlight_value_mix','highlight_near_duplicate','source_highlight_lost','hotel_route_value','hotel_scene','hotel_thin']);

export function issueRuleIds(issue = {}) {
  return [...new Set([...(Array.isArray(issue.ruleIds) ? issue.ruleIds : []), issue.ruleId].filter(Boolean))];
}

export function isBlockingCopyIssue(issue = {}) {
  return HARD_SEVERITIES.has(issue.severity) || issue.action === 'block';
}

export function targetScopeFromPath(path = '') {
  const value = String(path || 'customer');
  let match = value.match(/^days\.(\d+)/);
  if (match) return { key: `day:${match[1]}`, kind: 'day', index: Number(match[1]), path: `days.${match[1]}` };
  match = value.match(/^hotels\.(\d+)/);
  if (match) return { key: `hotel:${match[1]}`, kind: 'hotel', index: Number(match[1]), path: `hotels.${match[1]}` };
  match = value.match(/^diningExperiences\.(\d+)/);
  if (match) return { key: `dining:${match[1]}`, kind: 'dining', index: Number(match[1]), path: `diningExperiences.${match[1]}` };
  match = value.match(/^transportSummary\.(\d+)/);
  if (match) return { key: `transport:${match[1]}`, kind: 'transport', index: Number(match[1]), path: `transportSummary.${match[1]}` };
  if (value.startsWith('notes')) return { key: 'module:notes', kind: 'notes', index: null, path: 'notes' };
  if (value.startsWith('highlights')) return { key: 'module:highlights', kind: 'highlights', index: null, path: 'highlights' };
  if (/^(includedCustomer|excludedCustomer|cancellationCustomer|expenses)/.test(value)) return { key: 'module:expenses', kind: 'expenses', index: null, path: 'expenses' };
  if (value === 'title' || value === 'subtitle') return { key: `field:${value}`, kind: 'field', index: null, path: value };
  return { key: `module:${value.split('.')[0] || 'customer'}`, kind: 'module', index: null, path: value.split('.')[0] || 'customer' };
}

function complexIssue(issue, scope) {
  if (COMPLEX_CODES.has(issue.code)) return true;
  if (scope.kind === 'day' || scope.kind === 'hotel' || scope.kind === 'highlights') return true;
  return /价值|推进|相邻|重复|整程|路线意义|场景/.test(String(issue.message || ''));
}

export function planCopyRepairs(issues = []) {
  const blockers = [];
  const grouped = new Map();
  for (const issue of issues.filter(Boolean)) {
    if (isBlockingCopyIssue(issue)) { blockers.push(issue); continue; }
    const scope = targetScopeFromPath(issue.path);
    if (!grouped.has(scope.key)) grouped.set(scope.key, { ...scope, issues: [], ruleIds: new Set(), complexity: 'simple' });
    const target = grouped.get(scope.key);
    target.issues.push(issue);
    issueRuleIds(issue).forEach((id) => target.ruleIds.add(id));
    if (complexIssue(issue, scope)) target.complexity = 'complex';
  }
  const targets = [...grouped.values()].map((target) => ({
    ...target,
    ruleIds: [...target.ruleIds],
    ruleVersion: COPY_RULE_VERSION,
    ruleCards: copyRuleCardsFor([...target.ruleIds]),
    allowedPaths: [...new Set(target.issues.map((item) => item.path).filter(Boolean))],
    firstReasoning: target.complexity === 'complex' ? 'high' : 'low',
    maxLowAttempts: target.complexity === 'complex' ? 0 : 1,
    maxHighAttempts: 1,
  }));
  return { blockers, targets };
}

function daySummary(day = {}, index) {
  return { index, date: day.date, theme: day.theme, routeNodes: day.routeNodes, description: day.description, hotel: day.hotel, vehicle: day.vehicle, estimatedTravelTime: day.estimatedTravelTime, spots: day.spots };
}

export function buildCopyTargetContext(sourceFacts = {}, currentDraft = {}, mainline = {}, target = {}) {
  const base = { target: { key: target.key, kind: target.kind, index: target.index, path: target.path, allowedPaths: target.allowedPaths }, ruleVersion: target.ruleVersion, ruleCards: target.ruleCards, targetIssues: target.issues };
  if (target.kind === 'day') {
    const index = target.index;
    return { ...base, sourceTarget: daySummary(sourceFacts.days?.[index], index), currentTarget: daySummary(currentDraft.days?.[index], index), context: { previousDay: index > 0 ? daySummary(currentDraft.days?.[index - 1], index - 1) : null, nextDay: currentDraft.days?.[index + 1] ? daySummary(currentDraft.days[index + 1], index + 1) : null, dayRole: mainline.dayRoles?.find((item) => Number(item.index) === index) || null, journeyPromise: mainline.journeyPromise } };
  }
  if (target.kind === 'hotel') return { ...base, sourceTarget: sourceFacts.hotels?.[target.index], currentTarget: currentDraft.hotels?.[target.index], context: { journeyPromise: mainline.journeyPromise, relevantDays: sourceFacts.days?.filter((day) => String(day.hotel || '').includes(String(sourceFacts.hotels?.[target.index]?.shortName || sourceFacts.hotels?.[target.index]?.officialName || ''))).map(daySummary) || [] } };
  if (target.kind === 'dining') return { ...base, sourceTarget: sourceFacts.diningExperiences?.[target.index], currentTarget: currentDraft.diningExperiences?.[target.index], context: { journeyPromise: mainline.journeyPromise } };
  if (target.kind === 'transport') return { ...base, sourceTarget: sourceFacts.transportSummary?.[target.index], currentTarget: currentDraft.transportSummary?.[target.index], context: { dailyTransport: sourceFacts.days?.map(({ index, date, routeNodes, vehicle, estimatedTravelTime }) => ({ index, date, routeNodes, vehicle, estimatedTravelTime })), journeyPromise: mainline.journeyPromise } };
  const value = target.kind === 'field' ? currentDraft[target.path] : target.kind === 'notes' ? currentDraft.notes : target.kind === 'highlights' ? currentDraft.highlights : target.kind === 'expenses' ? { includedCustomer: currentDraft.includedCustomer, excludedCustomer: currentDraft.excludedCustomer, cancellationCustomer: currentDraft.cancellationCustomer } : currentDraft[target.path];
  const source = target.kind === 'field' ? sourceFacts[target.path] : target.kind === 'notes' ? sourceFacts.notes : target.kind === 'highlights' ? { sourcePosterHighlights: sourceFacts.sourcePosterHighlights, currentHighlights: sourceFacts.currentHighlights } : target.kind === 'expenses' ? { included: sourceFacts.included, excluded: sourceFacts.excluded, cancellation: sourceFacts.cancellation } : sourceFacts[target.path];
  return { ...base, sourceTarget: source, currentTarget: value, context: { journeyPromise: mainline.journeyPromise } };
}

function pathCovered(scopePath, issuePath) {
  const left = String(scopePath || ''); const right = String(issuePath || '');
  return left === right || right.startsWith(`${left}.`) || left.startsWith(`${right}.`) || (left === 'expenses' && /^(includedCustomer|excludedCustomer|cancellationCustomer|expenses)/.test(right));
}

export function issuesForTarget(issues = [], target = {}) {
  const rules = new Set(target.ruleIds || []);
  return issues.filter((issue) => pathCovered(target.path, issue.path) && (!rules.size || issueRuleIds(issue).some((id) => rules.has(id))));
}
