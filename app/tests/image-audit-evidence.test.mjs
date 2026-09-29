import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { judgeCandidatesBatch } from "../server/image-audit.mjs";
import { applyWebImageIdentityEvidence, buildImageConstraints, failedHardRequirement } from "../server/simple-image-skill.mjs";
import { webEntityOwnedPageImageEvidence } from "../server/web-image-candidates.mjs";
import { completeVisualJudgment } from "../server/image-audit-contract.mjs";
import { candidateQualification, IMAGE_AUDIT_EVIDENCE_VERSION, isIdentityEvidenceUnresolved } from "../server/image-candidate-eligibility.mjs";

const identitySlot = {
  module: "hotel", exactIdentityRequired: true, label: "Azure Pavilion suite",
  queryCore: { identity: "Azure Pavilion" }, minimumVisualProof: { subject: "suite", identityRequirement: "Azure Pavilion" },
};

function judgment(candidateId, overrides = {}) {
  return {
    candidateId, actualSubject: "A hotel suite", matchLevel: "exact", locationMatch: true, visibleLocationConflict: false,
    hotelIdentityMatch: true, visibleIdentityConflict: false, activityMatch: true, coreActionMatch: true,
    subjectMatch: true, coreSubjectMatch: true, identityMatch: true, subjectClear: true,
    subjectLargeEnough: true, subjectPrimary: true, transportType: "none", transportTypeMatch: true,
    watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true,
    hardRejectCode: "none", score: 94, relevance: 94, luxury: 90, cleanliness: 92, composition: 88,
    reason: "主体符合，身份需按引用核对", ...overrides,
  };
}

async function fixtures(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-audit-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "candidate.jpg");
  await sharp({ create: { width: 1000, height: 700, channels: 3, background: "#238346" } }).jpeg().toFile(filePath);
  return { directory, candidate: { candidateId: "photo-1", filePath, imageUrl: "https://example.com/opaque.jpg", pageUrl: "https://example.com/" } };
}

async function audit(candidates, judgments, slot = identitySlot) {
  let request;
  let calls = 0;
  const results = await judgeCandidatesBatch({
    slot, candidates, apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture",
    // These fixtures exercise first-response normalization. Bounded repair is
    // covered separately with distinct initial and supplemental responses.
    allowContractRepair: false,
    fetchImpl: async (_url, options) => {
      calls += 1;
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments }) } }] }) };
    },
  });
  assert.equal(calls, 1, "source evidence and visual judgment share one request");
  return { results, request };
}

test("DAY审核只接收当前图片的Core与偏好，不混入整天酒店和相邻活动", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { moduleType: "day", subject: "象群与雪山", exactIdentityRequired: true,
    queryCore: { subject: "elephants", action: "walking", identity: "Mount Kilimanjaro" },
    visualGoal: "象群在雪山下漫步", location: "Amboseli", locationRole: "visual_identity",
    visualContext: { dayRole: "抵达", daySourceFacts: "入住 Azure Pavilion 酒店", allActivities: [{ description: "Azure Pavilion 私人泳池" }],
      sourceExperience: "Azure Pavilion 入住", adjacentVisualResponsibilities: ["博物馆历史展览"], avoid: ["同一机位"] } };
  const constraints = buildImageConstraints(target);
  assert.doesNotMatch(constraints.prefer.join(" "), /Azure Pavilion|博物馆历史/);
  const { request } = await audit([candidate], [judgment(candidate.candidateId)], {
    ...target, ...constraints, context: "入住 Azure Pavilion，次日游览博物馆",
  });
  const prompt = request.messages[0].content.find(item => item.type === "text").text;
  assert.doesNotMatch(prompt, /Azure Pavilion/);
  assert.match(prompt, /Mount Kilimanjaro/);
  assert.match(prompt, /同一机位/);
});

test("错误身份引文仅补核一次，其他候选和有效硬判定不变", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { ...identitySlot, module: "day", queryCore: { identity: "Giraffe Centre" }, minimumVisualProof: { subject: "giraffe", action: "feeding", identityRequirement: "Giraffe Centre" } };
  const photo = { ...candidate, alt: "Visitors feeding giraffes", caption: "Feeding at Giraffe Centre, Nairobi." };
  const invalid = { status: "supported", basis: "photo_local", evidenceIds: ["alt"], quote: photo.alt, explanation: "claimed identity" };
  for (const mode of ["repaired", "still-invalid", "failed", "disabled", "no-anchor", "hard-conflict"]) {
    let calls = 0;
    const image = mode === "no-anchor" ? { ...photo, caption: "Visitors with animals" } : photo;
    const original = judgment(image.candidateId, { identityEvidence: invalid,
      ...(mode === "hard-conflict" ? { coreActionMatch: false, hardRejectCode: "wrong_activity", eligible: false } : {}) });
    const results = await judgeCandidatesBatch({ slot: target, candidates: [image, { ...candidate, candidateId: "peer" }],
      apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture", allowContractRepair: mode !== "disabled",
      fetchImpl: async (_url, options) => {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments: [original, judgment("peer")] }) } }] }) };
        const prompt = JSON.parse(options.body).messages[0].content.find(item => item.type === "text").text;
        assert.match(prompt, /identityEvidence/);
        if (mode === "failed") throw new Error("controlled repair failure");
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments: [{ candidateId: image.candidateId,
          identityEvidence: mode === "still-invalid" ? invalid : { ...invalid, evidenceIds: ["caption"], quote: image.caption }, score: 1, coreActionMatch: true },
          { candidateId: "peer", eligible: false, score: 1 }] }) } }] }) };
      } });
    const result = results.find(item => item.candidateId === image.candidateId);
    assert.equal(calls, ["disabled", "no-anchor", "hard-conflict"].includes(mode) ? 1 : 2, mode);
    assert.equal(result.identityEvidence.status, mode === "repaired" ? "supported" : "insufficient", mode);
    assert.equal(result.score, 94);
    assert.equal(results.find(item => item.candidateId === "peer").score, 94);
    if (mode === "hard-conflict") assert.equal(result.hardRejectCode, "wrong_activity");
    else assert.equal(result.eligible, mode === "repaired", mode);
  }
});

