import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildSimpleManualImagePayload, chooseSimpleImageCandidate, clearSimpleImage, effectiveUnresolvedItems, researchSimpleImageSlot, saveSimpleDayEditor, saveSimpleHotelImageCrop, saveSimpleImageCrop, saveSimpleModuleVisibility, saveSimpleHotelRegion, saveSimpleHotelStay, uploadSimpleImage } from "../server/simple-manual-images.mjs";
import { planHotelNightChange } from "../src/lib/hotelStayEditing.js";
import { mergeManualImagePayload } from '../src/lib/manualImageState.js';
import { buildLayoutImageSlots } from '../src/lib/imageSlots.js';
import { createManualDayCard, deleteDaySpotPreservingSlots } from '../src/lib/dayEditorState.js';
import { selectCustomerRenderData } from '../server/customer-render-data.mjs';

import { fixture } from './support/manual-image-fixture.mjs';

function installKnowledgePreviewCandidate(value, candidateId = "knowledge-preview-candidate") {
  const candidate = {
    candidateId,
    sourceKind: "knowledge_library",
    sourceTitle: "knowledge-original.jpg",
    imageUrl: "/image-assets/test/knowledge-preview.webp",
    previewUrl: "/image-assets/test/knowledge-preview.webp",
    localPreviewUrl: "/image-assets/test/knowledge-preview.webp",
    localUrl: null,
    originalDownloaded: false,
    originalDownloadStatus: "not_requested",
    knowledgeAssetId: "asset-preview-first",
    knowledgeQueryId: "qry-preview-first",
    knowledgeQueryIds: ["qry-preview-first"],
    knowledgeMatchedFile: { relation: "matched_file", url: null, filename: "knowledge-original.jpg", mimeType: "image/jpeg", versionId: "ver-preview-first" },
    knowledgePreview: { relation: "preview", url: null, filename: "knowledge-preview.webp", mimeType: "image/webp", versionId: "ver-preview-first" },
    autoReviewStatus: "approved_not_selected",
    hardJudgment: { locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true },
  };
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const cover = result.imageExecution.results.find((item) => item.slotId === "image:cover:primary");
  cover.candidates.push(candidate);
  cover.manualAction.selectableCandidates.push(candidate);
  const unresolved = result.unresolvedItems.find((item) => item.id === "image:cover:primary");
  unresolved.selectableCandidateIds.push(candidateId);
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  return candidate;
}

test("自动规划的必需主图可删除并持久化，但保留待补图门禁", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" });
  await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render });
  const cleared = await clearSimpleImage({ ...value, slotId: "image:cover:primary", expectedSrc: value.candidate.localUrl, render });
  const reloaded = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(cleared.project.data.heroImage, "");
  assert.equal(reloaded.project.data.heroImage, "");
  assert.equal(reloaded.project.data.imageLocks["image:cover:primary"].source, "user_cleared");
  assert.ok(reloaded.unresolvedRequiredSlotIds.includes("image:cover:primary"));
  assert.equal(reloaded.canEnterFinal, false);
  await assert.rejects(clearSimpleImage({ ...value, slotId: "image:cover:primary", expectedSrc: value.candidate.localUrl, render }), { code: "image_clear_image_changed" });
});

test("用户主动删除 DAY 主图后纯文字正式交付，自动缺图仍阻断", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const renderModes = [];
  const render = async ({ mode, data }) => {
    renderModes.push(mode);
    if (mode === "final" && data.imageLocks?.["image:day:1:primary"]?.source === "user_cleared") assert.equal(selectCustomerRenderData(data).days[0].spots.length, 0);
    return { status: "success", mode, outputPath: "test.png" };
  };
  await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render });
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).canEnterFinal, false);
  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#8b6f47" } }).jpeg().toBuffer();
  const uploaded = await uploadSimpleImage({ ...value, slotId: "image:day:1:primary", dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "day.jpg", render });
  assert.equal(uploaded.canEnterFinal, true);
  const source = uploaded.project.data.days[0].spots[0].images[0].src;
  const cleared = await clearSimpleImage({ ...value, slotId: "image:day:1:primary", expectedSrc: source, render });
  const reloaded = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(cleared.project.data.days[0].spots[0].images[0], null);
  assert.equal(reloaded.project.data.imageLocks["image:day:1:primary"].source, "user_cleared");
  assert.equal(reloaded.project.data.imageReview.slots.find((slot) => slot.slotId === "image:day:1:primary").status, "user_removed");
  assert.ok(!reloaded.unresolvedRequiredSlotIds.includes("image:day:1:primary"));
  assert.equal(reloaded.canEnterFinal, true);
  assert.equal(reloaded.pipelineStatus, "complete");
  assert.equal(reloaded.project.data.simpleImageSlotBindings["image:day:1:primary"].required, false);
  assert.deepEqual(selectCustomerRenderData(reloaded.project.data).days[0].spots, []);
  assert.equal(renderModes.at(-1), "final");
});

test("自动规划的可选图片删除后不新增必需待处理", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" });
  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#8b6f47" } }).jpeg().toBuffer();
  const uploaded = await uploadSimpleImage({ ...value, slotId: "image:day:1:supporting:1", dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "optional.jpg", render });
  const src = uploaded.project.data.days[0].spots[0].images[1].src;
  const cleared = await clearSimpleImage({ ...value, slotId: "image:day:1:supporting:1", expectedSrc: src, render });
  assert.equal(cleared.project.data.days[0].spots[0].images[1], null);
  assert.ok(!cleared.unresolvedRequiredSlotIds.includes("image:day:1:supporting:1"));
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.days[0].spots[0].images[1], null);
});

test("保存先于慢 Renderer 返回；新版本不被旧渲染覆盖", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const render = async ({ mode }) => { if (++calls === 1) await wait; return { status: 'success', mode, outputPath: `render-${calls}.png` }; };
  const first = await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render, deferRender: true });
  assert.equal(first.renderPending, true);
  assert.equal(first.canEnterFinal, false);
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.heroImage, value.candidate.localUrl);
  const uploadBuffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: '#8b6f47' } }).jpeg().toBuffer();
  const secondPromise = uploadSimpleImage({ ...value, slotId: 'image:day:1:primary', dataUrl: `data:image/jpeg;base64,${uploadBuffer.toString('base64')}`, fileName: 'day-safe.jpg', render });
  // Release only once the second binding has really been committed.
  while (value.store.getFinalResult(value.projectId, value.executionRunId).manualImageCompletion.version < 2) await new Promise(resolve => setTimeout(resolve, 5));
  release();
  const second = await secondPromise;
  assert.equal(second.project.data.heroImage, value.candidate.localUrl);
  assert.match(second.project.data.days[0].spots[0].images[0].src, /^\/image-assets\/simple-manual-/);
  assert.equal(second.manualVersion, 2);
  assert.equal(second.canEnterFinal, true);
});

