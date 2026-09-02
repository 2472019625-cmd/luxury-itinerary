import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { buildLayoutImageSlots, getSlotImage } from '../src/lib/imageSlots.js';
import { selectCustomerRenderData } from './customer-render-data.mjs';
import { reviewFinalOutputData } from './final-output-qa.mjs';

async function renderActualLayout(data, { root, origin, runId, signal }) {
  const jobs = path.join(root, '.jobs');
  const directory = path.join(root, 'output', 'final-reviews');
  await mkdir(jobs, { recursive: true }); await mkdir(directory, { recursive: true });
  const dataFile = path.join(jobs, 'final-review-' + runId + '.json');
  const outputFile = path.join(directory, runId + '-actual-2000.png');
  const qaFile = path.join(directory, runId + '-layout-qa.json');
  await writeFile(dataFile, JSON.stringify(selectCustomerRenderData(data)), 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'renderer', 'render.mjs'), '--width=2000', '--dataset=workspace', '--data-file=' + dataFile, '--output=' + outputFile, '--qa-output=' + qaFile, '--origin=' + origin], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
      const cancel = () => { child.kill(); const error = new DOMException('成品渲染已取消', 'AbortError'); reject(error); };
      signal?.addEventListener('abort', cancel, { once: true });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(errors.trim().split('\n').slice(-3).join(' ') || '实际长图生成失败')));
    });
  } finally { await unlink(dataFile).catch(() => {}); }
  const layoutQa = JSON.parse(await readFile(qaFile, 'utf8'));
  return { outputFile, layoutQa, qaFile };
}

async function previewSegments(file) {
  const metadata = await sharp(file).metadata();
  const height = metadata.height || 1;
  const segmentHeight = Math.ceil(height / Math.min(5, Math.max(1, Math.ceil(height / 9000))));
  const images = [];
  for (let top = 0; top < height; top += segmentHeight) {
    const h = Math.min(segmentHeight, height - top);
    const buffer = await sharp(file).extract({ left: 0, top, width: metadata.width, height: h }).resize({ width: 900 }).jpeg({ quality: 72 }).toBuffer();
    images.push('data:image/jpeg;base64,' + buffer.toString('base64'));
  }
  return { width: metadata.width, height, images };
}

function parseJson(content) {
  return JSON.parse(String(content || '').trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, ''));
}

export async function reviewFinalLayout(data, { root, origin, apiKey, baseUrl, model, onProgress = () => {}, onCapabilityCall = () => {}, signal } = {}) {
  const runId = randomUUID();
  onProgress({ stage: 'final_review', currentAction: '正在生成实际 2000px 长图进行图片复查' });
  const { outputFile, layoutQa, qaFile } = await renderActualLayout(data, { root, origin, runId, signal });
  const preview = await previewSegments(outputFile);
  const outputQa = reviewFinalOutputData(data, layoutQa, { allowCopyReviewPending: true });
  const slots = buildLayoutImageSlots(data);
  const placements = slots.map((slot) => {
    const image = getSlotImage(data, slot);
    return { slotId: slot.slotId, label: slot.label, module: slot.module, adjacentText: slot.adjacentText, locked: Boolean(data.imageLocks?.[slot.slotId]), imageSource: image?.src || null };
  });
  const duplicateSources = placements.filter((item) => item.imageSource).filter((item, index, array) => array.findIndex((other) => other.imageSource === item.imageSource) !== index).map((item) => item.slotId);
  if (!apiKey || !placements.some((item) => item.imageSource)) return { runId, outputFile, qaFile, layoutQa, width: preview.width, height: preview.height, failedSlotIds: duplicateSources, warnings: [], modelReviewed: false, outputQa };
  const content = [{ type: 'text', text: '检查这张实际2000px客户行程长图中的图片。只报告明确放错模块、与相邻文字不符、错误地点酒店主体交通、重复、严重裁切、封面不代表旅程、双图内容相同或明显版面失衡的图片位。不要因缺图空状态本身判错。只输出JSON：{"failedSlotIds":[],"reasons":{},"warnings":[]}。图片位清单：' + JSON.stringify(placements) }, ...preview.images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  const callId = randomUUID();
  const callStartedAt = Date.now();
  onCapabilityCall({ phase: 'started', capabilityId: 'visual_auditor', callId, stage: 'render', target: 'final-2000px-layout' });
  let response;
  let result;
  try {
    response = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: false, do_sample: false, reasoning_effort: 'low', thinking: { type: 'enabled', clear_thinking: false }, max_tokens: 3000, response_format: { type: 'json_object' } }), signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || '实际长图图片复查失败');
    result = parseJson(payload?.choices?.[0]?.message?.content);
    onCapabilityCall({ phase: 'finished', capabilityId: 'visual_auditor', callId, stage: 'render', target: 'final-2000px-layout', durationMs: Date.now() - callStartedAt, attemptCount: 1 });
  } catch (error) {
    onCapabilityCall({ phase: 'finished', capabilityId: 'visual_auditor', callId, stage: 'render', target: 'final-2000px-layout', durationMs: Date.now() - callStartedAt, attemptCount: 1, failed: true, cancelled: error?.name === 'AbortError' || signal?.aborted, reason: error?.message || String(error) });
    throw error;
  }
  const allowed = new Set(slots.map((slot) => slot.slotId));
  const lockedWarnings = [];
  const failedSlotIds = [...new Set([...(result.failedSlotIds || []), ...duplicateSources])].filter((slotId) => {
    if (!allowed.has(slotId)) return false;
    if (data.imageLocks?.[slotId]) { lockedWarnings.push(slotId + ' 为用户锁定图片，系统未自动替换'); return false; }
    return true;
  });
  return { runId, outputFile, qaFile, layoutQa, width: preview.width, height: preview.height, failedSlotIds, reasons: result.reasons || {}, warnings: [...(result.warnings || []), ...lockedWarnings], modelReviewed: true, outputQa };
}