test("早餐年代冲突在可选场地身份归一化后仍阻止自动采用", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { moduleType: "dining", exactIdentityRequired: false,
    queryCore: { subject: "丛林早餐", action: "享用早餐", identity: "Bush Breakfast" } };
  for (const [actualSubject, reason] of [["1938年两名男子在丛林中吃早餐", "主体符合"], ["两名男子吃早餐", "这是一张历史照片"]]) {
    const { results: [result] } = await audit([candidate], [judgment(candidate.candidateId, { actualSubject, reason })], target);
    assert.equal(failedHardRequirement(target, result, candidate), "wrong_activity");
    assert.equal(candidateQualification({ hardJudgment: result }), "rejected", "编辑器与自动采用共用的资格门禁必须拒绝历史冲突");
  }
  const { results: [modern] } = await audit([candidate], [judgment(candidate.candidateId, { actualSubject: "游客在建于1890年的露台享用早餐", reason: "现代实拍，不是历史照片" })], target);
  assert.equal(failedHardRequirement(target, modern, candidate), null);
  const history = { ...target, queryCore: { subject: "历史早餐照片", action: "博物馆展览", identity: "" } };
  assert.equal(failedHardRequirement(history, judgment(candidate.candidateId, { actualSubject: "1938年两名男子在丛林中吃早餐" })), null);
  const elsewhere = [
    { moduleType: "dining", location: "Kyoto", queryCore: { subject: "tea ceremony", action: "drinking tea" }, visualGoal: "茶道，翌日参观博物馆" },
    { moduleType: "day", location: "Paris", queryCore: { subject: "vineyard picnic", action: "dining" } },
  ];
  for (const place of elsewhere) {
    assert.equal(failedHardRequirement(place, judgment("archive", { actualSubject: "Historical photo of guests dining" })), "wrong_activity");
    assert.equal(failedHardRequirement(place, judgment("modern", { actualSubject: "Guests dining on a terrace built in 1890" })), null);
  }
  const transfer = { moduleType: "transport", queryCore: { subject: "classic car", action: "transfer" } };
  for (const actualSubject of ["1960年车型的老爷车正在接送旅客", "1960年 款老爷车现代实拍", "1890年建成的车站前接送旅客"]) {
    assert.equal(failedHardRequirement(transfer, judgment("modern", { actualSubject })), null, actualSubject);
  }
});

test("缺失冲突字段只补判一次，完整候选不重判且合并后可自动采用", async (t) => {
  const { candidate } = await fixtures(t);
  const partial = judgment(candidate.candidateId);
  delete partial.visibleLocationConflict;
  delete partial.visibleIdentityConflict;
  const other = { ...candidate, candidateId: "photo-2" };
  const requests = [], repairs = [];
  const results = await judgeCandidatesBatch({
    slot: { exactIdentityRequired: false }, candidates: [candidate, other],
    apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture",
    onContractRepair: record => repairs.push(record),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const judgments = requests.length === 1 ? [partial, judgment(other.candidateId)] : [
        { candidateId: candidate.candidateId, visibleLocationConflict: false, visibleIdentityConflict: false, score: 1 },
        { candidateId: other.candidateId, eligible: false },
      ];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments }) } }] }) };
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(repairs, [{ candidates: [{ candidateId: candidate.candidateId, missingFields: ["visibleLocationConflict", "visibleIdentityConflict"] }] }]);
  assert.ok(results.every(completeVisualJudgment));
  assert.ok(results.every(result => candidateQualification({ hardJudgment: result }) === "eligible"));
  assert.equal(results[0].score, 94, "补判不得修改已经有效的分数");
  assert.equal(results.find(item => item.candidateId === other.candidateId).auditContract.repairAttempted, false);
  const prompt = requests[0].messages[0].content.find(item => item.type === "text").text;
  assert.match(prompt, /"visibleLocationConflict":true或false/);
  assert.match(prompt, /"visibleIdentityConflict":true或false/);
});

test("补判不能覆盖原始硬拒绝或有效布尔判断", async (t) => {
  const { candidate } = await fixtures(t);
  const partial = judgment(candidate.candidateId, { eligible: false, subjectMatch: false, hardRejectCode: "wrong_subject" });
  delete partial.visibleLocationConflict;
  let calls = 0;
  const [result] = await judgeCandidatesBatch({
    slot: { exactIdentityRequired: false }, candidates: [candidate], apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture",
    fetchImpl: async () => {
      const judgments = ++calls === 1 ? [partial] : [judgment(candidate.candidateId)];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments }) } }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.eligible, false);
  assert.equal(result.subjectMatch, false);
  assert.equal(result.hardRejectCode, "wrong_subject");
  assert.equal(candidateQualification({ hardJudgment: result }), "rejected");
});