test("后台重搜保留等待期间的新选择，合并候选并反馈新增数", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'test.png' });
  const searching = researchSimpleImageSlot({ ...value, slotId: 'image:cover:primary', render, runImage: async () => { await wait; return { results: [{ slotId: 'image:cover:primary', status: 'not_found', candidates: [{ candidateId: 'new', localUrl: '/image-assets/test/new.jpg' }] }] }; } });
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render });
  release();
  const result = await searching;
  assert.equal(result.newCandidateCount, 1);
  assert.equal(result.project.data.heroImage, value.candidate.localUrl);
  assert.ok(result.project.data.imageCandidates.some(item => item.candidateId === 'new'));
});

test("Renderer 异常不丢图片；保存异常必须抛出", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render: async () => { throw new Error('render offline'); } });
  assert.equal(result.project.data.heroImage, value.candidate.localUrl);
  assert.equal(result.renderPending, false);
  assert.equal(result.canEnterFinal, false);
  value.store.saveFinalResult = () => { throw new Error('disk full'); };
  await assert.rejects(chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId }), /disk full/);
});

test("可见体验卡文案失败进入必需待处理，旧贴士空位不计数", () => {
  const data = { days: [{ dayNotices: [], spots: [{ images: [{ src: "/image-assets/day.jpg" }] }] }], simpleImageSlotBindings: { "image:day:1:supporting:1": { module: "day", dayIndex: 0, spotIndex: 0, imageIndex: 0 } } };
  const items = effectiveUnresolvedItems([
    { kind: "copy", id: "copy:visual:image:day:1:supporting:1", required: false },
    { kind: "copy", id: "copy:notice", targetPath: "days.0.dayNotices.0.text", required: true },
  ], data);
  assert.equal(items.length, 1);
  assert.equal(items[0].required, true);
});

test("酒店四项已启用时旧介绍问题不再待处理；已删除人工卡片的缺图记录清除", () => {
  const manualSlotId = "manual:day:1:deleted:primary";
  const plannedSlotId = "image:day:1:primary";
  const data = { hotels: [{ factRows: [] }], days: [{ spots: [] }], simpleImageSlotBindings: { [plannedSlotId]: { module: "day", dayIndex: 0 } } };
  const plan = { imageSlots: [{ slotId: plannedSlotId, required: true }] };
  const items = effectiveUnresolvedItems([
    { kind: "copy", id: "copy:hotel:h1", targetPath: "hotels.0.editorialCopy", required: true },
    { kind: "copy", id: "copy:hotel:h1:proof-points", targetPath: "hotels.0.proofPoints", required: true },
    { kind: "image", id: manualSlotId, required: true },
    { kind: "copy", id: `copy:visual:${manualSlotId}`, required: true },
    { kind: "image", id: plannedSlotId, required: true },
  ], data, plan);
  assert.deepEqual(items.map((item) => item.id), [plannedSlotId]);
});

test("酒店裁切只有确认后保存，重读仍保留并拒绝旧图提交", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.data.hotels = [{ id: "h1", officialName: "Hotel", images: [{ src: "/image-assets/hotel.jpg", focus: "50% 50%" }] }];
  result.data.simpleImageSlotBindings = {};
  result.data.simpleImageSlotBindings["image:hotel:h1:primary"] = { module: "hotel", itemIndex: 0, imageIndex: 0, fieldPath: "hotels.0.images.0" };
  const active = value.store.getProject(value.projectId);
  const plan = value.store.getPlan(value.projectId, active.activePlanId);
  plan.imageSlots.push({ slotId: "image:hotel:h1:primary", moduleType: "hotel", required: false });
  plan.slotBindings["image:hotel:h1:primary"] = result.data.simpleImageSlotBindings["image:hotel:h1:primary"];
  value.store.activatePlan(value.projectId, { ...plan, planId: "plan-crop-test" });
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const crop = { x: 0.1, y: 0.2, width: 0.6, height: 0.4 };
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).data.hotels[0].images[0].crop, undefined);
  await saveSimpleHotelImageCrop({ ...value, slotId: "image:hotel:h1:primary", expectedSrc: "/image-assets/hotel.jpg", crop, render: async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" }) });
  assert.deepEqual(value.store.getFinalResult(value.projectId, value.executionRunId).data.hotels[0].images[0].crop, crop);
  await assert.rejects(saveSimpleHotelImageCrop({ ...value, slotId: "image:hotel:h1:primary", expectedSrc: "/image-assets/old.jpg", crop }), { code: "hotel_crop_image_changed" });
});

test("封面、餐饮、交通和每日图片裁切确认后均持久化", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.data.heroImage = "/image-assets/cover.jpg";
  result.data.diningExperiences = [{ id: "d1", title: "晚餐", images: [{ src: "/image-assets/dining.jpg" }] }];
  result.data.transportSummary = [{ id: "t1", category: "商务车", images: [{ src: "/image-assets/transport.jpg" }] }];
  result.data.days[0].spots[0].images = [{ src: "/image-assets/day.jpg" }];
  const bindings = {
    "image:cover:primary": { module: "cover", imageIndex: 0, fieldPath: "heroImage" },
    "image:dining:d1:primary": { module: "dining", itemIndex: 0, imageIndex: 0, fieldPath: "diningExperiences.0.images.0" },
    "image:transport:t1:primary": { module: "transport", itemIndex: 0, imageIndex: 0, fieldPath: "transportSummary.0.images.0" },
    "image:day:1:primary": { module: "day", dayIndex: 0, spotId: "spot-1", spotIndex: 0, imageIndex: 0, fieldPath: "days.0.spots.0.images.0" },
  };
  result.data.simpleImageSlotBindings = bindings;
  const active = value.store.getProject(value.projectId);
  const plan = value.store.getPlan(value.projectId, active.activePlanId);
  plan.imageSlots.push({ slotId: "image:dining:d1:primary", moduleType: "dining", required: false });
  plan.imageSlots.push({ slotId: "image:transport:t1:primary", moduleType: "transport", required: false });
  plan.slotBindings = bindings;
  value.store.activatePlan(value.projectId, { ...plan, planId: "plan-all-crops" });
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const crop = { x: 0.1, y: 0.2, width: 0.6, height: 0.4 };
  const cases = [
    ["image:cover:primary", "/image-assets/cover.jpg", (data) => data.heroCrop],
    ["image:dining:d1:primary", "/image-assets/dining.jpg", (data) => data.diningExperiences[0].images[0].crop],
    ["image:transport:t1:primary", "/image-assets/transport.jpg", (data) => data.transportSummary[0].images[0].crop],
    ["image:day:1:primary", "/image-assets/day.jpg", (data) => data.days[0].spots[0].images[0].crop],
  ];
  for (const [slotId, expectedSrc, readCrop] of cases) {
    await saveSimpleImageCrop({ ...value, slotId, expectedSrc, crop, render: async ({ mode }) => ({ status: "success", mode, outputPath: "test.png" }) });
    assert.deepEqual(readCrop(value.store.getFinalResult(value.projectId, value.executionRunId).data), crop, slotId);
  }
  await assert.rejects(saveSimpleImageCrop({ ...value, slotId: "image:cover:primary", expectedSrc: "/image-assets/old.jpg", crop }), { code: "image_crop_image_changed" });
});

