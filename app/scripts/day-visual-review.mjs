import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';
import { AgentPlanStore } from '../server/agent-plan-store.mjs';
import { failedHardRequirement } from '../server/simple-image-skill.mjs';

const [projectId, origin = 'http://127.0.0.1:4175'] = process.argv.slice(2);
if (!projectId) throw new Error('projectId required');
const response = await fetch(`${origin}/api/simple/projects/${projectId}/manual-images`);
const payload = await response.json();
if (!response.ok) throw new Error(payload.error);
const data = payload.project.data;
const directory = path.resolve('../audit/evidence/2026-09-07-day-visual-alignment', projectId);
await fs.mkdir(directory, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--disable-gpu'] });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${origin}/simple/projects/${projectId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.day-section');
  const counts = await page.$$eval('.day-section', days => days.map(day => day.querySelectorAll('.spot-card').length));
  const cardPresentation = await page.$$eval('.day-section', days => days.map(day => [...day.querySelectorAll('.spot-card')].map(card => ({ title: card.querySelector('h4')?.textContent, description: card.querySelector('.spot-copy p')?.textContent, statusBadgeCount: card.querySelectorAll('.experience-status').length }))));
  if (cardPresentation.flat().some(card => card.statusBadgeCount)) throw new Error('DAY cards must not display status badges');
  const expected = data.days.map((day, index) => dayVisualCards(day, index, data.simpleImageSlotBindings));
  const customer = selectCustomerRenderData(data);
  const customerProjectionMatch = customer.days.every((day, index) => JSON.stringify(day.spots.map(s => ({ title: s.name, description: s.experience || s.description || '' }))) === JSON.stringify(cardPresentation[index].map(({ title, description }) => ({ title, description }))));
  if (!customerProjectionMatch) throw new Error('Customer projection and Step4 cards differ');
  if (JSON.stringify(counts) !== JSON.stringify(expected.map(cards => cards.length))) throw new Error(`Card count mismatch ${counts}`);
  for (const [index, section] of (await page.$$('.day-section')).entries()) {
    const card = await section.$('.spot-card');
    if (card) await card.screenshot({ path: path.join(directory, `day-${index + 1}-card.png`) });
  }
  const clicks = [];
  for (const [dayIndex, cards] of expected.entries()) {
    for (const card of cards) {
      const selector = `.day-section [data-edit-path="days.${dayIndex}.spots.${card.spotIndex}"][data-edit-image="${card.imageIndex}"]`;
      await page.click(selector);
      await page.waitForSelector('.image-picker-modal');
      const title = await page.$eval('.image-picker-modal h2', node => node.textContent);
      if (title !== card.spot.name) throw new Error(`Wrong picker target: ${title} != ${card.spot.name}`);
      const nav = await page.$$eval('.image-picker-modal nav button', buttons => buttons.map(button => button.textContent));
      const controls = await page.$eval('.image-picker-modal', modal => ({ upload: !!modal.querySelector('input[type=file]'), research: modal.querySelector('footer button')?.textContent, candidates: modal.querySelectorAll('.image-picker-grid > button').length }));
      clicks.push({ day: dayIndex + 1, slotId: card.slotId, imageIndex: card.imageIndex, title, nav, controls });
      await page.click('.image-picker-modal header button');
    }
  }
  await page.screenshot({ path: path.join(directory, 'step4.png'), fullPage: false });
  const evidence = { projectId, executionRunId: payload.executionRunId, counts, clicks, errors, customerProjectionMatch, canEnterFinal: payload.canEnterFinal, unresolvedRequiredSlotIds: payload.unresolvedRequiredSlotIds, verifiedAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, 'browser-check.json'), JSON.stringify(evidence, null, 2));
  if (errors.length) throw new Error(errors.join('; '));
  const store = new AgentPlanStore('output/simple-pipeline/projects');
  const project = store.getProject(projectId);
  const plan = store.getPlan(projectId, project.activePlanId);
  const final = store.getFinalResult(projectId, project.activeExecutionRunId);
  const attemptsDir = path.join(store.projectDir(projectId), 'attempts');
  const attempts = await Promise.all((await fs.readdir(attemptsDir)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(attemptsDir, name), 'utf8'))));
  const raw = attempts.find(attempt => attempt.validation?.valid && attempt.rawModelPlan)?.rawModelPlan || attempts.at(-1)?.rawModelPlan;
  const source = JSON.parse(await fs.readFile(store.sourceDataFile(projectId), 'utf8')).data;
  const days = data.days.map((day, index) => {
    const slots = plan.imageSlots.filter(slot => slot.moduleType === 'day' && slot.visualContext.dayIndex === index);
    const plannerSlots = (raw?.imagePlan?.slots || []).filter(slot => slot.role === `day:${index + 1}` || slot.role.startsWith(`day:${index + 1}:`));
    return { day: index + 1, dayRole: plan.dayRoles.find(role => role.index === index), plannerSlots,
      slots: slots.map(slot => { const result = final.imageExecution.results.find(result => result.slotId === slot.slotId); return {
        slotId: slot.slotId, tier: slot.visualTier, required: slot.required, subject: slot.subject, location: slot.location,
        searchIntent: slot.searchIntent, visualGoal: slot.visualGoal, sourceEvidence: slot.sourceEvidence,
        queriesUsed: result?.queriesUsed || [], status: result?.status, selected: result?.selected || null,
        failureReason: result?.selected ? null : result?.matchReason || result?.technicalStatus,
        rejections: (result?.candidates || []).filter(candidate => candidate.rejection).map(candidate => ({ subject: candidate.actualSubject, reason: candidate.rejection })),
      }; }),
      ordinarySpots: (source.days[index].spots || []).filter(spot => !slots.some(slot => slot.subject === spot.name)).map(spot => spot.name),
      cardCount: counts[index], sourceSpotCount: source.days[index].spots.length, storedSpotCount: day.spots.length,
      presentation: cardPresentation[index],
      visualCards: slots.map(slot => {
        const binding = data.simpleImageSlotBindings[slot.slotId];
        const original = day.spots[binding.spotIndex];
        const copy = binding.useSpotCopy !== false ? original : binding;
        const hasImage = Boolean(original.images?.[binding.imageIndex]?.src);
        return { subject: slot.subject, tier: slot.visualTier, title: binding.visualSubject, status: copy.status, statusLabel: copy.statusLabel, feeBoundary: copy.feeBoundary, description: copy.description || '', hasImage, displayed: binding.required || hasImage };
      }),
    };
  });
  const fidelity = days.every(day => day.plannerSlots.every(planned => day.slots.some(slot => slot.subject === planned.primaryVisualSubject)));
  const hardGuardReplay = final.imageExecution.results.filter(result => result.selected).map(result => ({ slotId: result.slotId, rejection: failedHardRequirement(plan.imageSlots.find(slot => slot.slotId === result.slotId), { ...result.selected.hardJudgment, actualSubject: result.selected.actualSubject, reason: result.selected.matchReason }) }));
  const report = { projectId, executionRunId: project.activeExecutionRunId, status: project.status, plannerSubjectFidelity: fidelity, concurrency: final.concurrency,
    imageMetrics: final.imageExecution.metrics, unresolvedItems: final.unresolvedItems, hardGuardReplay, browser: evidence, days };
  await fs.writeFile(path.join(directory, 'day-visual-evidence.json'), JSON.stringify(report, null, 2));
  const lines = ['# DAY 图片主线对齐：真实回归证据', '', `- projectId: ${projectId}`, `- executionRunId: ${project.activeExecutionRunId}`, `- Step 4: ${origin}/simple/projects/${projectId}`, `- Planner 图片主题完整保真: ${fidelity}`, `- Copy/Image 并发: ${final.concurrency.copyImage.parallel}; 启动间隔 ${final.concurrency.copyImage.startDeltaMs}ms; 重叠 ${final.concurrency.copyImage.overlapMs}ms`, `- Step 5 可进入: ${payload.canEnterFinal}; 必需缺图: ${(payload.unresolvedRequiredSlotIds || []).join(', ') || '无'}`, `- 已逐一点击 ${clicks.length} 个 DAY 图片位（含必需缺图位），打开对应图片选择器；未换图、上传、重搜或导出。`, ''];
  for (const day of days) {
    lines.push(`## DAY ${day.day} 卡片结果`, '', `规划 ${day.slots.length} 个视觉槽；实际显示 ${day.cardCount} 张卡（不展示状态标签）。`, '', '|角色|标题/视觉主体|底层状态|短描述|有图|显示|', '|---|---|---|---|---|---|');
    for (const card of day.visualCards) lines.push(`|${card.tier}|${card.title}|${card.status || '未提供'}|${card.description.replace(/\|/g, '／').replace(/\n/g, ' ')}|${card.hasImage ? '是' : '否'}|${card.displayed ? '是' : '否'}|`);
    lines.push(`## DAY ${day.day}`, '', `dayRole: ${day.dayRole?.role}`, '', `Planner primaryVisualSubject: ${day.plannerSlots.find(slot => slot.required)?.primaryVisualSubject || day.dayRole?.primaryVisualSubject}`, '', `Planner supporting slots: ${day.plannerSlots.filter(slot => !slot.required).map(slot => slot.primaryVisualSubject).join('；') || '无'}`, '');
    for (const slot of day.slots) lines.push(`### ${slot.slotId}`, '', `- tier: ${slot.tier}`, `- subject: ${slot.subject}`, `- location: ${slot.location}`, `- searchIntent: ${slot.searchIntent}`, `- visualGoal: ${slot.visualGoal}`, `- Image 实际搜索: ${slot.queriesUsed.join('；') || '未执行'}`, `- 最终采用: ${slot.selected ? `${slot.selected.actualSubject || slot.subject} — ${slot.selected.localUrl}（来源：${slot.selected.sourcePage}）` : `未采用；${slot.failureReason}`}`, '');
    lines.push(`失败辅助图: ${day.slots.filter(slot => !slot.required && !slot.selected).map(slot => `${slot.subject}（${slot.failureReason}）`).join('；') || '无'}`, '', `没有独立创建图片职责的普通 Spot: ${day.ordinarySpots.join('；') || '无'}。绑定存储使用原 Spot.images，不等于把原 Spot 主题当作视觉主题。`, '', `Frontend 大图片卡数量: ${day.cardCount}；原始/保存 Spot 数量: ${day.sourceSpotCount}/${day.storedSpotCount}`, '');
  }
  await fs.writeFile(path.join(directory, 'DAY1-8-review.md'), lines.join('\n'));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