test("补判失败或仍缺字段不默认放行，也不丢弃同批完整候选", async (t) => {
  const { candidate } = await fixtures(t);
  const partial = judgment(candidate.candidateId);
  delete partial.visibleIdentityConflict;
  for (const mode of ["malformed", "missing", "disabled"]) {
    let calls = 0;
    const results = await judgeCandidatesBatch({
      slot: { exactIdentityRequired: false }, candidates: [candidate, { ...candidate, candidateId: "photo-2" }],
      apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture", allowContractRepair: mode !== "disabled",
      fetchImpl: async () => {
        calls += 1;
        const content = calls === 1 ? JSON.stringify({ judgments: [partial, judgment("photo-2")] })
          : mode === "malformed" ? "not valid JSON" : JSON.stringify({ judgments: [{ candidateId: candidate.candidateId }] });
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
      },
    });
    assert.equal(calls, mode === "disabled" ? 1 : 2);
    const incomplete = results.find(item => item.candidateId === candidate.candidateId);
    assert.equal(completeVisualJudgment(incomplete), false);
    assert.deepEqual(incomplete.auditContract.missingFields, ["visibleIdentityConflict"]);
    assert.equal(candidateQualification({ hardJudgment: incomplete }), "unreviewed");
    assert.equal(completeVisualJudgment(results.find(item => item.candidateId === "photo-2")), true);
  }
});

test("补判发现可见身份冲突时保留冲突而非默认false", async (t) => {
  const { candidate } = await fixtures(t);
  const partial = judgment(candidate.candidateId);
  delete partial.visibleIdentityConflict;
  let calls = 0;
  const [result] = await judgeCandidatesBatch({
    slot: { exactIdentityRequired: false }, candidates: [candidate], apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture",
    fetchImpl: async () => {
      const judgments = ++calls === 1 ? [partial] : [{ candidateId: candidate.candidateId, visibleIdentityConflict: true }];
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments }) } }] }) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.visibleIdentityConflict, true);
  assert.equal(completeVisualJudgment(result), true);
  assert.equal(result.eligible, false);
  assert.equal(candidateQualification({ hardJudgment: result }), "rejected");
});

test("补判读取响应体超时保留完整候选，外部取消不得再触发重试", async (t) => {
  const { candidate } = await fixtures(t);
  const partial = judgment(candidate.candidateId);
  delete partial.visibleLocationConflict;
  for (const mode of ["deadline", "cancel"]) {
    const controller = new AbortController();
    let calls = 0;
    const operation = judgeCandidatesBatch({
      slot: { exactIdentityRequired: false }, candidates: [candidate, { ...candidate, candidateId: "photo-2" }],
      apiKey: "fixture", baseUrl: "https://vision.invalid", model: "fixture",
      timeoutMs: mode === "deadline" ? 100 : 5000, signal: controller.signal,
      fetchImpl: async (_url, options) => {
        calls += 1;
        if (calls === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments: [partial, judgment("photo-2")] }) } }] }) };
        return { ok: true, json: () => new Promise((_resolve, reject) => {
          const guard = setTimeout(() => reject(new Error("test guard: expected request cancellation")), 1000);
          const abort = () => { clearTimeout(guard); reject(options.signal.reason); };
          if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true });
          if (mode === "cancel") setTimeout(() => controller.abort(new Error("cancel fixture")), 5);
        }) };
      },
    });
    if (mode === "cancel") {
      await assert.rejects(operation, error => error.message === "cancel fixture" && error.technicalRetryHandled === true);
    } else {
      const results = await operation;
      const incomplete = results.find(item => item.candidateId === candidate.candidateId);
      assert.equal(incomplete.auditContract.repairErrorCode, "audit_timeout");
      assert.equal(candidateQualification({ hardJudgment: incomplete }), "unreviewed");
      assert.equal(completeVisualJudgment(results.find(item => item.candidateId === "photo-2")), true);
    }
    assert.equal(calls, 2);
  }
});