test("隐藏餐饮持久化并使用过滤后的数据重新生成，原始内容保留", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.data.diningExperiences = [{ id: "d1", title: "晚餐", images: [] }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  let renderedData;
  const answer = await saveSimpleModuleVisibility({ ...value, module: "dining", visible: false, render: async ({ data, mode }) => { renderedData = data; return { status: "success", mode, outputPath: "new.png" }; } });
  assert.equal(answer.visibility.dining, false);
  assert.deepEqual(renderedData.diningExperiences, []);
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).data.diningExperiences.length, 1);
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.visibility.dining, false);
  await assert.rejects(saveSimpleModuleVisibility({ ...value, module: "days", visible: false }), { code: "module_visibility_invalid" });
});

test("正式渲染数据保留移除缺图占位框的标记", () => {
  const customer = selectCustomerRenderData({ title: "行程", days: [], transportSummary: [{ category: "草原飞机", images: [] }], suppressMissingImagePlaceholders: true });
  assert.equal(customer.suppressMissingImagePlaceholders, true);
  assert.equal(customer.transportSummary[0].images.length, 0);
});

test("返回图片载荷保留等待期间文案，丢弃迟到的旧版本", async () => {
  const current = { manualVersion: 2, project: { data: { title: '正在编辑的标题', heroImage: 'old', days: [] } } };
  const incoming = { manualVersion: 3, project: { data: { title: '服务器旧标题', heroImage: 'new', simpleImageSlotBindings: { cover: { module: 'cover', fieldPath: 'heroImage' } } } } };
  const next = mergeManualImagePayload(current, incoming);
  assert.equal(next.project.data.title, '正在编辑的标题');
  assert.equal(next.project.data.heroImage, 'new');
  assert.equal(mergeManualImagePayload(next, { ...incoming, manualVersion: 1 }), next);
});

test("前端载荷展示人工图片位，并只开放明确可选候选", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.pipelineStatus, "partial");
  assert.equal(payload.unresolvedRequiredCount, 2);
  assert.equal(payload.canEnterEditor, true);
  assert.equal(payload.canEnterFinal, false);
  assert.equal(payload.project.data.requiredImageGate.passed, false);
  assert.equal(payload.project.data.simpleImageSlotBindings["image:cover:primary"].fieldPath, "heroImage");
  assert.equal(payload.imageReview.slots.length, 2);
  const candidates = payload.imageReview.slots[0].candidates;
  assert.equal(candidates.find((item) => item.candidateId === value.candidate.candidateId).status, "manual_review");
  const hardCandidate = candidates.find((item) => item.candidateId === value.hardCandidate.candidateId);
  assert.equal(hardCandidate.status, "hard_rejected");
  assert.equal(hardCandidate.autoReviewStatus, "auto_rejected");
  assert.equal(hardCandidate.manualOnly, true);
  assert.ok(hardCandidate.localPreviewUrl);
});

test("Step4 保留全部已规划 DAY 图片位并区分可选缺图状态", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.unresolvedRequiredCount, 2);
  assert.equal(payload.imageReview.slots.length, 3);
  const optional = payload.imageReview.slots.find((slot) => slot.slotId === "image:day:1:supporting:1");
  assert.equal(optional.required, false);
  assert.equal(optional.primaryVisualSubject, "花豹追踪");
  assert.equal(optional.status, "not_found");
  assert.match(payload.project.data.simpleImageSlotBindings[optional.slotId].editorImageStatus, /未找到图片/);
  assert.match(buildLayoutImageSlots(payload.project.data).find((slot) => slot.slotId === optional.slotId).label, /花豹追踪.*未找到图片.*可选/s);
});

test("候选预览只发布本地素材路径，未下载与过滤候选保留原始证据但不展示远程图片", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const remoteCandidates = [
    { candidateId: "web-not-downloaded", imageUrl: "https://images.example.com/unreviewed.jpg", originalDownloadStatus: "not_requested", qualificationStatus: "unreviewed" },
    { candidateId: "web-filtered-before-download", imageUrl: "https://images.example.com/logo.png", candidateStatus: "filtered_before_download", rejection: "ui_resource", originalDownloadStatus: "not_requested", qualificationStatus: "unreviewed" },
    { candidateId: "knowledge-remote-preview", sourceKind: "knowledge_library", imageUrl: "https://images.example.com/knowledge.jpg", previewUrl: "https://images.example.com/knowledge-preview.jpg", knowledgePreview: { url: "https://images.example.com/knowledge-preview.jpg" } },
    { candidateId: "legacy-remote-preview", imageUrl: "https://images.example.com/original.jpg", localPreviewUrl: "https://images.example.com/thumb.jpg", localUrl: "https://images.example.com/local-name-only.jpg", publicUrl: "https://images.example.com/public-name-only.jpg" },
  ];
  const localCandidates = ["localPreviewUrl", "previewUrl", "localUrl", "publicUrl", "imageUrl"].map((field) => ({
    candidateId: `local-${field}`, imageUrl: "https://images.example.com/original.jpg", [field]: "/image-assets/test/selectable.jpg",
  }));
  // A stale remote preview must not hide a valid downloaded local asset.
  localCandidates.push({ candidateId: "local-fallback", localPreviewUrl: "https://images.example.com/stale.jpg", publicUrl: "/image-assets/test/selectable.jpg" });
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results[0].candidates.push(...remoteCandidates, ...localCandidates);
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  for (const collection of [payload.project.data.imageCandidates, payload.imageReview.slots[0].candidates]) {
    for (const original of remoteCandidates) {
      assert.equal(collection.some(item => item.candidateId === original.candidateId), false);
    }
    for (const original of localCandidates) assert.equal(collection.find(item => item.candidateId === original.candidateId).localPreviewUrl, "/image-assets/test/selectable.jpg");
  }
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0].candidates;
  for (const original of [...remoteCandidates, ...localCandidates]) assert.deepEqual(saved.find(item => item.candidateId === original.candidateId), original);
});

