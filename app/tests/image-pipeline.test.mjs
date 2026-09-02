import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { ImageDeduper } from "../server/image-dedupe.mjs";
import { applySelections, buildImageSlots } from "../server/image-allocator.mjs";
import { isOfficialSource, parseSearchResults } from "../server/image-search.mjs";
import { filterDiningExperiences } from "../server/refinement-rules.mjs";
import { baseScore, candidateRecordId, classifyAuditFailure, ConcurrentTaskQueue, imagePipelineLimits, settledMap, shouldContinueAutomaticSearch, uniqueCandidatesByContent } from "../server/image-pipeline.mjs";
import { applyImageToSlot, classifyImageCandidate, IMAGE_REVIEW_STATE } from "../src/lib/imageReviewPolicy.js";
import { buildLayoutImageSlots, moveImageToSlot } from "../src/lib/imageSlots.js";
import { buildBlueprintInput, validateImageBlueprint } from "../server/image-blueprint.mjs";
import { selectCustomerRenderData } from "../server/customer-render-data.mjs";
import { recordImageDecision } from '../src/lib/imageDecisions.js';

function withBlueprint(data, queries = {}) {
  return { ...data, imageBlueprint: { slots: buildLayoutImageSlots(data).map((slot) => ({ slotId: slot.slotId, useImage: true, priority: slot.module === "cover" || slot.module === "hotel" ? "high" : "medium", subject: slot.label, visualGoal: slot.purpose, mustHave: [slot.label], prefer: ["横向构图"], forbid: ["水印"], searchQueries: [{ query: queries[slot.slotId] || slot.label + " official gallery" }] })) } };
}

test("builds stable slots and applies selected images", () => {
  const data = withBlueprint({ destination: "肯尼亚", hotels: [{ id: "hotel-1", officialName: "Test Camp" }], diningExperiences: [{ id: "meal-1", title: "丛林早餐" }], transportSummary: [], days: [{ spots: [{ name: "象群游猎" }] }] });
  const slots = buildImageSlots(data);
  assert.deepEqual(slots.map((item) => item.key), ["cover:hero", "hotel:hotel-1:primary", "dining:meal-1:scene", "day:day-1:spot:象群游猎:primary"]);
  const next = applySelections(data, [{ slot: slots[0], images: [{ src: "/image-assets/cover.jpg", focus: "50% 50%" }], records: [{ src: "/image-assets/cover.jpg" }] }]);
  assert.equal(next.heroImage, "/image-assets/cover.jpg");
  assert.match(next.heroImage, /^\/image-assets\//);
  assert.equal(next.imageSourceLedger[0].slot, "cover:hero");
});

test("rejects exact and perceptually identical images globally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luxury-image-dedupe-"));
  try {
    const first = path.join(directory, "first.jpg");
    const second = path.join(directory, "second.jpg");
    await sharp({ create: { width: 100, height: 80, channels: 3, background: "#987654" } }).jpeg().toFile(first);
    await sharp(first).resize(200, 160).jpeg({ quality: 75 }).toFile(second);
    const deduper = new ImageDeduper();
    assert.equal((await deduper.accept({ filePath: first, sha256: "a", publicUrl: "/a.jpg" })).accepted, true);
    const duplicate = await deduper.accept({ filePath: second, sha256: "b", publicUrl: "/b.jpg" });
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.reason, "visual-duplicate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cover uses only an explicit cover plan and does not inherit a hotel query", () => {
  const source = {
    destination: "坦桑尼亚",
    hotels: [], diningExperiences: [], transportSummary: [], days: [],
  };
  const slots = buildImageSlots(withBlueprint(source, { "cover:hero": "坦桑尼亚 iconic safari landscape" }));
  assert.match(slots[0].query, /坦桑尼亚/);
  assert.doesNotMatch(slots[0].query, /Faru Faru/);
  assert.doesNotMatch(slots[0].query, /official official/i);
  assert.equal(slots[0].priority, "high");
  assert.equal(slots[0].module, "cover");
  assert.ok(slots[0].mustHave.length > 0);
  assert.ok(slots[0].forbid.length > 0);
});