test("audit keeps the full portrait and landscape frames, with numbers outside the photographs", async (t) => {
  const { directory } = await fixtures(t);
  const candidates = [];
  for (const [index, width, height] of [[0, 390, 600], [1, 1500, 500]]) {
    const filePath = path.join(directory, `edges-${index}.png`);
    const corner = (color) => sharp({ create: { width: 60, height: 60, channels: 3, background: color } }).png().toBuffer();
    await sharp({ create: { width, height, channels: 3, background: "#00aa00" } }).composite([
      { input: await corner("#ff0000"), left: 0, top: 0 },
      { input: await corner("#0000ff"), left: width - 60, top: 0 },
      { input: await corner("#ffff00"), left: 0, top: height - 60 },
      { input: await corner("#ff00ff"), left: width - 60, top: height - 60 },
    ]).png().toFile(filePath);
    candidates.push({ candidateId: `edges-${index}`, filePath });
  }
  const { request } = await audit(candidates, candidates.map((candidate) => judgment(candidate.candidateId)), { exactIdentityRequired: false });
  const url = request.messages[0].content.find((item) => item.type === "image_url").image_url.url;
  const { data, info } = await sharp(Buffer.from(url.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1200);
  assert.equal(info.height, 464);
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const near = (actual, expected) => expected.forEach((channel, index) => assert.ok(Math.abs(actual[index] - channel) < 35, `${actual} should be near ${expected}`));
  near(pixel(175, 55), [255, 0, 0]);
  near(pixel(425, 55), [0, 0, 255]);
  near(pixel(175, 450), [255, 255, 0]);
  near(pixel(425, 450), [255, 0, 255]);
  near(pixel(609, 165), [255, 0, 0]);
  near(pixel(1189, 165), [0, 0, 255]);
  near(pixel(609, 343), [255, 255, 0]);
  near(pixel(1189, 343), [255, 0, 255]);
  near(pixel(20, 20), [32, 32, 32]);
});

test("one batch includes at most four images and binds all local evidence to candidate IDs", async (t) => {
  const { candidate } = await fixtures(t);
  const candidates = Array.from({ length: 5 }, (_, index) => ({ ...candidate, candidateId: `photo-${index + 1}` }));
  candidates[0] = { ...candidates[0], alt: "Azure Pavilion pool", caption: "Azure Pavilion suite", imageTitle: "Suite terrace", structuredImageText: "Azure Pavilion room photo", localContext: "Private room details", entitySectionText: "Azure Pavilion", imageUrl: "https://proxy.example/image?url=https%3A%2F%2Fexample.com%2Fazure-pavilion%2Froom.jpg", title: "Website title" };
  candidates[4].filePath = path.join(os.tmpdir(), "must-not-read-fifth-candidate");
  const { results, request } = await audit(candidates, candidates.map((item) => judgment(item.candidateId)), { exactIdentityRequired: false });
  assert.equal(results.length, 4);
  const prompt = request.messages[0].content.find((item) => item.type === "text").text;
  assert.match(prompt, /"id":"caption","scope":"photo_local","text":"Azure Pavilion suite"/);
  assert.match(prompt, /"id":"resourcePath","scope":"resource_path","text":"\/azure-pavilion\/room.jpg"/);
  assert.match(prompt, /"id":"pageTitle","scope":"page_context"/);
  for (const field of ["alt", "imageTitle", "structuredImageText", "localContext", "entitySectionText"]) assert.ok(prompt.includes(`"id":"${field}"`));
  assert.ok(!prompt.includes('"candidateId":"photo-5"'));
});

test("homepage titles and generic local captions cannot prove a necessary hotel identity", async (t) => {
  const { candidate } = await fixtures(t);
  for (const [basis, evidenceIds, quote] of [["entity_page", ["pageTitle"], "Azure Pavilion"], ["photo_local", ["caption"], "A swimming pool"]]) {
    const { results: [result] } = await audit([{ ...candidate, title: "Azure Pavilion", officialHint: true, caption: "A swimming pool" }], [judgment(candidate.candidateId, {
      identityEvidence: { status: "supported", basis, evidenceIds, quote, explanation: "官网标题或通用描述不能绑定具体图片" },
    })]);
    assert.equal(result.auditEvidenceVersion, IMAGE_AUDIT_EVIDENCE_VERSION);
    assert.equal(result.identityEvidence.status, "insufficient");
    assert.equal(result.eligible, false);
    assert.equal(result.hardRejectCode, "none");
    assert.ok(isIdentityEvidenceUnresolved(result));
    assert.equal(candidateQualification({ hardJudgment: result }), "unreviewed");
  }
  const { results: [unprovedConflict] } = await audit([{ ...candidate, caption: "A swimming pool" }], [judgment(candidate.candidateId, {
    hardRejectCode: "wrong_hotel", identityEvidence: { status: "conflict", basis: "photo_local", evidenceIds: ["caption"], quote: "pool", observedIdentity: "pool", explanation: "A category is not evidence of a different hotel" },
  })]);
  assert.ok(isIdentityEvidenceUnresolved(unprovedConflict));
});

test("人工身份待判不能遮住同一候选的主体或酒店硬拒绝", () => {
  for (const hardRejectCode of ["wrong_subject", "wrong_activity", "wrong_hotel"]) {
    const candidate = {
      rejection: "needs_user_judgment",
      qualificationStatus: "unreviewed",
      hardJudgment: {
        auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
        hardRejectCode,
        identityEvidence: { status: "insufficient", basis: "none", evidenceIds: [] },
      },
    };
    assert.equal(candidateQualification(candidate), "rejected", hardRejectCode);
  }
});

test("explicit per-photo identity citations and entity page bindings can support identity", async (t) => {
  const { candidate } = await fixtures(t);
  for (const [attributes, basis, evidenceIds, quote] of [
    [{ caption: "Suite at Azure Pavilion" }, "photo_local", ["caption"], "Azure Pavilion"],
    [{ entityPagePath: "/properties/azure-pavilion/gallery", pagePosition: "content" }, "entity_page", ["entityPagePath"], "azure-pavilion"],
    [{ sourceKind: "knowledge_library", knowledgeSourcePaths: ["Hotels/Azure Pavilion/Rooms"] }, "knowledge_path", ["knowledgePath1"], "Azure Pavilion"],
  ]) {
    const { results: [result] } = await audit([{ ...candidate, ...attributes }], [judgment(candidate.candidateId, {
      identityEvidence: { status: "supported", basis, evidenceIds, quote, explanation: "此图片直接绑定目标实体的客房图注或图库" },
    })]);
    assert.equal(result.identityEvidence.status, "supported");
    assert.equal(result.eligible, true);
  }
});

test("a generic-named image on an entity-owned substantive content page can resolve citation-only identity uncertainty", async (t) => {
  const { candidate } = await fixtures(t);
  const target = {
    module: "day", moduleType: "day", label: "Sanctuary encounter", locationRole: "visual_identity",
    exactIdentityRequired: true,
    queryCore: { subject: "visitor and giraffe", action: "feeding", identity: "长颈鹿中心", identityEn: "Giraffe Centre" },
    minimumVisualProof: { subject: "visitor and giraffe", action: "feeding", identityRequirement: "长颈鹿中心" },
  };
  const image = {
    ...candidate, pageUrl: "https://www.giraffecentre.org/our-sanctuary/",
    entityPagePath: "/our-sanctuary/", imageUrl: "https://www.giraffecentre.org/uploads/Activities-hero-image.jpg",
    kind: "page-image", pagePosition: "content", resourceRole: "media", officialHint: false,
  };
  const proof = webEntityOwnedPageImageEvidence(image, target);
  assert.equal(proof?.basis, "entity_page");
  const { results: [judged] } = await audit([image], [judgment(image.candidateId, {
    actualSubject: "Visitors feeding giraffes at a sanctuary", matchLevel: "representative",
    identityMatch: false, hotelIdentityMatch: false, eligible: false,
    identityEvidence: { status: "insufficient", basis: "entity_page", evidenceIds: ["resourcePath"],
      quote: "/uploads/Activities-hero-image.jpg", explanation: "The cited filename does not itself name the venue" },
  })], target);
  assert.ok(isIdentityEvidenceUnresolved(judged));
  const corrected = applyWebImageIdentityEvidence(target, image, judged);
  assert.equal(corrected.identityEvidence.status, "supported");
  assert.equal(corrected.identityEvidence.basis, "entity_page");
  assert.equal(corrected.identityMatch, true);
  assert.equal(failedHardRequirement(target, corrected), null);
});

test("an entity-owned page's og:image is page-bound despite living in metadata; weak metadata is not", () => {
  const target = { module: "day", moduleType: "day", locationRole: "visual_identity", exactIdentityRequired: true,
    queryCore: { identity: "长颈鹿中心", identityEn: "Giraffe Centre" } };
  const ogImage = { pageUrl: "https://giraffecentre.org/our-sanctuary/", entityPagePath: "/our-sanctuary/",
    imageUrl: "https://giraffecentre.org/uploads/Activities-hero-image.jpg",
    kind: "og:image", pagePosition: "other", resourceRole: "media" };
  assert.equal(webEntityOwnedPageImageEvidence(ogImage, target)?.basis, "entity_page");
  const audit = judgment("og-1", { auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
    actualSubject: "A visitor feeding a giraffe", identityMatch: false, hotelIdentityMatch: false, eligible: false,
    identityEvidence: { status: "insufficient", basis: "entity_page", evidenceIds: ["resourcePath"],
      quote: "/uploads/Activities-hero-image.jpg", explanation: "Generic filename alone is inconclusive" } });
  assert.equal(applyWebImageIdentityEvidence(target, ogImage, audit).identityEvidence.status, "supported");
  for (const [index, image] of [
    { ...ogImage, pageUrl: "https://shared-brand.org/giraffe-centre/", entityPagePath: "/giraffe-centre/", imageUrl: "https://shared-brand.org/hero.jpg" },
    { ...ogImage, pageUrl: "https://giraffecentre.org/", entityPagePath: "/" },
    { ...ogImage, pageUrl: "https://giraffecentre.org/partners/", entityPagePath: "/partners/" },
    { ...ogImage, pageUrl: "https://giraffecentre.org/our-partners/", entityPagePath: "/our-partners/" },
    { ...ogImage, pageUrl: "https://giraffecentre.org/destinations/other-place/", entityPagePath: "/destinations/other-place/" },
    { ...ogImage, imageUrl: "https://another-site.org/hero.jpg" },
    { ...ogImage, kind: "twitter:image" },
    { ...ogImage, kind: "image-preload" },
    { ...ogImage, kind: "embedded-media" },
  ].entries()) {
    assert.equal(webEntityOwnedPageImageEvidence(image, target), null, `metadata negative ${index}`);
    assert.equal(applyWebImageIdentityEvidence(target, image, audit), audit, `metadata negative ${index}`);
  }
  const incomplete = { ...audit, auditContract: { complete: false } };
  assert.equal(applyWebImageIdentityEvidence(target, ogImage, incomplete), incomplete);
});

test("shared-brand pages, unbound/chrome resources and another depicted entity never resolve identity", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { module: "day", moduleType: "day", exactIdentityRequired: true,
    queryCore: { identity: "长颈鹿中心", identityEn: "Giraffe Centre" },
    minimumVisualProof: { subject: "giraffe", identityRequirement: "长颈鹿中心" } };
  const image = { ...candidate, pageUrl: "https://giraffecentre.org/our-sanctuary/", entityPagePath: "/our-sanctuary/",
    imageUrl: "https://giraffecentre.org/uploads/Activities-hero-image.jpg", kind: "page-image",
    pagePosition: "content", resourceRole: "media" };
  const negatives = [
    { ...image, pageUrl: "https://shared-brand.org/giraffe-centre/", entityPagePath: "/giraffe-centre/", imageUrl: "https://shared-brand.org/giraffe-centre/hero.jpg", title: "Giraffe Centre" },
    { ...image, pageUrl: "https://giraffecentre.org/", entityPagePath: "/" },
    { ...image, pageUrl: "https://giraffecentre.org/properties/giraffe-centre/", entityPagePath: "/properties/giraffe-centre/" },
    { ...image, pageUrl: "https://giraffecentre.org/partner-venues/", entityPagePath: "/partner-venues/" },
    { ...image, pagePosition: "chrome" },
    { ...image, pagePosition: "other" },
    { ...image, entityPagePath: "" },
    { ...image, entityPagePath: "/another-page/" },
    { ...image, resourceRole: "ui" },
    { ...image, kind: "embedded-media" },
    { ...image, imageUrl: "https://media.other-site.org/Activities-hero-image.jpg" },
    { ...image, depictedIdentity: "Another Wildlife Centre" },
  ];
  for (const [index, negative] of negatives.entries()) {
    assert.equal(webEntityOwnedPageImageEvidence(negative, target), null, `negative ${index}`);
    const judged = judgment(candidate.candidateId, { identityMatch: false, hotelIdentityMatch: false, eligible: false,
      identityEvidence: { status: "insufficient", basis: "none", evidenceIds: [], explanation: "No image-level identity" } });
    judged.auditEvidenceVersion = IMAGE_AUDIT_EVIDENCE_VERSION;
    assert.equal(applyWebImageIdentityEvidence(target, negative, judged), judged, `negative ${index}`);
  }
  const base = judgment(candidate.candidateId, { identityMatch: false, hotelIdentityMatch: false, eligible: false,
    identityEvidence: { status: "insufficient", basis: "none", evidenceIds: [], explanation: "No image-level identity" },
    auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION });
  for (const conflict of [
    { visibleIdentityConflict: true }, { hardRejectCode: "wrong_activity" }, { coreSubjectMatch: false },
    { auditContract: { complete: false } }, { locationMatch: false },
  ]) assert.equal(applyWebImageIdentityEvidence({ ...target, locationRole: "visual_identity" }, image, { ...base, ...conflict }).identityEvidence.status, "insufficient");
});