test('未下载的命中和硬拒绝图都不冒充可供确认的候选', async (t) => {
  const value = await fixture({ oneSlot: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const cover = result.imageExecution.results[0];
  cover.candidates = [value.hardCandidate, { candidateId: 'remote-only', imageUrl: 'https://example.org/image.jpg', originalDownloadStatus: 'not_requested' }];
  cover.manualAction.selectableCandidates = [];
  const unresolved = result.unresolvedItems.find(item => item.id === cover.slotId);
  unresolved.selectableCandidateIds = [];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  const review = payload.imageReview.slots[0];
  assert.equal(review.status, 'auto_rejected');
  assert.equal(review.candidateCount, 1);
  assert.equal(review.confirmableCandidateCount, 0);
  assert.equal(payload.project.data.imageCandidates.some(item => item.candidateId === 'remote-only'), false);
});

test('换图界面不列出未下载的延后网页命中，运行记录仍保留来源证据', async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const deferred = { candidateId: 'deferred-homepage', imageUrl: 'https://soroi.com/unrelated.jpg', webDownloadAdmission: 'deferred', originalDownloadStatus: 'not_requested' };
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results[0].candidates.push(deferred);
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots[0].candidates.some(candidate => candidate.candidateId === deferred.candidateId), false);
  assert.equal(payload.project.data.imageCandidates.some(candidate => candidate.candidateId === deferred.candidateId), false);
  assert.ok(value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0].candidates.some(candidate => candidate.candidateId === deferred.candidateId));
});

test("Step4 区分候选待选、硬拒绝、审核超时和审核中", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  let result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const optional = result.imageExecution.results.find((item) => item.slotId === "image:day:1:supporting:1");
  optional.candidates = [{ ...value.hardCandidate, candidateId: "optional-hard" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  let payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "auto_rejected");
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === "image:cover:primary").status, "candidate_waiting");

  result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results.find((item) => item.slotId === optional.slotId).candidates = [{ ...value.candidate, candidateId: "optional-timeout", reviewTimeout: true, autoReviewStatus: "review_timeout" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "review_timeout");

  result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.imageExecution.results.find((item) => item.slotId === optional.slotId).candidates = [{ ...value.candidate, candidateId: "optional-pending", autoReviewStatus: "audit_pending" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.imageReview.slots.find((slot) => slot.slotId === optional.slotId).status, "audit_pending");
});

test("图片异步返回不会覆盖用户已编辑的视觉卡标题和说明", () => {
  const current = { manualVersion: 1, project: { data: { heroImage: "", days: [], simpleImageSlotBindings: { slot: { module: "day", fieldPath: "days.0.spots.0.images.0", cardTitle: "客户修改后的标题", cardDescription: "客户修改后的说明" } } } } };
  const incoming = { manualVersion: 2, project: { data: { heroImage: "", days: [], simpleImageSlotBindings: { slot: { module: "day", fieldPath: "days.0.spots.0.images.0", cardTitle: "服务端旧标题", cardDescription: "服务端旧说明", visualSubject: "花豹追踪" } }, imageReview: { slots: [] } } } };
  const merged = mergeManualImagePayload(current, incoming);
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.cardTitle, "客户修改后的标题");
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.cardDescription, "客户修改后的说明");
  assert.equal(merged.project.data.simpleImageSlotBindings.slot.visualSubject, "花豹追踪");
});

test("硬拒绝候选未经风险确认不能人工采用", async (t) => {
  const value = await fixture({ hardOnly: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.hardCandidate.candidateId, render: async () => assert.fail("不应启动 Renderer") }), /不能采用/);
});

test("人工采用只写回目标 slot，剩余 required 未清零时更新可编辑草稿", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  let rendererCalls = 0;
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render: async ({ mode }) => { rendererCalls += 1; assert.equal(mode, "draft"); return { status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }; } });
  assert.equal(rendererCalls, 1);
  assert.equal(payload.pipelineStatus, "partial");
  assert.equal(payload.unresolvedRequiredCount, 1);
  assert.equal(payload.draftRendered, true);
  assert.equal(payload.project.data.heroImage, value.candidate.localUrl);
  assert.equal(payload.imageReview.slots.find((item) => item.slotId === "image:cover:primary").status, "human_selected");
  assert.deepEqual(payload.project.data.days[0].spots[0].images, []);
});

test("人工确认可采用非硬拒绝的待判断候选，跨位移动并保留证据", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(path.join(value.root, 'output/image-assets/test/hard.jpg'), await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#61754b' } }).jpeg().toBuffer());
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'draft.png' });
  const uncertain = { ...value.hardCandidate, candidateId: 'candidate-uncertain', rejection: 'needs_user_judgment', autoRejected: false, hardJudgment: { ...value.hardCandidate.hardJudgment, activityMatch: true, subjectMatch: true } };
  const current = value.store.getFinalResult(value.projectId, value.executionRunId);
  current.imageExecution.results[0].candidates.push(uncertain);
  value.store.saveFinalResult(value.projectId, value.executionRunId, current);
  assert.equal(buildSimpleManualImagePayload(value.store, value.projectId).project.data.imageCandidates.find(c => c.candidateId === value.hardCandidate.candidateId).manualSelectable, false);
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: uncertain.candidateId, manualConfirmed: true, render });
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: uncertain.candidateId, render }), /未确认/);
  const payload = await chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: uncertain.candidateId, manualConfirmed: true, render });
  assert.equal(payload.project.data.heroImage, '');
  assert.equal(payload.project.data.days[0].spots[0].images[0].src, uncertain.localUrl);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[1].selected;
  assert.equal(saved.rejection, 'needs_user_judgment');
  assert.equal(saved.userSelected, true);
  assert.equal(saved.humanDecision.riskConfirmed, true);
  assert.deepEqual(saved.humanDecision.movedFrom, ['image:cover:primary']);
});

test("双列DAY接受850×550原件，人工确认后可移到单列并保留清晰度提示尺寸", async (t) => {
  const value = await fixture({ includeOptionalDay: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: 'draft.png' });
  const large = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#446644' } }).jpeg().toBuffer();
  await uploadSimpleImage({ ...value, slotId: 'image:day:1:primary', dataUrl: `data:image/jpeg;base64,${large.toString('base64')}`, render });
  const small = await sharp({ create: { width: 850, height: 550, channels: 3, background: '#665544' } }).jpeg().toBuffer();
  await writeFile(path.join(value.root, 'output/image-assets/test/day-small.jpg'), small);
  const candidate = { candidateId: 'candidate-day-small', localUrl: '/image-assets/test/day-small.jpg', sourceTitle: '本地测试原件', hardJudgment: { eligible: true, technicalUsable: true } };
  const before = value.store.getFinalResult(value.projectId, value.executionRunId);
  before.imageExecution.results.find((item) => item.slotId === 'image:day:1:supporting:1').candidates.push(candidate);
  value.store.saveFinalResult(value.projectId, value.executionRunId, before);
  const selected = await chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:supporting:1', candidateId: candidate.candidateId, manualConfirmed: true, render });
  assert.equal(selected.project.data.days[0].spots[0].images[1].src, candidate.localUrl);
  const primaryReview = selected.imageReview.slots.find((item) => item.slotId === 'image:day:1:primary');
  assert.equal(primaryReview.resolutionPolicy.minWidth, 575);
  assert.equal(primaryReview.resolutionPolicyByMovedSourceSlotId['image:day:1:supporting:1'].minWidth, 1181);
  assert.equal(primaryReview.resolutionPolicy.allowManualLowResolution, true);
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: candidate.candidateId, render }), (error) => error.code === 'manual_confirmation_required');
  await chooseSimpleImageCandidate({ ...value, slotId: 'image:day:1:primary', candidateId: candidate.candidateId, manualConfirmed: true, render });
  const after = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(after.imageExecution.results.find((item) => item.slotId === 'image:day:1:primary').selected.localUrl, candidate.localUrl);
  assert.equal(after.imageExecution.results.find((item) => item.slotId === 'image:day:1:primary').selected.width, 850);
  assert.equal(after.imageExecution.results.find((item) => item.slotId === 'image:day:1:supporting:1').selected, null);
});