test("does not promote ordinary meal boxes into featured dining", () => {
  const source = { days: [{ mealPlan: { breakfast: "酒店早餐", lunch: "午餐盒", dinner: "酒店晚餐" }, spots: [] }] };
  const generated = [{ title: "草原旷野中的营地午餐盒", editorialCopy: "在自然景观中享用午餐" }];
  assert.deepEqual(filterDiningExperiences(source, generated), []);
  const special = { days: [{ description: "傍晚安排 Bush Sundowner 落日酒会", spots: [] }] };
  assert.equal(filterDiningExperiences(special, [{ title: "Bush Sundowner 落日酒会" }]).length, 1);
});

test("official source detection uses the hostname, not a brand word in a third-party URL", () => {
  assert.equal(isOfficialSource("https://singita.com/lodge/gallery"), true);
  assert.equal(isOfficialSource("https://booking.coastal.co.tz/AboutUs/AboutUs"), true);
  assert.equal(isOfficialSource("https://faunatravel.com/singita-sabora"), false);
});

test("parses fenced Gemini search results without accepting non-http values", () => {
  const results = parseSearchResults('```json\n{"results":[{"title":"Official gallery","url":"https://www.melia.com/gallery","summary":"Pool"},{"title":"Invalid","url":"data:image/png;base64,x"}]}\n```');
  assert.deepEqual(results, [{ title: "Official gallery", pageUrl: "https://www.melia.com/gallery", summary: "Pool" }]);
});

test("enforces the documented image research budgets", () => {
  assert.deepEqual(imagePipelineLimits({}), {
    searchConcurrency: 3, auditConcurrency: 2, auditMaximumConcurrency: 3,
    sourcePages: 5, imagesPerPage: 12, downloadsPerRound: 12, initialAudit: 4, terminalAudit: 2,
    maxAutomaticRounds: 2, slotTotalTimeoutMs: 240000, searchDownloadTimeoutMs: 90000,
    initialAuditTimeoutMs: 90000, terminalAuditTimeoutMs: 90000,
  });
});

