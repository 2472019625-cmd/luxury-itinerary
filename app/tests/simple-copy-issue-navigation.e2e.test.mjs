import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { createAgentPlannerServer } from "../server/agent-planner-app.mjs";
import { fixture } from "./support/manual-image-fixture.mjs";

for (const { useSpotCopy, fieldLabel } of [
  { useSpotCopy: true, fieldLabel: "图片下方文字" },
  { useSpotCopy: false, fieldLabel: "卡片标题" },
]) test(`视觉卡文案待办定位 DAY 卡片并聚焦${fieldLabel}`, async (t) => {
  const browserPath = [process.env.LUXURY_TRAVEL_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(existsSync);
  if (!browserPath) return t.skip("未找到 Chrome 或 Edge");
  const value = await fixture();
  const slotId = "image:day:1:primary";
  const targetId = `copy:visual:${slotId}`;
  const plan = value.store.getPlan(value.projectId, "plan-manual-images");
  value.store.activatePlan(value.projectId, {
    ...plan,
    planId: "plan-navigation-test",
    copyTasks: [{ targetId, targetPath: "simpleImageSlotBindings.image_day_1_primary", moduleType: "visual_card", layoutHints: { placement: "visual_card", slotId }, required: true }],
    imageSlots: plan.imageSlots.map((slot) => slot.slotId === slotId ? { ...slot, primaryVisualSubject: "花豹追踪" } : slot),
  });
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.data.simpleImageSlotBindings = { ...plan.slotBindings, [slotId]: { ...plan.slotBindings[slotId], visualSubject: "花豹追踪", useSpotCopy } };
  result.unresolvedItems = [{ kind: "copy", id: targetId, required: true, status: "failed" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const runtime = createAgentPlannerServer({ port: 0, workspaceRoot: path.join(value.root, "agent"), simpleStore: value.store, auth: { enabled: false } });
  await new Promise((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  let browser;
  t.after(async () => {
    await browser?.close();
    await new Promise((resolve) => runtime.server.close(resolve));
    await rm(value.root, { recursive: true, force: true });
  });
  browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--disable-gpu"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${runtime.server.address().port}/simple/projects/${value.projectId}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".editor-issues-trigger");
  await page.click(".editor-issues-trigger");
  const issue = await page.$eval(".editor-issues-list article", (node) => node.innerText);
  assert.match(issue, /DAY 01 · 花豹追踪 · 体验卡片文案/);
  await page.click(".editor-issues-list article .editor-issues-row-actions button");
  await page.waitForFunction(() => document.querySelector('.day-card-editor-item[data-day-slot-id="image:day:1:primary"]')?.classList.contains("is-active"));
  await page.waitForFunction((label) => document.activeElement?.closest("label")?.innerText?.includes(label), {}, fieldLabel);
  const focused = await page.evaluate(() => ({
    toolbar: document.querySelector(".editor-inspector-toolbar")?.innerText,
    field: document.activeElement?.closest("label")?.innerText,
  }));
  assert.match(focused.toolbar, /DAY 01/);
  assert.match(focused.field, new RegExp(fieldLabel));
});