test("单列DAY允许用户上传小图，但损坏图片仍被拒绝且不改变已保存图片", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const small = await sharp({ create: { width: 850, height: 550, channels: 3, background: '#665544' } }).jpeg().toBuffer();
  const uploaded = await uploadSimpleImage({ ...value, slotId: 'image:day:1:primary', dataUrl: `data:image/jpeg;base64,${small.toString('base64')}`, render: async ({ mode }) => ({ status: 'success', mode, outputPath: 'draft.png' }) });
  assert.match(uploaded.project.data.days[0].spots[0].images[0].src, /^\/image-assets\//);
  const before = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(before.imageExecution.results.find((item) => item.slotId === 'image:day:1:primary').selected.width, 850);
  await assert.rejects(() => uploadSimpleImage({ ...value, slotId: 'image:day:1:primary', dataUrl: `data:image/jpeg;base64,${small.subarray(0, 200).toString('base64')}`, render: async () => assert.fail('损坏图片不可渲染') }));
  assert.deepEqual(value.store.getFinalResult(value.projectId, value.executionRunId), before);
});

test("Step4 选择尚未下载原件的知识库 preview 时才下载 matched_file", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const candidate = installKnowledgePreviewCandidate(value);
  let refreshCalls = 0;
  let originalDownloads = 0;
  const payloadBefore = buildSimpleManualImagePayload(value.store, value.projectId);
  const before = payloadBefore.project.data.imageCandidates.find((item) => item.candidateId === candidate.candidateId);
  assert.equal(before.localUrl, null);
  assert.equal(before.localPreviewUrl, "/image-assets/test/knowledge-preview.webp");
  const payload = await chooseSimpleImageCandidate({
    ...value,
    slotId: "image:cover:primary",
    candidateId: candidate.candidateId,
    refreshMatchedFile: async ({ queryIds }) => {
      refreshCalls += 1;
      assert.deepEqual(queryIds, ["qry-preview-first"]);
      return { ...candidate.knowledgeMatchedFile, url: "http://192.168.100.210:9000/original/knowledge-original.jpg?token=fresh" };
    },
    downloadImage: async (item, { directory, publicPrefix }) => {
      originalDownloads += 1;
      assert.match(item.imageUrl, /\/original\/knowledge-original\.jpg/);
      await mkdir(directory, { recursive: true });
      const filePath = path.join(directory, "knowledge-original.jpg");
      await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#79654f" } }).jpeg().toFile(filePath);
      return { ...item, filePath, publicUrl: `${publicPrefix}/knowledge-original.jpg`, sha256: "knowledge-original-hash", width: 1400, height: 900, bytes: 4096, contentType: "image/jpeg" };
    },
    render: async ({ mode }) => ({ status: "success", mode, outputPath: "preview-first-draft.png" }),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(originalDownloads, 1);
  assert.match(payload.project.data.heroImage, /^\/image-assets\/simple-manual-/);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  const selected = saved.imageExecution.results.find((item) => item.slotId === "image:cover:primary").selected;
  assert.equal(selected.originalDownloaded, true);
  assert.equal(selected.originalDownloadStatus, "success");
  assert.equal(selected.knowledgeMatchedFile.url, null);
  assert.equal(saved.imageExecution.metrics.matchedFileDownloadAttempts, 1);
  assert.equal(saved.imageExecution.metrics.matchedFileDownloadSuccess, 1);
});

test("Step4 保留未自动审核的知识库 preview，但不自行升级其内容资格", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const candidate = {
    candidateId: "knowledge-not-auto-reviewed",
    sourceKind: "knowledge_library",
    sourceTitle: "unreviewed-preview.webp",
    localPreviewUrl: "/image-assets/test/unreviewed-preview.webp",
    previewUrl: "/image-assets/test/unreviewed-preview.webp",
    localUrl: null,
    knowledgeQueryId: "qry-unreviewed",
    knowledgeQueryIds: ["qry-unreviewed"],
    knowledgeMatchedFile: { relation: "matched_file", url: null, filename: "unreviewed-original.jpg", versionId: "ver-unreviewed" },
    candidateStatus: "not_auto_reviewed",
    autoReviewStatus: "not_auto_reviewed",
    selected: false,
  };
  result.imageExecution.results.find((item) => item.slotId === "image:cover:primary").candidates.push(candidate);
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  const visible = payload.project.data.imageCandidates.find((item) => item.candidateId === candidate.candidateId);
  assert.ok(visible);
  assert.equal(visible.candidateStatus, "not_auto_reviewed");
  assert.equal(visible.qualificationStatus, "unreviewed");
  assert.equal(visible.manualSelectable, false);
  assert.equal(visible.adoptable, false);
});

test("Step4 延迟下载 matched_file 失败时保留 preview 并记录原件失败", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const candidate = installKnowledgePreviewCandidate(value, "knowledge-preview-download-failed");
  await assert.rejects(() => chooseSimpleImageCandidate({
    ...value,
    slotId: "image:cover:primary",
    candidateId: candidate.candidateId,
    refreshMatchedFile: async () => ({ ...candidate.knowledgeMatchedFile, url: "http://192.168.100.210:9000/original/too-large.jpg" }),
    downloadImage: async () => { throw new Error("文件过大，超过资源上限"); },
    render: async () => assert.fail("原件失败时不应渲染"),
  }), (error) => error.code === "file_too_large");
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  const failed = saved.imageExecution.results.find((item) => item.slotId === "image:cover:primary").candidates.find((item) => item.candidateId === candidate.candidateId);
  assert.equal(failed.localUrl, null);
  assert.equal(failed.localPreviewUrl, "/image-assets/test/knowledge-preview.webp");
  assert.equal(failed.autoReviewStatus, "original_download_failed");
  assert.equal(failed.originalDownloadStatus, "failed");
  assert.equal(failed.originalDownloadFailureCode, "file_too_large");
  assert.equal(saved.imageExecution.metrics.matchedFileDownloadAttempts, 1);
  assert.equal(saved.imageExecution.results.find((item) => item.slotId === "image:cover:primary").selected, null);
});