test("the new non-hotel location gate does not change the hotel property-page proof", () => {
  const target = { moduleType: "hotel", module: "hotel", hotel: "Azure Pavilion", locationRole: "visual_identity",
    exactIdentityRequired: true, queryCore: { identity: "Azure Pavilion" } };
  const candidate = { pageUrl: "https://brand.example/properties/azure-pavilion/gallery",
    imageUrl: "https://brand.example/properties/azure-pavilion/suite.jpg", kind: "page-image",
    pagePosition: "content", resourceRole: "media" };
  const audit = judgment("hotel-1", { auditEvidenceVersion: IMAGE_AUDIT_EVIDENCE_VERSION,
    identityMatch: false, hotelIdentityMatch: false, locationMatch: false, eligible: false,
    identityEvidence: { status: "insufficient", basis: "none", evidenceIds: [] } });
  const corrected = applyWebImageIdentityEvidence(target, candidate, audit);
  assert.equal(corrected.identityEvidence.status, "supported");
  assert.equal(corrected.identityMatch, true);
  assert.equal(corrected.locationMatch, false, "source proof must not silently overwrite an independent location verdict");
});

test("unsupported or cross-photo citations and a navigation image stay unreviewed", async (t) => {
  const { candidate } = await fixtures(t);
  const candidates = [{ ...candidate, caption: "Suite at Azure Pavilion" }, { ...candidate, candidateId: "photo-2", entityPagePath: "/azure-pavilion", pagePosition: "chrome" }, { ...candidate, candidateId: "photo-3" }];
  const { results } = await audit(candidates, candidates.map((item, index) => judgment(item.candidateId, {
    identityEvidence: { status: "supported", basis: index === 1 ? "entity_page" : "photo_local", evidenceIds: [index === 1 ? "entityPagePath" : "caption"], quote: index === 0 ? "Invented Azure Pavilion description" : "azure-pavilion", explanation: "必须是实际存在于当前图证据中的引用" },
  })));
  assert.ok(results.every(isIdentityEvidenceUnresolved));
});

