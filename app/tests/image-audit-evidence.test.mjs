import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { judgeCandidatesBatch } from "../server/image-audit.mjs";
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
    fetchImpl: async (_url, options) => {
      calls += 1;
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments }) } }] }) };
    },
  });
  assert.equal(calls, 1, "source evidence and visual judgment share one request");
  return { results, request };
}

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
