import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildLayoutImageSlots } from '../src/lib/imageSlots.js';
import { cacheKey, createImageResearchCache } from './image-cache.mjs';
import { requestDeepSeekJson } from './deepseek-client.mjs';
import { copyTaskQueue } from './copy-task-queue.mjs';
import { modelTaskProfile } from '../config/model-task-routing.mjs';

export const IMAGE_BLUEPRINT_VERSION = '1.0';
export const IMAGE_BLUEPRINT_PROMPT_VERSION = '1.1-tiered-placement';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
export function fingerprint(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

export function itineraryFactsForBlueprint(data) {
  return {
    title: data.title, subtitle: data.subtitle, destination: data.destination,
    contentVisualMainline: data.contentVisualMainline || null,
    startDate: data.startDate, endDate: data.endDate, dayCount: data.dayCount || data.days?.length,
    adults: data.adults, children: data.children, travelers: data.travelers,
    highlights: data.highlights || [], included: data.included || [], excluded: data.excluded || [],
    hotels: (data.hotels || []).map(({ id, officialName, shortName, region, nights, editorialCopy, proofPoints }) => ({ id, officialName, shortName, region, nights, editorialCopy, proofPoints })),
    diningExperiences: data.diningExperiences || [],
    transportSummary: data.transportSummary || [],
    days: (data.days || []).map((day, index) => ({
      index, date: day.date, theme: day.theme, city: day.city, description: day.description,
      routeNodes: day.routeNodes || [], vehicle: day.vehicle, estimatedTravelTime: day.estimatedTravelTime,
      activityLevel: day.activityLevel, restStops: day.restStops || [], mealPlan: day.mealPlan,
      hotel: day.hotel, overnightType: day.overnightType,
      spots: (day.spots || []).map(({ id, name, description, experience, status, statusLabel, feeBoundary, sourceEvidence, included, optional, confirmed, reminder }) => ({ id, name, description, experience, status, statusLabel, feeBoundary, sourceEvidence, included, optional, confirmed, reminder })),
    })),
  };
}

export function buildBlueprintInput(data) {
  const itineraryFacts = itineraryFactsForBlueprint(data);
  const layoutSlots = buildLayoutImageSlots(data).map(({ slotId, module, fieldPath, dayIndex, adjacentText, ratio, maxImages, purpose, allowEmpty, role }) => ({ slotId, module, fieldPath, dayIndex, adjacentText, ratio, maxImages, purpose, allowEmpty, role }));
  const lockedImages = Object.entries(data.imageLocks || {}).map(([slotId, lock]) => ({ slotId, ...lock }));
  return { itineraryFacts, layoutSlots, lockedImages, projectPurpose: '奢游国际 2000px 客户行程长图' };
}

function parseJson(content) {
  const source = String(content || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '');
  return JSON.parse(source);
}

export function validateImageBlueprint(blueprint, input) {
  const errors = [];
  if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.slots)) return { valid: false, errors: ['返回内容不是包含 slots 的 JSON 对象'] };
  const allowed = new Map(input.layoutSlots.map((slot) => [slot.slotId, slot]));
  const locked = new Set(input.lockedImages.map((item) => item.slotId));
  const seen = new Set();
  const factsText = JSON.stringify(input.itineraryFacts).replace(/\s+/g, '').toLowerCase();
  for (const item of blueprint.slots) {
    if (!allowed.has(item.slotId)) errors.push('不存在的图片位：' + item.slotId);
    if (seen.has(item.slotId)) errors.push('重复的图片位：' + item.slotId);
    seen.add(item.slotId);
    if (locked.has(item.slotId) && item.useImage !== false) errors.push('用户锁定图片位不能重新规划：' + item.slotId);
    if (/https?:\/\/|www\./i.test(JSON.stringify(item))) errors.push('图片位包含了不允许的图片网址：' + item.slotId);
    for (const evidence of item.sourceEvidence || []) {
      const text = String(typeof evidence === 'string' ? evidence : evidence?.text || '').replace(/\s+/g, '').toLowerCase();
      if (!text || !factsText.includes(text)) errors.push('来源依据无法在行程事实中找到：' + item.slotId);
    }
    if (item.useImage !== false && !(item.searchQueries || []).some((query) => String(query?.query || query).trim())) errors.push('缺少搜索词：' + item.slotId);
    const slot = allowed.get(item.slotId);
    const sourceDay = slot?.module === 'day' ? input.itineraryFacts.days?.[slot.dayIndex] : null;
    const isReturnDay = sourceDay && ['inflight', 'none'].includes(sourceDay.overnightType);
    if (isReturnDay && /(?:今晚入住|入住|住宿).{0,8}(?:飞机|航班)|(?:飞机|航班).{0,8}(?:作为|视为).{0,4}住宿/.test(JSON.stringify(item))) errors.push('返程图片位不能规划入住飞机：' + item.slotId);
  }
  for (const slot of input.layoutSlots) if (!seen.has(slot.slotId)) errors.push('缺少图片位规划：' + slot.slotId);
  return { valid: errors.length === 0, errors };
}