test("an unrelated accommodation context cannot prove the identity of a different planned entity", async (t) => {
  const { candidate } = await fixtures(t);
  const { results: [result] } = await audit([{ ...candidate, caption: "Suite at Background Hotel" }], [judgment(candidate.candidateId, {
    identityEvidence: { status: "supported", basis: "photo_local", evidenceIds: ["caption"], quote: "Background Hotel", explanation: "The accommodation is only background context" },
  })], { ...identitySlot, hotel: "Background Hotel" });
  assert.ok(isIdentityEvidenceUnresolved(result));
});

test("necessary identity must match one complete alias, not a shared brand or region word", async (t) => {
  const { candidate } = await fixtures(t);
  for (const [identity, identityEn, quote] of [
    ["Angama Amboseli", "", "Angama Mara"],
    ["Ritz Carlton Masai Mara", "", "Mara"],
    ["Azure Valley Pavilion", "Blue Mountain Lodge", "Azure Mountain"],
    ["Azure Valley Pavilion", "Blue Mountain Lodge", "pool hotel pavilion"],
  ]) {
    const { results: [result] } = await audit([{ ...candidate, caption: quote }], [judgment(candidate.candidateId, {
      identityEvidence: { status: "supported", basis: "photo_local", evidenceIds: ["caption"], quote, explanation: "A shared word must not prove a different named property" },
    })], { ...identitySlot, queryCore: { identity, identityEn } });
    assert.equal(result.identityEvidence.status, "insufficient", `${identity} must not be proved by ${quote}`);
    assert.equal(result.eligible, false);
    assert.ok(isIdentityEvidenceUnresolved(result));
  }
});

test("complete English or Chinese aliases retain accent and punctuation normalization", async (t) => {
  const { candidate } = await fixtures(t);
  for (const [identity, identityEn, quote] of [
    ["昂加马安博塞利", "Angama Amboseli", "Angama-Amboseli"],
    ["昂加马安博塞利", "Angama Amboseli", "昂加马安博塞利的套房"],
    ["Hôtel Élégant Étoile", "", "Hotel Elegant Etoile"],
    ["Azure Valley Pavilion", "Blue Mountain Lodge", "Blue-Mountain"],
  ]) {
    const { results: [result] } = await audit([{ ...candidate, caption: quote }], [judgment(candidate.candidateId, {
      identityEvidence: { status: "supported", basis: "photo_local", evidenceIds: ["caption"], quote, explanation: "The quote contains one complete supplied alias" },
    })], { ...identitySlot, queryCore: { identity, identityEn } });
    assert.equal(result.identityEvidence.status, "supported", `${quote} is a complete alias`);
    assert.equal(result.eligible, true);
  }
});