test("人工选择不能使用损坏文件且不修改项目", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(path.join(value.root, 'output/image-assets/test/selectable.jpg'), 'not an image');
  await assert.rejects(() => chooseSimpleImageCandidate({ ...value, slotId: 'image:cover:primary', candidateId: value.candidate.candidateId, render: async () => assert.fail('不可渲染') }), /损坏/);
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0].selected, null);
});

test("待处理事项透传 Renderer 的具体阻断原因", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.unresolvedItems = [{ kind:"renderer", id:"renderer:2000", required:true, status:"blocked", error:{ code:"renderer_failed", message:"成品检查未通过：DAY 4 正文溢出", details:["DAY 4 正文溢出"] }, qa:{ issues:[{ severity:"blocker", code:"text_overflow", message:"DAY 4 正文溢出" }] } }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  const renderer = payload.blockingItems.find((item) => item.kind === "renderer");
  assert.equal(renderer.label, "2000px 成品检查");
  assert.match(renderer.message, /未通过原因：DAY 4 正文溢出/);
});

test("版面问题逐项列出位置，旧裁切误报提示重新检查", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.unresolvedItems = [{ kind: "renderer", id: "renderer:2000", required: true, status: "blocked", qa: { issues: [
    { severity: "blocker", code: "text_overflow", targetPath: "days.2", message: "DAY 03 的文字超出显示区域" },
    { severity: "blocker", code: "text_overflow", selector: "span.crop-slot-viewport", message: "文字或模块溢出：span.crop-slot-viewport" },
  ] } }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const renderer = buildSimpleManualImagePayload(value.store, value.projectId).blockingItems.filter((item) => item.kind === "renderer");
  assert.equal(renderer.length, 2);
  assert.equal(renderer[0].targetPath, "days.2");
  assert.equal(renderer[0].action, "retry_renderer");
  assert.equal(renderer[1].targetPath, "");
  assert.match(renderer[1].message, /误判/);
  assert.doesNotMatch(renderer[1].message, /crop-slot-viewport/);
});

test("视觉卡文案失败标明 DAY 和图片主题，并指向对应体验卡片", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const existingPlan = value.store.getPlan(value.projectId, "plan-manual-images");
  const slotId = "image:day:1:primary";
  const targetId = `copy:visual:${slotId}`;
  const targetPath = "simpleImageSlotBindings.image_day_1_primary";
  value.store.activatePlan(value.projectId, {
    ...existingPlan,
    planId: "plan-visual-copy-location",
    copyTasks: [{ targetId, targetPath, moduleType: "visual_card", layoutHints: { placement: "visual_card", slotId }, required: true }],
    imageSlots: existingPlan.imageSlots.map((slot) => slot.slotId === slotId ? { ...slot, primaryVisualSubject: "花豹追踪" } : slot),
  });
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.data.simpleImageSlotBindings = { ...existingPlan.slotBindings, [slotId]: { ...existingPlan.slotBindings[slotId], visualSubject: "花豹追踪" } };
  result.unresolvedItems = [{ kind: "copy", id: targetId, required: true, status: "failed", error: { code: "copy_request_failed" } }];
  result.copyExecution.results = [{ targetId, targetPath, status: "failed", error: { code: "copy_request_failed" } }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);

  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.deepEqual(payload.blockingItems.map(({ id, slotId: itemSlotId, targetPath: path, label }) => ({ id, slotId: itemSlotId, targetPath: path, label })), [
    { id: targetId, slotId, targetPath, label: "DAY 01 · 花豹追踪 · 体验卡片文案" },
  ]);

  const editedDay = structuredClone(result.data.days[0]);
  editedDay.spots[0].description = "在向导带领下观察草原野生动物的真实活动。";
  const afterEdit = await saveSimpleDayEditor({
    ...value,
    dayIndex: 0,
    day: editedDay,
    bindings: { [slotId]: result.data.simpleImageSlotBindings[slotId] },
    render: async ({ mode }) => ({ status: "success", mode, outputPath: path.join(value.root, "draft-2000.png"), rendererCalls: 1 }),
  });
  assert.equal(afterEdit.blockingItems.some((item) => item.id === targetId), false);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(saved.copyExecution.results.find((item) => item.targetId === targetId).resolution, "manual_editor");
  assert.equal(saved.data.simpleImageSlotBindings[slotId].cardDescription, editedDay.spots[0].description);

  saved.data.simpleImageSlotBindings[slotId].useSpotCopy = false;
  saved.unresolvedItems.push({ kind: "copy", id: targetId, required: true, status: "failed" });
  saved.copyExecution.results = [{ targetId, targetPath, status: "failed" }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, saved);
  const independentCard = { ...saved.data.simpleImageSlotBindings[slotId], cardTitle: "花豹追踪", cardDescription: "跟随向导观察花豹，了解它在草原上的活动方式。" };
  const afterIndependentEdit = await saveSimpleDayEditor({
    ...value,
    dayIndex: 0,
    day: saved.data.days[0],
    bindings: { [slotId]: independentCard },
    render: async ({ mode }) => ({ status: "success", mode, outputPath: path.join(value.root, "draft-2000.png"), rendererCalls: 1 }),
  });
  assert.equal(afterIndependentEdit.blockingItems.some((item) => item.id === targetId), false);
});

test("旧项目即使只保存通用 Renderer 文案，也从 render QA 恢复具体原因", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.unresolvedItems = [{ kind:"renderer", id:"renderer:2000", required:true, status:"blocked", error:{ code:"renderer_failed", message:"正式成品版面检查未通过" } }];
  result.render = { status:"success", mode:"draft", outputPath:"draft.png", finalAttempt:{ status:"blocked", qa:{ issues:[{ severity:"blocker", code:"image_upscale_excessive", message:"图片放大过多" }, { severity:"blocker", code:"footer_missing", message:"固定品牌页脚缺失" }] } } };
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const renderer = buildSimpleManualImagePayload(value.store, value.projectId).blockingItems.find((item) => item.kind === "renderer");
  assert.match(renderer.message, /固定品牌页脚缺失/);
  assert.doesNotMatch(renderer.message, /图片放大过多/);
});