function emptyBlueprint(input, reason) {
  return { version: IMAGE_BLUEPRINT_VERSION, journeyStrategy: { positioning: '', audience: '', coreSellingPoints: [], visualKeywords: [], tone: '', emotionalArc: [], avoidRepetition: [] }, slots: input.layoutSlots.map((slot) => ({ slotId: slot.slotId, useImage: false, reason })) };
}

async function callPlanner({ input, prompt, apiKey, baseUrl, model, correctionErrors }) {
  const messages = [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(input) }];
  if (correctionErrors?.length) messages.push({ role: 'user', content: '上一次输出未通过程序校验。只修正这些错误并重新输出完整 JSON：' + correctionErrors.join('；') });
  const profile = modelTaskProfile('imageBlueprint');
  const result = await copyTaskQueue.add(() => requestDeepSeekJson({ apiKey, baseUrl, model, messages, reasoningEffort: profile.reasoningEffort, thinkingType: profile.thinkingType, maxTokens: 16000 }), { taskId: 'visual-blueprint' });
  return { blueprint: result.json, usage: result.usage, attemptUsages: result.attemptUsages || [], requestProfile: result.requestProfile };
}

export async function planImageBlueprint(data, { root, apiKey, baseUrl, model, force = false } = {}) {
  const input = buildBlueprintInput(data);
  const factsFingerprint = fingerprint(input.itineraryFacts);
  const slotsFingerprint = fingerprint(input.layoutSlots);
  const key = cacheKey(IMAGE_BLUEPRINT_VERSION, IMAGE_BLUEPRINT_PROMPT_VERSION, model, factsFingerprint, slotsFingerprint);
  const cache = await createImageResearchCache(root);
  if (!force && data.imageBlueprint?.meta?.cacheKey === key) return { data, blueprint: data.imageBlueprint, cached: true };
  const cached = !force && cache.get('blueprint', key);
  if (cached) return { data: { ...data, imageBlueprint: cached }, blueprint: cached, cached: true };
  const prompt = await readFile(path.join(root, 'prompts', 'image-blueprint-planner.md'), 'utf8');
  const artifactDirectory = path.join(root, 'output', 'image-blueprints');
  await mkdir(artifactDirectory, { recursive: true });
  const persist = async (blueprint) => {
    const artifactId = randomUUID();
    const artifactFile = path.join(artifactDirectory, artifactId + '-image-blueprint.json');
    const saved = { ...blueprint, meta: { ...(blueprint.meta || {}), artifactId, artifactUrl: '/api/image-blueprints/' + artifactId } };
    await writeFile(artifactFile, JSON.stringify({ input, blueprint: saved }, null, 2), 'utf8');
    return saved;
  };
  let lastErrors = [];
  let usage = null;
  let requestProfile = modelTaskProfile('imageBlueprint');
  const requestAttempts = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await callPlanner({ input, prompt, apiKey, baseUrl, model, correctionErrors: attempt === 2 ? lastErrors : null });
      usage = result.usage;
      requestProfile = result.requestProfile || requestProfile;
      requestAttempts.push(...result.attemptUsages);
      const validation = validateImageBlueprint(result.blueprint, input);
      if (validation.valid) {
        const blueprint = await persist({ ...result.blueprint, meta: { version: IMAGE_BLUEPRINT_VERSION, model, generatedAt: new Date().toISOString(), promptVersion: IMAGE_BLUEPRINT_PROMPT_VERSION, factsFingerprint, layoutSlotsFingerprint: slotsFingerprint, cacheKey: key, validationAttempts: attempt } });
        await cache.set('blueprint', key, blueprint);
        return { data: { ...data, imageBlueprint: blueprint }, blueprint, cached: false, usage, attemptUsages: requestAttempts, requestProfile };
      }
      lastErrors = validation.errors;
    }
  } catch (error) { lastErrors = [error?.name === 'AbortError' ? '视觉蓝图生成超时' : error?.message || String(error)]; }
  const blueprint = await persist({ ...emptyBlueprint(input, '视觉蓝图未通过校验，按规则留空'), meta: { version: IMAGE_BLUEPRINT_VERSION, model, generatedAt: new Date().toISOString(), promptVersion: IMAGE_BLUEPRINT_PROMPT_VERSION, factsFingerprint, layoutSlotsFingerprint: slotsFingerprint, cacheKey: key, validationAttempts: 2, errors: lastErrors } });
  return { data: { ...data, imageBlueprint: blueprint }, blueprint, cached: false, failed: true, errors: lastErrors, usage, attemptUsages: requestAttempts, requestProfile };
}