test("a concatenated quote is supported only by one cited record containing the complete identity", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { ...identitySlot, queryCore: { identity: "The Ritz-Carlton Masai Mara Safari Camp" } };
  const entityPagePath = "/en/hotels/nbomr-the-ritz-carlton-masai-mara-safari-camp/overview/";
  const resourceName = "rz-nbomr-suites-and-fitness-center-28672";
  const alt = "Aerial view of luxury safari camp";
  const quote = `${resourceName} 与 ${entityPagePath} 及 '${alt}'`;
  const evidence = { status: "supported", basis: "entity_page", evidenceIds: ["entityPagePath", "resourcePath", "alt"], quote, explanation: "The candidate belongs to the named hotel's own overview page" };
  const { results: [supported], request } = await audit([{ ...candidate, entityPagePath, alt, imageUrl: `https://example.com/${resourceName}.jpg` }], [judgment(candidate.candidateId, { identityEvidence: evidence })], target);
  assert.equal(supported.identityEvidence.status, "supported");
  assert.equal(supported.eligible, true);
  assert.match(request.messages[0].content.find((item) => item.type === "text").text, /quote只逐字引用一个evidenceId/);

  for (const [attributes, invalidEvidence] of [
    [{ entityPagePath: "/masai-mara-safari-camp/", alt: "The Ritz-Carlton" }, { ...evidence, basis: "photo_local", quote: "The Ritz-Carlton 与 /masai-mara-safari-camp/" }],
    [{ entityPagePath, alt }, { ...evidence, evidenceIds: ["alt"] }],
    [{ title: entityPagePath, alt }, { ...evidence, evidenceIds: ["pageTitle"] }],
    [{ entityPagePath: "/unrelated-property/", alt }, evidence],
  ]) {
    const { results: [result] } = await audit([{ ...candidate, ...attributes }], [judgment(candidate.candidateId, { identityEvidence: invalidEvidence })], target);
    assert.ok(isIdentityEvidenceUnresolved(result));
  }
});

test("missing identity evidence is manual while visible or cited identity conflicts remain hard rejected", async (t) => {
  const { candidate } = await fixtures(t);
  const unknown = judgment(candidate.candidateId, { identityMatch: false, hotelIdentityMatch: false, eligible: false, hardRejectCode: "wrong_hotel", matchLevel: "mismatch" });
  const { results: [manual] } = await audit([candidate], [unknown]);
  assert.equal(manual.hardRejectCode, "none");
  assert.ok(isIdentityEvidenceUnresolved(manual));
  for (const overrides of [
    { visibleIdentityConflict: true },
    { identityEvidence: { status: "conflict", basis: "photo_local", evidenceIds: ["caption"], quote: "Emerald Palace", observedIdentity: "Emerald Palace", explanation: "图注明确属于另一个酒店" } },
  ]) {
    const { results: [result] } = await audit([{ ...candidate, caption: "Suite at Emerald Palace" }], [judgment(candidate.candidateId, overrides)]);
    assert.equal(result.identityEvidence.status, "conflict");
    assert.equal(result.hardRejectCode, "wrong_hotel");
    assert.equal(candidateQualification({ hardJudgment: result }), "rejected");
  }
});

test("unknown identity never hides independent watermark or subject errors", async (t) => {
  const { candidate } = await fixtures(t);
  for (const [overrides, expectedCode] of [[{ watermarkFree: false, hardRejectCode: "watermark" }, "watermark"], [{ coreSubjectMatch: false, subjectMatch: false, hardRejectCode: "wrong_subject" }, "wrong_subject"], [{ coreActionMatch: false, activityMatch: false, hardRejectCode: "none" }, "wrong_activity"]]) {
    const { results: [result] } = await audit([candidate], [judgment(candidate.candidateId, overrides)]);
    assert.equal(result.identityEvidence.status, "insufficient");
    assert.equal(result.hardRejectCode, expectedCode);
    assert.equal(isIdentityEvidenceUnresolved(result), false);
    assert.equal(candidateQualification({ hardJudgment: result }), "rejected");
  }
});

test("a visible unique identifier can support identity; ordinary scenes and legacy candidates keep their contract", async (t) => {
  const { candidate } = await fixtures(t);
  const { results: [visible] } = await audit([candidate], [judgment(candidate.candidateId, {
    identityEvidence: { status: "supported", basis: "visible_identifier", visibleIdentifier: "Sign reading Azure Pavilion", explanation: "入口标牌直接对应目标实体" },
  })]);
  assert.equal(visible.identityEvidence.status, "supported");
  const { results: [ordinary] } = await audit([candidate], [judgment(candidate.candidateId)], { ...identitySlot, exactIdentityRequired: false });
  assert.equal(ordinary.identityEvidence.status, "not_required");
  assert.equal(ordinary.eligible, true);
  assert.equal(candidateQualification({ qualificationStatus: "eligible", hardJudgment: judgment("legacy") }), "eligible");
});