test("runs at most three slot research workers concurrently", async () => {
  let active = 0;
  let peak = 0;
  const output = await settledMap([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(output, [2, 4, 6, 8, 10, 12]);
});

test("keeps visual audit concurrency at two initially and never above the configured maximum", async () => {
  const queue = new ConcurrentTaskQueue(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => queue.add(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(peak, 2);
  assert.equal(queue.peakActive, 2);
  assert.equal(imagePipelineLimits({ IMAGE_AUDIT_CONCURRENCY: "99" }).auditConcurrency, 3);
});

test("treats audit timeout, rate limit, service errors, network errors and invalid JSON as unavailable rather than image defects", () => {
  const timeout = new Error("aborted"); timeout.name = "AbortError";
  const limited = new Error("busy"); limited.status = 429;
  const service = new Error("down"); service.status = 503;
  const invalid = new Error("bad json"); invalid.code = "audit_invalid_json";
  const network = new Error("socket closed");
  for (const error of [timeout, limited, service, invalid, network]) {
    const result = classifyAuditFailure(error);
    assert.match(result.kind, /^audit_(?:timeout|unavailable)$/);
    assert.match(result.reason, /人工确认/);
  }
});

test("stops automatic research for auto-approved or usable manual candidates and never opens a third round", () => {
  assert.equal(shouldContinueAutomaticSearch({ selected: true, round: 1, maxRounds: 2 }), false);
  assert.equal(shouldContinueAutomaticSearch({ manualAvailable: true, round: 1, maxRounds: 2 }), false);
  assert.equal(shouldContinueAutomaticSearch({ downloadableCandidateCount: 0, round: 1, maxRounds: 2 }), true);
  assert.equal(shouldContinueAutomaticSearch({ allCandidatesHardRejected: true, downloadableCandidateCount: 2, round: 1, maxRounds: 2 }), true);
  assert.equal(shouldContinueAutomaticSearch({ allCandidatesHardRejected: true, downloadableCandidateCount: 2, round: 2, maxRounds: 2 }), false);
  assert.equal(imagePipelineLimits({}).maxAutomaticRounds, 2);
});

test("base ranking favors official, relevant and landscape candidates", () => {
  const slot = { subject: "Gran Melia Arusha", brand: "Melia", label: "Gran Melia Arusha" };
  const official = baseScore({ officialHint: true, kind: "og:image", width: 1800, height: 1000, searchRank: 1, title: "Gran Melia Arusha pool" }, slot);
  const generic = baseScore({ officialHint: false, kind: "img", width: 1000, height: 1000, searchRank: 3, title: "hotel" }, slot);
  assert.ok(official > generic);
});

test("does not reuse a flight image plan for a safari vehicle", () => {
  const source = {
    destination: "坦桑尼亚", hotels: [], diningExperiences: [], days: [],
    transportSummary: [
      { id: "transport-1", category: "草原飞机", model: "Cessna Caravan", serviceLevel: "境内航班" },
      { id: "transport-2", category: "四驱敞篷越野车", model: "", serviceLevel: "游猎用车" },
    ],
  };
  const slots = buildImageSlots(withBlueprint(source, { "transport:transport-1:primary": "Coastal Aviation Cessna Caravan", "transport:transport-2:primary": "Tanzania open safari vehicle" }));
  const flight = slots.find((item) => item.slotId === "transport:transport-1:primary");
  const vehicle = slots.find((item) => item.slotId === "transport:transport-2:primary");
  assert.match(flight.query, /Coastal Aviation/);
  assert.match(vehicle.query, /safari vehicle/);
  assert.doesNotMatch(vehicle.query, /Coastal Aviation/);
});

test("does not create slots for low-value transfers or duplicate experiences", () => {
  const source = {
    destination: "坦桑尼亚", hotels: [], diningExperiences: [], imagePlan: [],
    transportSummary: [{ id: "pickup", category: "专车接机", serviceLevel: "普通机场接送", model: "" }],
    days: [
      { city: "塞伦盖蒂", spots: [{ name: "马拉河大迁徙" }] },
      { city: "塞伦盖蒂", spots: [{ name: "马拉河大迁徙" }] },
    ],
  };
  const slots = buildImageSlots(withBlueprint(source));
  assert.equal(slots.some((item) => item.module === "transport"), false);
  assert.equal(slots.filter((item) => item.module === "day").length, 2);
});

test("classifies soft preference misses as manual review across modules", () => {
  for (const module of ["cover", "hotel", "dining", "transport", "day"]) {
    const result = classifyImageCandidate({
      slot: { module }, candidate: { officialHint: module === "hotel" },
      audit: { pass: false, subjectMatch: true, placeMatch: module !== "hotel", sourceSupportsIdentity: module === "hotel", watermark: false, hardRejectCode: "none", relevance: 72, luxury: 68, cleanliness: 80, composition: 60, reason: "主体可用，但构图不是首选" },
    });
    assert.equal(result.state, IMAGE_REVIEW_STATE.MANUAL_REVIEW);
    assert.equal(result.adoptable, true);
  }
});

test("hard rejects watermark, wrong subject, broken images and duplicates", () => {
  const slot = { module: "day" };
  for (const input of [
    { audit: { watermark: true, hardRejectCode: "watermark" } },
    { audit: { subjectMatch: false, hardRejectCode: "subject_mismatch" } },
    { technicalFailure: "候选图片加载失败", audit: {} },
    { duplicate: true, audit: {} },
  ]) {
    const result = classifyImageCandidate({ slot, candidate: {}, ...input });
    assert.equal(result.state, IMAGE_REVIEW_STATE.HARD_REJECTED);
    assert.equal(result.adoptable, false);
  }
});

test("hard rejects explicit subject or place mismatch even when the model forgets the reject code", () => {
  for (const audit of [
    { subjectMatch: false, placeMatch: true, hardRejectCode: "none" },
    { subjectMatch: true, placeMatch: false, hardRejectCode: "none" },
  ]) {
    const result = classifyImageCandidate({ slot: { module: "day" }, candidate: {}, audit });
    assert.equal(result.state, IMAGE_REVIEW_STATE.HARD_REJECTED);
    assert.equal(result.adoptable, false);
  }
});

test("hard rejects a candidate whose visual relevance is clearly below the slot", () => {
  const result = classifyImageCandidate({ slot: { module: "day" }, candidate: {}, audit: { subjectMatch: true, placeMatch: true, relevance: 35, hardRejectCode: "none", reason: "与当天主题不匹配" } });
  assert.equal(result.state, IMAGE_REVIEW_STATE.HARD_REJECTED);
  assert.equal(result.adoptable, false);
});

test("official hotel identity is not hard rejected for a non-preferred scene", () => {
  const result = classifyImageCandidate({ slot: { module: "hotel" }, candidate: { officialHint: true }, audit: { pass: false, subjectMatch: true, placeMatch: false, sourceSupportsIdentity: true, hardRejectCode: "place_mismatch", reason: "官方酒店大堂，但不是首选外观" } });
  assert.equal(result.state, IMAGE_REVIEW_STATE.MANUAL_REVIEW);
  assert.equal(result.adoptable, true);
});

test("manual adoption writes only the selected slot", () => {
  const data = { heroImage: "", hotels: [{ id: "h1", images: [] }], diningExperiences: [], transportSummary: [], days: [] };
  const next = applyImageToSlot(data, "hotels:h1", [{ src: "/image-assets/confirmed.jpg" }]);
  assert.equal(next.hotels[0].images[0].src, "/image-assets/confirmed.jpg");
  assert.equal(next.heroImage, "");
  assert.deepEqual(data.hotels[0].images, []);
});

test("allows an optional paid experience as a main visual while keeping its fee boundary", () => {
  const data = { title: "肯尼亚行程", destination: "肯尼亚", hotels: [], diningExperiences: [], transportSummary: [], days: [{ theme: "抵达", description: "抵达内罗毕，可选择自费热气球", spots: [{ id: "balloon", name: "自费热气球", status: "optional_paid", statusLabel: "自费可选", feeBoundary: "excluded", sourceEvidence: ["自费热气球"], optional: true, description: "可自行选择" }] }] };
  const input = buildBlueprintInput(data);
  const base = input.layoutSlots.map((slot) => ({ slotId: slot.slotId, useImage: false }));
  assert.equal(validateImageBlueprint({ slots: base }, input).valid, true);
  const mainVisual = { slots: base.map((slot, index) => index === 0 ? { ...slot, useImage: true, priority: "high", sourceEvidence: [{ text: "自费热气球" }], searchQueries: [{ query: "balloon" }] } : slot) };
  assert.equal(validateImageBlueprint(mainVisual, input).valid, true);
  assert.equal(input.itineraryFacts.days[0].spots[0].status, "optional_paid");
  assert.equal(input.itineraryFacts.days[0].spots[0].feeBoundary, "excluded");
});

test("accepts string evidence and does not mistake a flight-to-hotel arrival for sleeping on a plane", () => {
  const data = { title: "坦桑尼亚行程", destination: "坦桑尼亚", hotels: [], diningExperiences: [], transportSummary: [], days: [{ theme: "抵达", description: "搭乘草原飞机抵达后入住营地", overnightType: "hotel", spots: [{ id: "arrival", name: "草原飞机抵达", description: "搭乘草原飞机抵达后入住营地", sourceEvidence: ["搭乘草原飞机抵达后入住营地"] }] }] };
  const input = buildBlueprintInput(data);
  const blueprint = { slots: input.layoutSlots.map((slot) => slot.module === "day" ? { slotId: slot.slotId, useImage: true, priority: "high", sourceEvidence: ["搭乘草原飞机抵达后入住营地"], searchQueries: [{ query: "Tanzania bush plane arrival" }] } : { slotId: slot.slotId, useImage: false }) };
  const result = validateImageBlueprint(blueprint, input);
  assert.equal(result.valid, true, result.errors.join("；"));
});

test("locked slots are not returned for automatic replacement", () => {
  const data = withBlueprint({ destination: "肯尼亚", heroImage: "/image-assets/user.jpg", imageLocks: { "cover:hero": { source: "user_upload" } }, hotels: [], diningExperiences: [], transportSummary: [], days: [] });
  assert.equal(buildImageSlots(data).some((slot) => slot.slotId === "cover:hero"), false);
  assert.equal(buildImageSlots(data, { includeLocked: true }).some((slot) => slot.slotId === "cover:hero"), true);
});

test("moving an image across modules clears its old position and locks both decisions", () => {
  const data = { heroImage: "/image-assets/one.jpg", hotels: [{ id: "h1", images: [] }], diningExperiences: [], transportSummary: [], days: [] };
  const next = moveImageToSlot(data, "hotel:h1:primary", "cover:hero", { src: "/image-assets/one.jpg", candidateId: "c1" });
  assert.equal(next.heroImage, "");
  assert.equal(next.hotels[0].images[0].src, "/image-assets/one.jpg");
  assert.equal(next.imageLocks["cover:hero"].source, "user_moved_out");
  assert.equal(next.imageLocks["hotel:h1:primary"].candidateId, "c1");
});

test('records user image decisions so locks survive project serialization', () => {
  const data = { imageLocks: { 'cover:hero': { source: 'user_selection', lockedAt: 1 } } };
  recordImageDecision(data, { slotId: 'cover:hero', action: 'adopt', candidateId: 'c1', decidedAt: 2 });
  const restored = JSON.parse(JSON.stringify(data));
  assert.equal(restored.imageDecisions[0].candidateId, 'c1');
  assert.equal(restored.imageDecisions[0].locked, true);
  assert.equal(restored.imageLocks['cover:hero'].source, 'user_selection');
});

test("candidate record ids distinguish slot and attempt while preserving content hash", () => {
  assert.notEqual(candidateRecordId("cover:hero", 1, "same-sha"), candidateRecordId("cover:hero", 2, "same-sha"));
  assert.notEqual(candidateRecordId("cover:hero", 1, "same-sha"), candidateRecordId("hotel:h1:primary", 1, "same-sha"));
});

test("same downloaded content is recorded once per slot attempt", () => {
  const unique = uniqueCandidatesByContent([
    { sha256: "same", imageUrl: "https://a.example/one.jpg" },
    { sha256: "same", imageUrl: "https://b.example/copy.jpg" },
    { sha256: "different", imageUrl: "https://c.example/two.jpg" },
  ]);
  assert.deepEqual(unique.map((item) => item.sha256), ["same", "different"]);
});

test("customer render whitelist excludes every internal image review field", () => {
  const clean = selectCustomerRenderData({ title: "客户行程", imageBlueprint: { secret: true }, imageCandidates: [{ terminalAudit: { score: 99 } }], imageReview: { pendingCount: 1 }, imageResearch: { runId: "x" }, imageFailures: [{ reason: "x" }], imageSourceLedger: [{ sourcePage: "x" }], days: [{ theme: "第一天", audit: { score: 1 } }] });
  assert.deepEqual(Object.keys(clean), ["title", "days"]);
  assert.equal(JSON.stringify(clean).includes("audit"), false);
  assert.equal(JSON.stringify(clean).includes("imageCandidates"), false);
});