test("旧项目只有清晰度历史阻断时按新规则直接解除", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  result.outputPath = path.join(value.root, "draft-2000.png");
  result.renderStatus = "success";
  result.unresolvedItems = [{ kind:"renderer", id:"renderer:2000", required:true, status:"blocked", error:{ code:"renderer_failed", message:"正式成品版面检查未通过" } }];
  result.render = { status:"success", mode:"draft", outputPath:result.outputPath, finalAttempt:{ status:"blocked", qa:{ issues:[{ severity:"blocker", code:"image_upscale_excessive", message:"图片放大倍数 1.61，可能不够清晰" }] } } };
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const payload = buildSimpleManualImagePayload(value.store, value.projectId);
  assert.equal(payload.blockingItems.length, 0);
  assert.equal(payload.unresolvedRequiredCount, 0);
  assert.equal(payload.canEnterFinal, true);
  assert.ok(payload.outputUrl);
});

test("只有远程预览的人工候选会在确认时下载原图再替换", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = value.store.getFinalResult(value.projectId, value.executionRunId);
  const candidate = {
    candidateId: "remote-preview-candidate",
    imageUrl: "https://images.example.com/room.jpg",
    localPreviewUrl: "https://images.example.com/room-thumb.jpg",
    sourceTitle: "远程酒店图片",
  };
  result.imageExecution.results[0].candidates.push(candidate);
  value.store.saveFinalResult(value.projectId, value.executionRunId, result);
  const directory = path.join(value.root, "output", "image-assets", `simple-manual-${value.projectId}`);
  const filePath = path.join(directory, "downloaded.jpg");
  const buffer = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#896a42" } }).jpeg().toBuffer();
  const payload = await chooseSimpleImageCandidate({
    ...value,
    slotId: "image:cover:primary",
    candidateId: candidate.candidateId,
    manualConfirmed: true,
    render: async ({ mode }) => ({ status: "success", mode, outputPath: path.join(value.root, `${mode}.png`), rendererCalls: 1, durationMs: 1 }),
    downloadImage: async (input, options) => {
      assert.equal(input.imageUrl, candidate.imageUrl);
      assert.equal(options.publicPrefix, `/image-assets/simple-manual-${value.projectId}`);
      await mkdir(directory, { recursive: true });
      await writeFile(filePath, buffer);
      return { filePath, publicUrl: `/image-assets/simple-manual-${value.projectId}/downloaded.jpg`, width: 1200, height: 800, bytes: buffer.length, contentType: "image/jpeg", sha256: "remote-preview" };
    },
  });
  assert.equal(payload.project.data.heroImage, `/image-assets/simple-manual-${value.projectId}/downloaded.jpg`);
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId).imageExecution.results[0].selected;
  assert.equal(saved.originalDownloaded, true);
  assert.equal(saved.originalDownloadStatus, "success");
});

test("最后一个 required 上传补齐后直接启动 Renderer 并完成", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const modes = [];
  const render = async ({ mode }) => { modes.push(mode); return { status: "success", mode, outputPath: path.join(value.root, mode === "draft" ? "draft-2000.png" : "final-2000.png"), rendererCalls: 1, durationMs: 5 }; };
  await chooseSimpleImageCandidate({ ...value, slotId: "image:cover:primary", candidateId: value.candidate.candidateId, render });
  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#61754b" } }).jpeg().toBuffer();
  const payload = await uploadSimpleImage({ ...value, slotId: "image:day:1:primary", dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "day-1.jpg", render });
  assert.deepEqual(modes, ["draft", "final"]);
  assert.equal(payload.pipelineStatus, "complete");
  assert.equal(payload.unresolvedRequiredCount, 0);
  assert.equal(payload.canEnterFinal, true);
  assert.equal(payload.project.progress, 100);
  assert.equal(payload.imageReview.slots.find((item) => item.slotId === "image:day:1:primary").status, "uploaded");
  assert.match(payload.project.data.days[0].spots[0].images[0].src, /^\/image-assets\/simple-manual-/);
});