test("optional experience venue stays a preference when another hotel's image shows the right experience", async (t) => {
  const { candidate } = await fixtures(t);
  const target = {
    moduleType: "day", location: "Nairobi", locationRole: "visual_identity", exactIdentityRequired: false,
    queryCore: { subject: "visitor and giraffe", action: "feeding", identity: "Giraffe Centre" },
    visualGoal: "Visitors feeding giraffes at Giraffe Centre",
  };
  const constraints = buildImageConstraints(target);
  assert.equal(constraints.core.identityRequirement, "");
  assert.equal(constraints.core.visualLocation, "Nairobi", "the separate visible-location gate remains");
  const image = { ...candidate, sourceKind: "knowledge_library",
    knowledgeMatchedFile: { filename: "experience.jpg", sourceDisplayPath: "Kenya/Nairobi/Other Hotel/experience.jpg" },
    knowledgeSourcePaths: ["Kenya/Nairobi/Other Hotel/experience.jpg"] };
  const { results: [result] } = await audit([image], [judgment(image.candidateId, {
    actualSubject: "Visitor feeding a giraffe", reason: "The source path points to Giraffe Centre",
    identityEvidence: { status: "supported", basis: "knowledge_path", evidenceIds: ["knowledgePath1"],
      quote: "Giraffe Centre", visibleIdentifier: "Typical Giraffe Centre feeding platform", explanation: "Venue proven" },
  })], { ...target, minimumVisualProof: constraints.minimumVisualProof });
  assert.equal(result.identityEvidence.status, "not_required");
  assert.equal(result.identityEvidence.basis, "none");
  assert.equal(result.identityEvidence.quote, "");
  assert.equal(result.identityEvidence.visibleIdentifier, "");
  assert.equal(result.matchLevel, "representative");
  assert.doesNotMatch(result.reason, /source path points to Giraffe Centre/);
  assert.equal(failedHardRequirement(target, result), null);
  const { results: [identityOnlyRejection] } = await audit([image], [judgment(image.candidateId, {
    actualSubject: "Visitor feeding a giraffe", coreSubjectMatch: true, coreActionMatch: true,
    identityMatch: false, eligible: false, hardRejectCode: "wrong_subject", matchLevel: "mismatch",
    reason: "Wrong subject because this is not the named venue",
  })], { ...target, minimumVisualProof: constraints.minimumVisualProof });
  assert.equal(identityOnlyRejection.hardRejectCode, "none");
  assert.equal(identityOnlyRejection.matchLevel, "representative");
  assert.equal(failedHardRequirement(target, identityOnlyRejection), null);
});

test("only image-bound venue evidence preserves exact; hard identity and visible conflicts remain gated", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { moduleType: "day", exactIdentityRequired: false,
    queryCore: { subject: "visitor and giraffe", action: "feeding", identity: "Giraffe Centre" } };
  const image = { ...candidate, sourceKind: "knowledge_library",
    knowledgeMatchedFile: { filename: "feeding.jpg", sourceDisplayPath: "Kenya/Nairobi/Giraffe Centre/feeding.jpg" },
    knowledgeSourcePaths: ["Kenya/Nairobi/Giraffe Centre/feeding.jpg"] };
  const { results: [supported] } = await audit([image], [judgment(image.candidateId, {
    actualSubject: "Visitor feeding a giraffe", reason: "The image shows the exact venue",
  })], target);
  assert.equal(supported.matchLevel, "exact");
  assert.equal(supported.identityEvidence.basis, "knowledge_path");
  assert.match(supported.identityEvidence.quote, /Giraffe Centre/);

  const mixedPaths = { ...image,
    knowledgeMatchedFile: { filename: "feeding.jpg", sourceDisplayPath: "Kenya/Nairobi/Other Hotel/feeding.jpg" },
    knowledgeSourcePaths: ["Kenya/Nairobi/Giraffe Centre/feeding.jpg"] };
  const { results: [mixed] } = await audit([mixedPaths], [judgment(image.candidateId)], target);
  assert.equal(mixed.matchLevel, "representative", "a result-level path cannot override the matched file's own path");

  const unbound = { ...image, knowledgeMatchedFile: { filename: "feeding.jpg", sourceDisplayPath: "Kenya/Nairobi/Other Hotel/feeding.jpg" },
    knowledgeSourcePaths: ["Kenya/Nairobi/Other Hotel/feeding.jpg"] };
  const { results: [required] } = await audit([unbound], [judgment(image.candidateId)], { ...target, exactIdentityRequired: true });
  assert.equal(required.identityEvidence.status, "insufficient");
  assert.equal(required.eligible, false);
  assert.equal(failedHardRequirement({ ...target, exactIdentityRequired: true }, required), "needs_user_judgment");

  const { results: [conflict] } = await audit([unbound], [judgment(image.candidateId, {
    visibleIdentityConflict: true, hardRejectCode: "wrong_subject", eligible: false,
  })], target);
  assert.equal(conflict.identityEvidence.status, "conflict");
  assert.equal(failedHardRequirement(target, conflict), "wrong_subject");
  assert.match(buildImageConstraints({ moduleType: "hotel", hotel: "Azure Pavilion", exactIdentityRequired: false,
    queryCore: { subject: "suite", identity: "Azure Pavilion" } }).core.identityRequirement, /Azure Pavilion/);
  assert.match(buildImageConstraints({ moduleType: "transport", exactIdentityRequired: false,
    queryCore: { subject: "safari vehicle", identity: "Nairobi Airport" } }).core.identityRequirement, /safari_vehicle/);
});

test("optional venue on an owned Web page may be exact, but a shared-brand page stays representative", async (t) => {
  const { candidate } = await fixtures(t);
  const target = { moduleType: "day", exactIdentityRequired: false,
    queryCore: { subject: "visitor and giraffe", action: "feeding", identity: "Giraffe Centre" } };
  const owned = { ...candidate, sourceKind: "web", pageUrl: "https://giraffecentre.org/our-sanctuary/",
    entityPagePath: "/our-sanctuary/", imageUrl: "https://giraffecentre.org/uploads/feeding.jpg",
    kind: "page-image", pagePosition: "content", resourceRole: "media" };
  const shared = { ...owned, pageUrl: "https://travel.example/giraffe-centre/",
    entityPagePath: "/giraffe-centre/", imageUrl: "https://travel.example/images/feeding.jpg" };
  for (const [image, expected] of [[owned, "exact"], [shared, "representative"]]) {
    const { results: [result] } = await audit([image], [judgment(image.candidateId, {
      actualSubject: "Visitor feeding a giraffe", reason: "The source page belongs to Giraffe Centre",
    })], target);
    assert.equal(result.matchLevel, expected);
    assert.equal(result.identityEvidence.status, "not_required");
    assert.equal(result.identityEvidence.basis, expected === "exact" ? "entity_page" : "none");
    assert.equal(failedHardRequirement(target, result), null);
  }
});