test("人工新增体验卡片先保存为空草稿，上传后才进入客户卡片", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const initial = buildSimpleManualImagePayload(value.store, value.projectId);
  const data = structuredClone(initial.project.data);
  const slotId = "manual:day:1:spot-manual:primary";
  createManualDayCard(data, 0, { spotId: "spot-manual", slotId });
  const bindings = Object.fromEntries(Object.entries(data.simpleImageSlotBindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === 0));
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: `${mode}.png`, rendererCalls: 1 });
  let payload = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: data.days[0], bindings, included: data.included, excluded: data.excluded, pendingConfirmations: data.pendingConfirmations, render });
  const manualSlot = payload.imageReview.slots.find((slot) => slot.slotId === slotId);
  assert.equal(manualSlot.required, false);
  assert.deepEqual(manualSlot.userRequiredActions, ["upload_real_image"]);
  assert.equal(payload.project.data.days[0].spots.find((spot) => spot.id === "spot-manual").images.length, 0);

  const buffer = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#9b7a3a" } }).jpeg().toBuffer();
  payload = await uploadSimpleImage({ ...value, slotId, dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`, fileName: "manual-card.jpg", render });
  const manualSpot = payload.project.data.days[0].spots.find((spot) => spot.id === "spot-manual");
  assert.match(manualSpot.images[0].src, /^\/image-assets\/simple-manual-/);
  assert.equal(payload.project.data.simpleImageSlotBindings[slotId].manualEditorCard, true);
  const cleared = await clearSimpleImage({ ...value, slotId, expectedSrc: manualSpot.images[0].src, render });
  assert.equal(cleared.project.data.days[0].spots.find((spot) => spot.id === "spot-manual").images[0], null);
  assert.equal(cleared.project.data.simpleImageSlotBindings[slotId].manualEditorCard, true);
});

test('人工体验名称清空可持久保存，并可重新填写；原自动体验空名称仍沿用既有处理', async t => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const data = structuredClone(buildSimpleManualImagePayload(value.store, value.projectId).project.data);
  const slotId = 'manual:day:1:empty-title:primary';
  createManualDayCard(data, 0, { spotId: 'empty-title', slotId });
  data.days[0].spots.at(-1).name = '';
  const bindings = Object.fromEntries(Object.entries(data.simpleImageSlotBindings).filter(([, item]) => item.module === 'day' && item.dayIndex === 0));
  const render = async ({ mode }) => ({ status: 'success', mode, outputPath: `${mode}.png`, rendererCalls: 1 });
  const first = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: data.days[0], bindings, render });
  assert.equal(first.project.data.days[0].spots.at(-1).name, '');
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).data.days[0].spots.at(-1).name, '');
  const nextDay = structuredClone(first.project.data.days[0]);
  nextDay.spots.at(-1).name = '人工填写的新标题';
  const next = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: nextDay, bindings, render });
  assert.equal(next.project.data.days[0].spots.at(-1).name, '人工填写的新标题');
  nextDay.spots[0].name = '';
  const original = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: nextDay, bindings, render });
  assert.equal(original.project.data.days[0].spots[0].name, '新体验卡片');
});

test("删除人工体验卡片后不再展示其旧图片位和待处理项", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const data = structuredClone(buildSimpleManualImagePayload(value.store, value.projectId).project.data);
  const slotId = "manual:day:1:spot-deleted:primary";
  createManualDayCard(data, 0, { spotId: "spot-deleted", slotId });
  const render = async ({ mode }) => ({ status: "success", mode, outputPath: `${mode}.png`, rendererCalls: 1 });
  const dayBindings = () => Object.fromEntries(Object.entries(data.simpleImageSlotBindings).filter(([, binding]) => binding.module === "day" && binding.dayIndex === 0));
  await saveSimpleDayEditor({ ...value, dayIndex: 0, day: data.days[0], bindings: dayBindings(), render });
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  saved.unresolvedItems.push({ kind: "image", id: slotId, required: true, status: "needs_user_action" });
  saved.manualImageCompletion.slotIds.push(slotId);
  value.store.saveFinalResult(value.projectId, value.executionRunId, saved);
  deleteDaySpotPreservingSlots(data, 0, "spot-deleted");
  const payload = await saveSimpleDayEditor({ ...value, dayIndex: 0, day: data.days[0], bindings: dayBindings(), render });
  assert.equal(payload.blockingItems.some((item) => item.id === slotId), false);
  assert.equal(payload.imageReview.slots.some((slot) => slot.slotId === slotId), false);
  assert.equal(value.store.getFinalResult(value.projectId, value.executionRunId).manualImageCompletion.slotIds.includes(slotId), false);
});

test("每日编辑不能绕过酒店模块直接修改住宿", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  saved.data.hotels = [
    { id: "hotel-a", officialName: "Hotel A", shortName: "甲酒店", nights: 1 },
    { id: "hotel-b", officialName: "Hotel B", shortName: "乙酒店", nights: 0 },
  ];
  saved.data.days[0].hotel = "Hotel A";
  saved.data.days[0].hotelShortName = "甲酒店";
  saved.data.days[0].overnightType = "hotel";
  value.store.saveFinalResult(value.projectId, value.executionRunId, saved);
  const data = structuredClone(buildSimpleManualImagePayload(value.store, value.projectId).project.data);
  const day = { ...data.days[0], hotel: "Hotel B", hotelOfficialName: "Hotel B", hotelShortName: "乙酒店" };
  const bindings = Object.fromEntries(Object.entries(data.simpleImageSlotBindings || {}).filter(([, binding]) => binding.module === "day" && binding.dayIndex === 0));
  await assert.rejects(saveSimpleDayEditor({ ...value, dayIndex: 0, day, bindings, render: async ({ mode }) => ({ status: "success", mode, outputPath: "stay-edit.png", rendererCalls: 1 }) }), { code: "hotel_stay_hotel_module_only" });
});

test("酒店所在地单独保存，不改动住宿晚数与每日路线", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  saved.data.hotels = [{ id: "hotel-a", officialName: "Hotel A", shortName: "甲酒店", region: "旧地区", nights: 2 }];
  value.store.saveFinalResult(value.projectId, value.executionRunId, saved);
  const previousRoute = structuredClone(saved.data.days[0].routeNodes);
  const result = await saveSimpleHotelRegion({ ...value, hotelIndex: 0, hotelId: "hotel-a", region: "新地区", render: async ({ mode }) => ({ status: "success", mode, outputPath: "hotel-region.png", rendererCalls: 1 }) });
  const after = value.store.getFinalResult(value.projectId, value.executionRunId).data;
  assert.equal(result.region, "新地区");
  assert.equal(after.hotels[0].region, "新地区");
  assert.equal(after.hotels[0].nights, 2);
  assert.deepEqual(after.days[0].routeNodes, previousRoute);
});

test("酒店模块调整晚数前核对版本，确认后一次保存受影响住宿日", async (t) => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }));
  const saved = value.store.getFinalResult(value.projectId, value.executionRunId);
  saved.data.hotels = [
    { id: "hotel-a", officialName: "Hotel A", shortName: "甲酒店", nights: 1 },
    { id: "hotel-b", officialName: "Hotel B", shortName: "乙酒店", nights: 2 },
  ];
  saved.data.days = [
    { ...saved.data.days[0], hotel: "Hotel A", hotelOfficialName: "Hotel A", hotelShortName: "甲酒店", overnightType: "hotel", description: "第一天文案" },
    { ...saved.data.days[0], hotel: "Hotel B", hotelOfficialName: "Hotel B", hotelShortName: "乙酒店", overnightType: "hotel", description: "第二天文案" },
    { ...saved.data.days[0], hotel: "Hotel B", hotelOfficialName: "Hotel B", hotelShortName: "乙酒店", overnightType: "hotel", description: "第三天文案" },
  ];
  value.store.saveFinalResult(value.projectId, value.executionRunId, saved);
  const plan = planHotelNightChange(saved.data, 0, 2);
  assert.equal(plan.ok, true);
  await assert.rejects(saveSimpleHotelStay({ ...value, hotelIndex: 0, hotelId: "hotel-a", desiredNights: 2, expectedSignature: "old", deferRender: true }), { code: "hotel_stay_changed" });
  const result = await saveSimpleHotelStay({ ...value, hotelIndex: 0, hotelId: "hotel-a", desiredNights: 2, expectedSignature: plan.signature, deferRender: true });
  const after = value.store.getFinalResult(value.projectId, value.executionRunId).data;
  assert.deepEqual(result.changedDayIndexes, [1]);
  assert.deepEqual(after.hotels.map((hotel) => hotel.nights), [2, 1]);
  assert.equal(after.days[1].hotel, "Hotel A");
  assert.equal(after.days[1].description, "第二天文案");
});

test("用户主动单槽重搜只调用一个 slot，automaticFollowupRounds 保持 0", async (t) => {
  const value = await fixture({ oneSlot: true }); t.after(() => rm(value.root, { recursive: true, force: true }));
  let receivedSlots = [];
  const payload = await researchSimpleImageSlot({
    ...value,
    slotId: "image:cover:primary",
    runImage: async ({ slots }) => { receivedSlots = slots.map((item) => item.slotId); return { status: "needs_user_action", results: [{ slotId: slots[0].slotId, status: "not_found", selected: null, candidates: [], technicalStatus: "no_eligible_candidate", matchReason: "没有合格候选" }], metrics: { automaticFollowupRounds: 0 } }; },
    render: async ({ mode }) => ({ status: "success", mode, outputPath: "editable-draft.png", rendererCalls: 1 }),
  });
  assert.deepEqual(receivedSlots, ["image:cover:primary"]);
  assert.equal(payload.pipelineStatus, "partial");
  const final = value.store.getFinalResult(value.projectId, value.executionRunId);
  assert.equal(final.imageExecution.metrics.automaticFollowupRounds, 0);
  assert.equal(final.manualImageCompletion.plannerModelCalls, 0);
  assert.equal(final.manualImageCompletion.copyModelCalls, 0);
});
