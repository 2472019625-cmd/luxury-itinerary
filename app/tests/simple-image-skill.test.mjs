import test from "node:test";
import assert from "node:assert/strict";
import { buildWebExecutionQueries, classifyWebFallback } from "../server/image-web-execution.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applyKnowledgeSourcePathEvidence, buildImageConstraints, buildImageQueries, buildKnowledgeQueryCacheKey, classifyTransportType, completeVisualJudgment, failedHardRequirement, runImageSearchSkill } from "../server/simple-image-skill.mjs";
import { judgeCandidatesBatch } from "../server/image-audit.mjs";
import { searchKnowledgeImages } from "../server/knowledge-image-search.mjs";
import { buildKnowledgeHierarchy, explicitEntityRoute } from "../server/knowledge-scope-resolver.mjs";

const slot = (id, overrides = {}) => ({ slotId: id, moduleType: "day", required: true, location: "塞伦盖蒂", activity: "全天游猎", subject: "草原环境与游猎行动", searchIntent: ["草原游猎", "野生动物观察"], visualGoal: "表现进入草原后的环境建立", visualContext: { dayRole: "环境建立", avoid: ["与相邻 DAY 相同机位"] }, copyTargetId: `copy-${id}`, aspectRatio: "16:9", userLocked: false, ...overrides });

test("明确实体目录缺失零Knowledge请求；专属体验no_match最多两词且不扩Scope", async (t) => {
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库" },
    { node_id: "country", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "region", formal_name: "安博塞利", parent_node_id: "country" },
    { node_id: "hotel", formal_name: "Angama Amboseli", parent_node_id: "region" },
  ]);
  for (const target of [
    slot("missing-restaurant", { moduleType: "dining", diningLocation: "Cloud Table", location: "安博塞利", country: "肯尼亚", subject: "餐厅内景", activity: "用餐", fidelityQuery: "餐厅内景", alternateQueries: ["restaurant interior"] }),
    slot("missing-museum", { location: "云川博物馆", region: "安博塞利", country: "肯尼亚", locationRole: "visual_identity", queryCore: { subject: "博物馆建筑", identity: "云川博物馆" }, subject: "博物馆建筑", fidelityQuery: "博物馆建筑", alternateQueries: ["museum exterior"] }),
    slot("exclusive-no-match", { hotel: "Angama Amboseli", location: "安博塞利", country: "肯尼亚", subject: "专属星空床", activity: "星空床", fidelityQuery: "星空床", alternateQueries: ["star bed", "outdoor bed"] }),
    slot("exclusive-empty", { hotel: "Angama Amboseli", location: "安博塞利", country: "肯尼亚", subject: "专属星空床", activity: "星空床", fidelityQuery: "星空床", alternateQueries: ["star bed", "outdoor bed"] }),
  ]) {
    target.exactIdentityRequired = true;
    target.queryCore = { ...target.queryCore, identity: target.hotel || target.diningLocation || target.queryCore?.identity };
    if (target.hotel) target.entityType = "hotel_experience";
    const root = await mkdtemp(path.join(os.tmpdir(), "entity-fast-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const knowledgeCalls = [], webCalls = [];
    const result = await runImageSearchSkill({
      root, slots: [target], sourceMode: "knowledge_first", knowledgeBaseUrl: "http://knowledge.invalid",
      adapters: {
        loadKnowledgeHierarchy: async () => hierarchy,
        searchKnowledgeImages: async ({ queries, scopeNodeIds }) => { knowledgeCalls.push({ queries, scopeNodeIds }); return { status: "completed", queryText: queries[0], scopeState: target.slotId === "exclusive-empty" ? "empty" : "no_match", candidates: [], records: [] }; },
        searchWebBatch: async ({ queries }) => { webCalls.push(queries); return []; },
        searchCommonsImages: async () => [],
      },
    });
    const evidence = result.results[0].pipelineEvidence;
    assert.equal(evidence.explicit_entity_fast_path, true);
    assert.equal(evidence.explicitEntityFastPath.enteredWeb, true);
    assert.ok(webCalls.length > 0 && webCalls.length <= 2);
    assert.ok(webCalls.every((queries) => queries.length === 1 && queries[0].includes(evidence.explicitEntityFastPath.entityName)));
    if (target.slotId.startsWith("exclusive-")) {
      assert.equal(knowledgeCalls.length, target.slotId === "exclusive-empty" ? 1 : 2);
      assert.ok(evidence.knowledgeSearch.attempts.every((attempt) => attempt.scopeNodeIds.join() === "hotel"));
      assert.equal(evidence.explicitEntityFastPath.knowledgeStopReason, target.slotId === "exclusive-empty" ? "entity_directory_empty" : "entity_directory_no_match");
    } else {
      assert.equal(knowledgeCalls.length, 0);
      assert.equal(evidence.knowledgeSearch.status, "entity_directory_missing");
      assert.equal(evidence.knowledgeSearch.knowledgeQueryExecuted, false);
      assert.equal(evidence.explicitEntityFastPath.knowledgeStopReason, "entity_directory_missing");
    }
  }
});

test("酒店目录含轻微拼写误差时仍向已确认目录发出Knowledge请求", async (t) => {
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库" },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "mara", formal_name: "马赛马拉", parent_node_id: "kenya" },
    { node_id: "ritz", formal_name: "Ritz Carton", parent_node_id: "mara" },
    { node_id: "jw", formal_name: "JW Marriot Hotel Nairobi", parent_node_id: "kenya" },
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), "hotel-directory-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const hotels = [
    ["ritz-slot", "The Ritz-Carlton, Masai Mara Safari Camp", "Masai Mara"],
    ["jw-slot", "JW Marriott Hotel Nairobi", "Nairobi"],
  ].map(([id, hotel, location]) => slot(id, {
    moduleType: "hotel",
    hotel,
    location,
    country: "Kenya",
    subject: "酒店代表性空间",
    activity: "",
    exactIdentityRequired: true,
    queryCore: { subject: "酒店代表性空间", identity: hotel },
    fidelityQuery: "酒店外观",
    alternateQueries: ["hotel exterior"],
  }));
  const result = await runImageSearchSkill({
    root,
    slots: hotels,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://knowledge.invalid",
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        calls.push({ queries: [...queries], scopeNodeIds: [...scopeNodeIds] });
        return { status: "completed", queryText: queries[0], scopeState: "empty", records: [], candidates: [] };
      },
    },
  });
  assert.deepEqual(calls.map((call) => call.scopeNodeIds[0]).sort(), ["jw", "ritz"]);
  assert.ok(calls.every((call) => call.queries.length === 1));
  assert.ok(result.results.every((item) => item.pipelineEvidence.knowledgeSearch.knowledgeQueryExecuted === true));
  assert.ok(result.results.every((item) => item.pipelineEvidence.explicitEntityFastPath.knowledgeStopReason === "entity_directory_empty"));
});

test("实体Web保留短Query动作，身份未知或审核未完成不自动放行", () => {
  const target = { moduleType: "dining", diningLocation: "Cloud Table", region: "Cloud City", subject: "餐厅内景",exactIdentityRequired:true,queryCore:{identity:"Cloud Table"} };
  const route = { ...explicitEntityRoute(target), knowledgeStopReason: "entity_directory_no_match" };
  assert.deepEqual(buildWebExecutionQueries(target, ["Cloud Table dining", "restaurant interior"], "explicit_entity", route), ["Cloud Table dining Cloud City", "Cloud Table restaurant interior Cloud City"]);
  assert.equal(classifyWebFallback({ kind: "no_eligible" }, target, route).allowed, true);
  assert.equal(classifyWebFallback({ kind: "inconclusive", technicalStatus: "visual_judgment_inconclusive" }, target, route).allowed, false);
  assert.equal(classifyWebFallback({ kind: "no_candidate" }, target, { ...route, identityKnown: false }).allowed, false);
});
const completeAudit = (candidateOrId, overrides = {}) => ({
  candidateId: typeof candidateOrId === "string" ? candidateOrId : candidateOrId.candidateId,
  actualSubject: "测试候选主体",
  matchLevel: "exact",
  locationMatch: true,
  visibleLocationConflict: false,
  hotelIdentityMatch: true,
  visibleIdentityConflict: false,
  activityMatch: true,
  coreActionMatch: true,
  subjectMatch: true,
  coreSubjectMatch: true,
  identityMatch: true,
  subjectClear: true,
  subjectLargeEnough: true,
  subjectPrimary: true,
  transportType: "none",
  transportTypeMatch: true,
  watermarkFree: true,
  nonAI: true,
  photographic: true,
  technicalUsable: true,
  eligible: true,
  hardRejectCode: "none",
  relevance: 90,
  luxury: 85,
  cleanliness: 90,
  composition: 88,
  score: 90,
  reason: "测试判断完整",
  ...overrides,
});

const knowledgeFixture = (queryText, { queryId = `qry-${queryText}`, count = 4, prefix = queryId, assetIds = [], fragment = queryText, sourcePaths = [] } = {}) => {
  const records = Array.from({ length: count }, (_, index) => ({
    recordId: `${prefix}-record-${index + 1}`,
    assetId: assetIds[index] || `${prefix}-asset-${index + 1}`,
    ranking: index + 1,
    filename: `${prefix}-${index + 1}.jpg`,
    mimeType: "image/jpeg",
    fragmentContent: fragment,
    sourcePaths,
    preview: { relation: "preview", url: `http://192.168.100.210:9000/preview/${prefix}-${index + 1}.webp?token=${queryId}`, filename: `${prefix}-${index + 1}.preview.webp`, mimeType: "image/webp", versionId: assetIds[index] || `${prefix}-asset-${index + 1}` },
    matchedFile: { relation: "matched_file", url: `http://192.168.100.210:9000/original/${prefix}-${index + 1}.jpg?token=${queryId}`, filename: `${prefix}-${index + 1}.jpg`, mimeType: "image/jpeg", versionId: assetIds[index] || `${prefix}-asset-${index + 1}` },
  }));
  return {
    status: "completed",
    queryId,
    queryText,
    durationMs: 1,
    records,
    candidates: records.map((record) => ({
      imageUrl: record.preview.url,
      previewUrl: record.preview.url,
      pageUrl: `http://192.168.100.210:8020/q/${queryId}`,
      title: record.filename,
      alt: record.fragmentContent,
      semanticText: record.fragmentContent,
      sourceKind: "knowledge_library",
      knowledgeAssetId: record.assetId,
      knowledgeRecordId: record.recordId,
      knowledgeQueryId: queryId,
      knowledgeFragmentContent: record.fragmentContent,
      knowledgeSourcePaths: record.sourcePaths,
      knowledgePreview: record.preview,
      knowledgeMatchedFile: record.matchedFile,
    })),
  };
};

async function writeDistinctTestImage(filePath, index = 1) {
  const width = 90;
  const height = 80;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    const value = (x * (17 + index * 3) + y * (29 + index * 5) + ((x + y + index) % (3 + index)) * 61) % 256;
    data[offset] = value;
    data[offset + 1] = (value + index * 31) % 256;
    data[offset + 2] = (255 - value + index * 13) % 256;
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).resize(1400, 900, { kernel: "nearest" }).jpeg().toFile(filePath);
}

test("知识库异步查询保留 query_id、来源路径与实际下载 origin", async () => {
  const responses = [
    new Response(JSON.stringify({ data: { query_id: "qry-1", status: "pending" } }), { status: 202, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ data: { status: "processing" } }), { status: 202, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ data: { status: "completed", results: [{ ranking: 1, fragment: { content: { description: [{ text: "Singita 营地泳池" }], ocr_text: [], associations: [] } }, source_paths: [{ source_display_path: "坦桑尼亚/Singita/Faru Faru" }], path: [
      { relation: "matched_file", knowledge_id: "knw-1", version_id: "ver-1", url: "http://192.168.100.210:9000/raw/photo.jpg?token=original", filename: "photo.jpg", mime_type: "image/jpeg" },
      { relation: "preview", knowledge_id: "knw-1", version_id: "ver-1", url: "http://192.168.100.210:9000/preview/photo.webp?token=preview", filename: "photo.preview.webp", mime_type: "image/webp", locator: { kind: "image_preview", max_edge: 960, size_bytes: 72784 } },
    ] }] } }), { status: 200, headers: { "content-type": "application/json" } }),
  ];
  const requests = [];
  const result = await searchKnowledgeImages({
    queries: ["Singita Faru Faru pool"], baseUrl: "http://192.168.100.210:8020", topK: 5, pollIntervalMs: 1,
    fetchImpl: async (url, options = {}) => { requests.push({ url, options }); return responses.shift(); },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.queryId, "qry-1");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.records[0].downloadOrigin, "http://192.168.100.210:9000");
  assert.equal(result.records[0].mimeType, "image/webp");
  assert.equal(result.records[0].preview.relation, "preview");
  assert.equal(result.records[0].matchedFile.relation, "matched_file");
  assert.match(result.candidates[0].imageUrl, /\/preview\/photo\.webp/);
  assert.match(result.candidates[0].knowledgeMatchedFile.url, /\/raw\/photo\.jpg/);
  assert.equal(result.records[0].fragmentContent, "Singita 营地泳池");
  assert.deepEqual(result.records[0].sourcePaths, ["坦桑尼亚/Singita/Faru Faru"]);
  assert.equal(requests.length, 3);
  assert.match(requests[0].url, /\/api\/knowledge\/query$/);
  assert.equal(requests[0].options.method, "POST");
  assert.ok(requests[0].options.headers["Idempotency-Key"]);
});

test("知识库 completed 空结果区分目录为空、暂无可检索内容与未命中", async () => {
  const cases = [
    ["empty", "内容为空"],
    ["unavailable", "目录存在文件，但暂无可检索内容"],
    ["no_match", "未找到匹配内容"],
  ];
  for (const [scopeState, message] of cases) {
    const responses = [
      new Response(JSON.stringify({ data: { query_id: `qry-${scopeState}` } }), { status: 202, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ data: { status: "completed", results: [], scope_state: scopeState, message } }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const result = await searchKnowledgeImages({ queries: ["unlikely subject"], baseUrl: "http://192.168.100.210:8020", fetchImpl: async () => responses.shift() });
    assert.equal(result.status, "completed");
    assert.equal(result.scopeState, scopeState);
    assert.equal(result.message, message);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.records, []);
  }
});

test("知识库正常命中时目录反馈字段保持为空且结果照常解析", async () => {
  const responses = [
    new Response(JSON.stringify({ data: { query_id: "qry-normal-hit" } }), { status: 202, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ data: { status: "completed", scope_state: null, message: null, results: [{ ranking: 1, fragment: { content: "酒店泳池" }, source_paths: ["肯尼亚/酒店"], path: [{ url: "http://192.168.100.210:9000/pool.jpg", filename: "pool.jpg", MIME: "image/jpeg" }] }] } }), { status: 200, headers: { "content-type": "application/json" } }),
  ];
  const result = await searchKnowledgeImages({ queries: ["pool"], baseUrl: "http://192.168.100.210:8020", fetchImpl: async () => responses.shift() });
  assert.equal(result.status, "completed");
  assert.equal(result.scopeState, null);
  assert.equal(result.message, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.records[0].fragmentContent, "酒店泳池");
});

test("Image Skill 直接展示知识库目录反馈，但保持 not_found 而非 failed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-scope-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["empty-hotel"],
    knowledgeQueriesPerSlot: 1,
    slots: [slot("empty-scope")],
    adapters: {
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-empty-scope", queryText: queries[0], scopeState: "empty", message: "内容为空", candidates: [], records: [], clarificationNodeIds: [] }),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.results[0].technicalStatus, "knowledge_scope_empty");
  assert.equal(result.results[0].matchReason, "内容为空");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.scopeState, "empty");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.message, "内容为空");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.attempts[0].scopeState, "empty");
});

test("酒店只锁定根目录，no_match才继续下一个高价值类别Query", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-scope-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "amboseli", formal_name: "安博塞利", parent_node_id: "kenya" },
    { node_id: "angama", formal_name: "AngamaAmboseli", parent_node_id: "amboseli", scope_includes_descendants: false },
    { node_id: "angama-stay", formal_name: "Stay", parent_node_id: "angama" },
  ]);
  const calls = [];
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeQueriesPerSlot: 3,
    slots: [slot("scope-routing", { moduleType: "hotel", hotel: "Angama Amboseli", location: "Amboseli", activity: "", subject: "Angama Amboseli", searchIntent: ["酒店外观", "酒店套房", "酒店泳池"] })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        const scopeNodeId = scopeNodeIds[0];
        calls.push({ scopeNodeId, query: queries[0] });
        return scopeNodeId === "angama-stay"
          ? { status: "completed", queryId: "qry-empty-child", queryText: queries[0], scopeState: "empty", message: "内容为空", candidates: [], records: [], clarificationNodeIds: [] }
          : { status: "completed", queryId: `qry-no-match-${calls.length}`, queryText: queries[0], scopeState: "no_match", message: "未找到匹配内容", candidates: [], records: [], clarificationNodeIds: [] };
      },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.deepEqual(calls.map((item) => item.scopeNodeId), ["angama", "angama", "angama"]);
  assert.deepEqual(calls.map((item) => item.query), ["酒店外观", "酒店套房", "酒店泳池"]);
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.results[0].technicalStatus, "knowledge_not_found");
  assert.equal(result.results[0].matchReason, "未找到匹配内容");
  assert.equal(result.metrics.knowledgeFailed, 0);
  assert.equal(result.metrics.knowledgeTimeouts, 0);
});

test("酒店目录和地区国家Scope都无法解析时不发空Scope知识库请求", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-empty-hotel-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
  ]);
  let knowledgeCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    slots: [slot("hotel-empty-scope", {
      moduleType: "hotel",
      hotel: "Aurora Wilderness Lodge",
      location: "未知地区",
      country: "未知国家",
      locationRole: "scope_only",
      subject: "酒店外观",
      primaryVisualSubject: "酒店外观",
      queryCore: { subject: "酒店外观", subjectEn: "hotel exterior" },
      fidelityQuery: "酒店外观",
      alternateQueries: ["hotel exterior"],
    })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async () => { knowledgeCalls += 1; throw new Error("不应发出空Scope请求"); },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(knowledgeCalls, 0);
  assert.equal(result.results[0].status, "needs_user_action");
  assert.equal(result.results[0].technicalStatus, "knowledge_hotel_scope_unresolved");
  assert.match(result.results[0].matchReason, /未向知识库发出空Scope请求/);
});

test("最后一层 unavailable 返回明确状态且不计为失败", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["unavailable-scope"],
    knowledgeQueriesPerSlot: 4,
    slots: [slot("unavailable-scope")],
    adapters: {
      searchKnowledgeImages: async ({ queries }) => { calls += 1; return { status: "completed", queryId: "qry-unavailable", queryText: queries[0], scopeState: "unavailable", message: "目录存在文件，但暂无可检索内容", candidates: [], records: [], clarificationNodeIds: [] }; },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.results[0].technicalStatus, "knowledge_scope_unavailable");
  assert.equal(result.results[0].matchReason, "目录存在文件，但暂无可检索内容");
  assert.equal(result.metrics.knowledgeFailed, 0);
  assert.equal(result.metrics.knowledgeTimeouts, 0);
});

test("knowledge_first 遇到末层 empty 仍进入现有 Web 来源 fallback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-empty-web-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let webCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_first",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["empty-scope"],
    knowledgeQueriesPerSlot: 3,
    slots: [slot("empty-web-fallback")],
    adapters: {
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-empty", queryText: queries[0], scopeState: "empty", message: "内容为空", candidates: [], records: [], clarificationNodeIds: [] }),
      searchWebBatch: async () => { webCalls += 1; return []; },
      searchCommonsImages: async () => [],
    },
  });
  assert.equal(webCalls, 2);
  assert.equal(result.metrics.knowledgeFirstWebFallbacks, 1);
  assert.equal(result.results[0].pipelineEvidence.sourceFallback.from, "knowledge_library");
  assert.equal(result.results[0].pipelineEvidence.sourceFallback.to, "web");
});

test("knowledge_only 全程不调用公网搜索并记录每个 Slot 的知识库证据", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let webCalls = 0;
  let commonsCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("knowledge-hit", { searchIntent: ["草原游猎", "野生动物观察"] })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-hit", queryText: queries[0], scope: null, durationMs: 48, clarificationNodeIds: [], records: [{ recordId: "knowledge-qry-hit-1-1", ranking: 1, filename: "safari.jpg", mimeType: "image/jpeg", fragmentContent: "塞伦盖蒂草原游猎与野生动物", sourcePaths: ["坦桑尼亚/塞伦盖蒂"], downloadOrigin: "http://192.168.100.210:9000" }], candidates: [{ imageUrl: "http://192.168.100.210:9000/signed/safari.jpg", pageUrl: "http://192.168.100.210:8020/api/knowledge/output?query_id=qry-hit", title: "safari.jpg", alt: "塞伦盖蒂草原游猎与野生动物", semanticText: "Serengeti safari wildlife", semanticScore: 100, sourceKind: "knowledge_library", knowledgeRecordId: "knowledge-qry-hit-1-1", knowledgeQueryId: "qry-hit", knowledgeFragmentContent: "塞伦盖蒂草原游猎与野生动物", knowledgeSourcePaths: ["坦桑尼亚/塞伦盖蒂"] }] }),
      searchWebBatch: async () => { webCalls += 1; return []; },
      searchCommonsImages: async () => { commonsCalls += 1; return []; },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const filePath = path.join(directory, "knowledge.jpg");
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#987654" } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/knowledge.jpg`, sha256: "knowledge-hash", width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "塞伦盖蒂草原游猎与野生动物", score: 95, reason: "知识库图片与目标一致" })),
    },
  });
  assert.equal(webCalls, 0);
  assert.equal(commonsCalls, 0);
  assert.equal(result.metrics.searchCalls, 0);
  assert.equal(result.metrics.commonsCalls, 0);
  assert.equal(result.metrics.knowledgeCalls, 1);
  assert.equal(result.metrics.knowledgeLogicalQueries, 1);
  assert.equal(result.metrics.knowledgeActualRequests, 1);
  assert.equal(result.metrics.knowledgeMergedDuplicates, 0);
  assert.equal(result.metrics.knowledgeOnlyVerified, true);
  assert.equal(result.metrics.knowledgeSlotOutcomes.selected, 1);
  assert.equal(result.results[0].selected.sourceKind, "knowledge_library");
  assert.match(result.results[0].selected.imageUrl, /^\/image-assets\//);
  assert.doesNotMatch(JSON.stringify(result), /\/signed\/safari\.jpg/);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.queryId, "qry-hit");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates[0].downloadStatus, "success");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates[0].judgmentStatus, "approved");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates[0].selected, true);
});

test("酒店按高价值类别逐个查询，第二类找到合格图后立即停止", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-query-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let webCalls = 0;
  let commonsCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("hotel-query-plan", { moduleType: "hotel", hotel: "Angama Amboseli", subject: "酒店外观", activity: "", searchIntent: ["酒店外观", "度假酒店外观", "hotel exterior", "lodge exterior"], visualGoal: "酒店代表图" })],
    visionApiKey: "vision",
    visionBaseUrl: "https://vision.invalid",
    visionModel: "model",
    adapters: {
      loadKnowledgeHierarchy: async () => buildKnowledgeHierarchy([{ node_id: "angama-hotel-root", formal_name: "Angama Amboseli" }]),
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        calls.push({ query: queries[0], scopeNodeIds: [...scopeNodeIds] });
        if (queries[0] === "酒店外观") return { status: "completed", queryId: "qry-exterior", queryText: queries[0], scopeState: "no_match", message: "未找到匹配内容", durationMs: 5, records: [], candidates: [] };
        const records = Array.from({ length: 4 }, (_, index) => ({ recordId: `angama-suite-${index + 1}`, ranking: index + 1, filename: `suite-${index + 1}.jpg`, mimeType: "image/jpeg", fragmentContent: "Angama suite", sourcePaths: ["肯尼亚/安博塞利/AngamaAmboseli/Stay"], downloadOrigin: "http://192.168.100.210:9000" }));
        const candidates = records.map((record) => ({ imageUrl: `http://192.168.100.210:9000/signed/${record.filename}`, pageUrl: "http://192.168.100.210:8020/api/knowledge/output?query_id=qry-suite", title: record.filename, alt: "Angama suite", semanticText: "Angama suite", semanticScore: 100, sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: "qry-suite", knowledgeFragmentContent: record.fragmentContent, knowledgeSourcePaths: record.sourcePaths }));
        return { status: "completed", queryId: "qry-suite", queryText: queries[0], durationMs: 7, records, candidates };
      },
      searchWebBatch: async () => { webCalls += 1; return []; },
      searchCommonsImages: async () => { commonsCalls += 1; return []; },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const filePath = path.join(directory, candidate.title);
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#715b45" } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${candidate.title}`, sha256: candidate.knowledgeRecordId, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "Angama suite", score: 95, reason: "酒店身份与空间均匹配" })),
    },
  });
  assert.deepEqual(calls, [
    { query: "酒店外观", scopeNodeIds: ["angama-hotel-root"] },
    { query: "酒店套房", scopeNodeIds: ["angama-hotel-root"] },
  ]);
  assert.equal(webCalls, 0);
  assert.equal(commonsCalls, 0);
  assert.equal(result.results[0].status, "success");
  assert.equal(result.metrics.businessBatches, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.equal(result.metrics.knowledgeCalls, 2);
  const audit = result.results[0].pipelineEvidence.knowledgeSearch;
  assert.deepEqual(audit.queryPlan.queries, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
  assert.deepEqual(audit.queryPlan.sharedScopeNodeIds, ["angama-hotel-root"]);
  assert.equal(audit.attempts.length, 2);
  assert.equal(audit.attempts[0].candidateCount, 0);
  assert.equal(audit.attempts[1].candidateCount, 4);
  assert.ok(audit.attempts.every((attempt) => attempt.startedAt && attempt.endedAt));
});

test("酒店根目录递归包含子目录时只使用根Scope并在首个合格类别早停", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-scope-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "country", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "region", formal_name: "安博塞利", parent_node_id: "country" },
    { node_id: "hotel", formal_name: "AngamaAmboseli", parent_node_id: "region" },
    { node_id: "stay", formal_name: "Stay", parent_node_id: "hotel" },
  ]);
  const calls = [];
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020",
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("scope-plan", { moduleType: "hotel", hotel: "Angama Amboseli", location: "Amboseli", subject: "酒店外观", activity: "", searchIntent: ["酒店外观", "度假酒店外观", "hotel exterior", "lodge exterior"], visualGoal: "酒店代表图" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        calls.push({ query: queries[0], scope: scopeNodeIds[0] });
        if (scopeNodeIds[0] !== "hotel") return { status: "completed", queryId: `empty-${calls.length}`, queryText: queries[0], durationMs: 1, records: [], candidates: [] };
        const records = Array.from({ length: 4 }, (_, index) => ({ recordId: `hotel-exterior-${index + 1}`, filename: `exterior-${index + 1}.jpg`, fragmentContent: "hotel exterior", sourcePaths: [`肯尼亚/安博塞利/AngamaAmboseli/exterior-${index + 1}.jpg`] }));
        return { status: "completed", queryId: "hotel-hit", queryText: queries[0], durationMs: 1, records, candidates: records.map((record) => ({ imageUrl: `http://192.168.100.210:9000/${record.filename}`, pageUrl: "http://192.168.100.210:8020/q/hotel-hit", title: record.filename, sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: "hotel-hit", knowledgeSourcePaths: record.sourcePaths })) };
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const filePath = path.join(directory, candidate.title);
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#715b45" } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${candidate.title}`, sha256: candidate.knowledgeRecordId, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "hotel exterior", score: 95, reason: "matched" })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.deepEqual(calls.map((item) => item.scope), ["hotel"]);
  assert.deepEqual(calls.map((item) => item.query), ["酒店外观"]);
  assert.equal(calls.length, 1);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(result.results[0].pipelineEvidence.knowledgeSearch.scopePlan.scopes.map((item) => item.role), ["hotel_root"]);
  assert.equal(result.metrics.businessBatches, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
});

test("酒店目录明确为空时只查一次知识库并交给既有Web来源", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hotel-empty-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "country", formal_name: "示例国", parent_node_id: "root" },
    { node_id: "region", formal_name: "示例地区", parent_node_id: "country" },
    { node_id: "hotel", formal_name: "Example Lodge", parent_node_id: "region" },
  ]);
  let knowledgeCalls = 0;
  let webCalls = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_first", knowledgeBaseUrl: "http://192.168.100.210:8020",
    searchApiKey: "search", searchBaseUrl: "https://search.invalid", searchModel: "model",
    slots: [slot("hotel-empty-web", { moduleType: "hotel", hotel: "Example Lodge", location: "示例地区", subject: "酒店代表空间", activity: "", searchIntent: ["具体酒店理想画面", "hotel ideal scene"] })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        knowledgeCalls += 1;
        assert.equal(queries[0], "酒店外观");
        assert.deepEqual(scopeNodeIds, ["hotel"]);
        return { status: "completed", queryId: "hotel-empty", queryText: queries[0], scopeState: "empty", message: "酒店目录为空", records: [], candidates: [] };
      },
      searchWebBatch: async () => { webCalls += 1; return []; },
      searchCommonsImages: async () => [],
    },
  });
  assert.equal(knowledgeCalls, 1);
  assert.equal(webCalls, 4);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.attempts.length, 1);
});

test("knowledge source_paths 冲突在原件下载和视觉审核前硬拒绝，但 preview 仍保留", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-path-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "amboseli", formal_name: "安博塞利", parent_node_id: "kenya" },
    { node_id: "angama", formal_name: "AngamaAmboseli", parent_node_id: "amboseli" },
  ]);
  let downloads = 0;
  let judgments = 0;
  const record = { recordId: "wrong-hotel-1", ranking: 1, filename: "pool.jpg", mimeType: "image/jpeg", fragmentContent: "Amboseli Sopa Lodge 泳池", sourcePaths: ["肯尼亚/安博塞利/Amboseli Sopa Lodge/pool.jpg"] };
  const candidate = { imageUrl: "http://192.168.100.210:9000/signed/pool.jpg", pageUrl: "http://192.168.100.210:8020/api/knowledge/output?query_id=qry-wrong", title: "pool.jpg", alt: "其他酒店泳池", sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: "qry-wrong", knowledgeFragmentContent: record.fragmentContent, knowledgeSourcePaths: record.sourcePaths };
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    slots: [slot("angama-path-check", { moduleType: "hotel", hotel: "Angama Amboseli", location: "Amboseli", subject: "Angama Amboseli", activity: "", visualGoal: "酒店代表图" })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-wrong", queryText: queries[0], durationMs: 4, records: [record], candidates: [candidate] }),
      downloadCandidate: async (item, { directory, publicPrefix }) => {
        downloads += 1;
        const filePath = path.join(directory, "wrong-hotel-preview.jpg");
        await writeDistinctTestImage(filePath, 1);
        return { ...item, filePath, publicUrl: `${publicPrefix}/wrong-hotel-preview.jpg`, sha256: "wrong-hotel-preview", width: 960, height: 640 };
      },
      judgeCandidatesBatch: async () => { judgments += 1; return []; },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(downloads, 1);
  assert.equal(judgments, 0);
  assert.equal(result.metrics.matchedFileDownloadAttempts, 0);
  assert.equal(result.metrics.knowledgeSourcePathRejected, 1);
  assert.equal(result.results[0].technicalStatus, "knowledge_no_valid_candidate");
  const audit = result.results[0].pipelineEvidence.knowledgeSearch;
  assert.equal(audit.sourcePathRejectedCount, 1);
  assert.equal(audit.candidates[0].downloadStatus, "not_requested");
  assert.equal(audit.candidates[0].previewStatus, "success");
  assert.equal(audit.candidates[0].failureReason, "knowledge_source_path_mismatch");
  assert.ok(result.results[0].candidates[0].localPreviewUrl);
});

test("知识库 source_path 对目标酒店身份提供正向事实证据", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-positive-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "mara", formal_name: "马赛马拉", parent_node_id: "kenya" },
    { node_id: "ritz", formal_name: "Ritz Carton", parent_node_id: "mara" },
    { node_id: "food", formal_name: "Food", parent_node_id: "ritz" },
  ]);
  const record = { recordId: "ritz-wine-1", ranking: 1, filename: "wine-cellar.jpg", mimeType: "image/jpeg", fragmentContent: "private wine cellar", sourcePaths: ["肯尼亚/马赛马拉/Ritz Carton/Food/wine-cellar.jpg"] };
  const candidate = { imageUrl: "http://192.168.100.210:9000/signed/wine.jpg", pageUrl: "http://192.168.100.210:8020/api/knowledge/output?query_id=qry-wine", title: record.filename, alt: record.fragmentContent, sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: "qry-wine", knowledgeFragmentContent: record.fragmentContent, knowledgeSourcePaths: record.sourcePaths };
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("ritz-wine", { moduleType: "dining", location: "Masai Mara", hotel: "The Ritz-Carlton, Masai Mara Safari Camp", primaryVisualSubject: "私人酒窖品酒", subject: "私人酒窖品酒", activity: "wine tasting", visualGoal: "展示酒店私人酒窖" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-wine", queryText: queries[0], durationMs: 5, records: [record], candidates: [candidate] }),
      downloadCandidate: async (item, { directory, publicPrefix }) => { const filePath = path.join(directory, "wine.jpg"); await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#654321" } }).jpeg().toFile(filePath); return { ...item, filePath, publicUrl: `${publicPrefix}/wine.jpg`, sha256: "ritz-wine-hash", width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((item) => completeAudit(item, { actualSubject: "私人酒窖与葡萄酒陈列", locationMatch: false, visibleLocationConflict: false, hotelIdentityMatch: false, visibleIdentityConflict: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "hotel_identity_mismatch", score: 88, reason: "仅凭画面无法识别具体酒店" })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].selected.hardJudgment.locationMatch, true);
  assert.equal(result.results[0].selected.hardJudgment.hotelIdentityMatch, true);
});

test("长颈鹿中心以近距离互动为视觉目标时可采用同国其他目录中的互动照片", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-giraffe-interaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "nairobi", formal_name: "内罗毕", parent_node_id: "kenya" },
    { node_id: "giraffe-centre", formal_name: "Giraffe Centre", parent_node_id: "nairobi" },
  ]);
  const queryResult = knowledgeFixture("长颈鹿中心游客与长颈鹿互动", {
    queryId: "qry-giraffe-interaction",
    count: 1,
    prefix: "panafric-experience-banner",
    fragment: "长颈鹿舔游客手掌，另一名游客在旁观看",
    sourcePaths: ["肯尼亚/内罗毕/Sarova/Panafric/panafric-experience-banner_.jpg"],
  });
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    knowledgeQueriesPerSlot: 1,
    slots: [slot("giraffe-interaction", {
      moduleType: "day",
      location: "内罗毕",
      activity: "游客与长颈鹿近距离互动",
      subject: "长颈鹿中心与罗特希尔德长颈鹿零距离互动",
      primaryVisualSubject: "长颈鹿中心与罗特希尔德长颈鹿零距离互动",
      visualContext: { destination: "肯尼亚" },
    })],
    visionApiKey: "vision",
    visionBaseUrl: "https://vision.invalid",
    visionModel: "model",
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries }) => ({ ...queryResult, queryText: queries[0] }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const isOriginal = candidate.imageUrl.includes("/original/");
        const filePath = path.join(directory, isOriginal ? "giraffe-original.jpg" : "giraffe-preview.jpg");
        await writeDistinctTestImage(filePath, isOriginal ? 2 : 1);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: path.basename(filePath), width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, {
        actualSubject: "长颈鹿舔游客手掌，游客在旁近距离互动",
        reason: "近距离人与长颈鹿互动清晰",
      })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].selected.sourceTitle, "panafric-experience-banner-1.jpg");
  assert.equal(result.metrics.knowledgeSourcePathRejected, 0);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.scopePlan.purpose, "destination_experience");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.scopePlan.scopes[0].sourcePathMode, "country_context");
});

test("Planner 已标记为 unresolved 的复合图片位不会发起搜索，也不影响图片阶段返回", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-composite-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let knowledgeCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeScopeNodeIds: ["kenya"],
    slots: [slot("composite-subject", {
      location: "肯尼亚",
      activity: "游船追踪河马与鱼鹰俯冲捕鱼",
      subject: "游船追踪河马与鱼鹰俯冲捕鱼",
      primaryVisualSubject: "游船追踪河马与鱼鹰俯冲捕鱼",
      plannerSlotStatus: "unresolved",
      needsUserAction: true,
      plannerValidationIssues: [{ code: "composite_visual_subject", message: "一个图片位包含两个独立画面" }],
    })],
    adapters: {
      searchKnowledgeImages: async () => { knowledgeCalls += 1; return { status: "completed", records: [], candidates: [] }; },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(knowledgeCalls, 0);
  assert.equal(result.results[0].status, "needs_user_action");
  assert.equal(result.results[0].technicalStatus, "planner_slot_unresolved");
  assert.equal(result.results[0].plannerValidationIssues[0].code, "composite_visual_subject");
});

test("单个 Planner unresolved Slot 不阻断同批其他图片位搜索", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-planner-unresolved-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const searchedQueries = [];
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeScopeNodeIds: ["kenya"],
    slots: [
      slot("planner-bad", {
        plannerSlotStatus: "unresolved",
        needsUserAction: true,
        plannerValidationIssues: [{ code: "duplicate_visual_responsibility", message: "与另一图片位重复" }],
      }),
      slot("planner-good", {
        primaryVisualSubject: "湿地象群",
        subject: "湿地象群",
        activity: "观察象群",
        fidelityQuery: "湿地象群",
        alternateQueries: ["elephants in wetlands"],
        queryCore: { subject: "湿地象群", action: "", identity: "", subjectEn: "elephants in wetlands", actionEn: "", identityEn: "" },
      }),
    ],
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        searchedQueries.push(queries[0]);
        return { status: "completed", records: [], candidates: [] };
      },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results.find((item) => item.slotId === "planner-bad").technicalStatus, "planner_slot_unresolved");
  assert.equal(result.results.find((item) => item.slotId === "planner-good").status, "not_found");
  assert.ok(searchedQueries.length >= 1);
  assert.ok(searchedQueries.every((query) => !String(query).includes("planner-bad")));
});

test("exact 与 representative 两级视觉匹配保留硬拒绝边界", () => {
  const base = { actualSubject: "安博塞利象群风景", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none" };
  assert.equal(failedHardRequirement(slot("exact", { moduleType: "day", location: "Amboseli", activity: "", subject: "象群与乞力马扎罗" }), { ...base, matchLevel: "exact" }), null);
  assert.equal(failedHardRequirement(slot("representative-cover", { moduleType: "cover", location: "Kenya", activity: "", subject: "大象与雪山" }), { ...base, actualSubject: "肯尼亚草原代表性风景", subjectMatch: false, eligible: false, hardRejectCode: "subject_mismatch", matchLevel: "representative" }), "wrong_subject");
  assert.equal(failedHardRequirement(slot("representative-wrong-activity", { moduleType: "day", location: "Amboseli", activity: "Walking Safari", subject: "Walking Safari" }), { ...base, actualSubject: "游猎车辆", activityMatch: false, subjectMatch: false, eligible: false, hardRejectCode: "activity_mismatch", matchLevel: "representative" }), "wrong_activity");
});

test("最低可用视觉决定资格，完整理想画面只影响匹配等级和排序", () => {
  const target = slot("generic-workshop", {
    moduleType: "day",
    location: "示例地区",
    locationRole: "scope_only",
    subject: "手工工作坊",
    primaryVisualSubject: "黄昏庭院里导师陪同客人完成手工工作",
    queryCore: { subject: "手工工作", action: "制作" },
    visualGoal: "黄昏庭院、导师陪同、成品陈列和温暖灯光构成理想完整画面",
  });
  const eligibleWithoutPreferences = completeAudit("usable", {
    actualSubject: "客人正在制作手工作品",
    matchLevel: "representative",
    subjectLargeEnough: false,
    subjectPrimary: false,
    score: 58,
  });
  assert.equal(failedHardRequirement(target, eligibleWithoutPreferences), null);
  assert.equal(failedHardRequirement(target, { ...eligibleWithoutPreferences, coreActionMatch: false, activityMatch: false }), "wrong_activity");
  assert.equal(failedHardRequirement(target, { ...eligibleWithoutPreferences, coreSubjectMatch: false, subjectMatch: false }), "wrong_subject");
});

test("普通目的地体验不会被同国其他酒店或小地区目录误卡", () => {
  const target = slot("ordinary-bush-breakfast", {
    moduleType: "day",
    location: "Masai Mara",
    hotel: "The Ritz-Carlton, Masai Mara Safari Camp",
    activity: "Bush Breakfast",
    subject: "Masai Mara Bush Breakfast",
    primaryVisualSubject: "Masai Mara Bush Breakfast",
    knowledgeSourcePathMode: "country_context",
    knowledgeImagePurpose: "destination_experience",
  });
  const audit = completeAudit("candidate-bush-breakfast", {
    actualSubject: "肯尼亚草原上的 Bush Breakfast 布置",
    matchLevel: "mismatch",
    locationMatch: false,
    visibleLocationConflict: false,
    hotelIdentityMatch: false,
    visibleIdentityConflict: false,
    eligible: false,
    hardRejectCode: "wrong_hotel",
    reason: "素材存放在 Cottars 酒店目录，不是当天入住酒店",
  });
  const effective = applyKnowledgeSourcePathEvidence(target, audit, { match: true, mode: "country_context", scopePath: "肯尼亚" });
  assert.equal(effective.locationMatch, false);
  assert.equal(effective.hotelIdentityMatch, false);
  assert.equal(effective.hardRejectCode, "wrong_hotel");
  assert.equal(effective.eligible, false);
  assert.equal(failedHardRequirement(target, effective), null);
});

test("普通体验仍硬拒绝明显错国家、错地标或可见错误酒店品牌", () => {
  const target = slot("ordinary-night-safari", {
    moduleType: "day",
    location: "Masai Mara",
    hotel: "Example Lodge",
    activity: "Night Safari",
    subject: "Night Safari",
    knowledgeSourcePathMode: "country_context",
    knowledgeImagePurpose: "destination_experience",
  });
  const wrongCountry = applyKnowledgeSourcePathEvidence(target, completeAudit("wrong-country", {
    actualSubject: "坦桑尼亚塞伦盖蒂夜间游猎",
    matchLevel: "mismatch",
    locationMatch: false,
    visibleLocationConflict: true,
    eligible: false,
    hardRejectCode: "wrong_location",
    reason: "错误国家，与肯尼亚目标冲突，必须拒绝",
  }), { match: true, mode: "country_context", scopePath: "肯尼亚" });
  assert.equal(failedHardRequirement(target, wrongCountry), "wrong_location");

  const wrongBrand = applyKnowledgeSourcePathEvidence(target, completeAudit("wrong-brand", {
    actualSubject: "带有另一家酒店 Logo 的夜间活动",
    matchLevel: "mismatch",
    hotelIdentityMatch: false,
    visibleIdentityConflict: true,
    eligible: false,
    hardRejectCode: "wrong_hotel",
    reason: "画面出现错误酒店 Logo，必须拒绝",
  }), { match: true, mode: "country_context", scopePath: "肯尼亚" });
  assert.equal(failedHardRequirement(target, wrongBrand), "wrong_hotel");
});

test("交通图片位确定性区分商务接送、游猎车和草原飞机", () => {
  assert.equal(classifyTransportType({ moduleType: "transport", subject: "机场商务车接送" }), "business_transfer_vehicle");
  assert.equal(classifyTransportType({ moduleType: "transport", subject: "开顶式Safari游猎车" }), "safari_vehicle");
  assert.equal(classifyTransportType({ moduleType: "transport", subject: "bush plane 草原飞机" }), "bush_plane");
  const base = { actualSubject: "开顶式游猎越野车", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportType: "safari_vehicle", transportTypeMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none" };
  assert.equal(failedHardRequirement(slot("transport-plane", { moduleType: "transport", location: "Kenya", activity: "", subject: "bush plane" }), base), "wrong_transport_type");
});

test("理想画面中的辅助交通工具不会被升级为交通 Core", () => {
  const target = slot("guide-with-auxiliary-vehicle", {
    moduleType: "day",
    subject: "向导讲解",
    primaryVisualSubject: "向导在越野车旁为客人讲解自然环境",
    queryCore: { subject: "向导", action: "讲解", identity: "" },
    visualGoal: "理想情况下画面同时出现向导、客人与越野车",
  });
  assert.equal(classifyTransportType(target), null);
  assert.equal(buildImageConstraints(target).transportType, null);
  assert.equal(failedHardRequirement(target, completeAudit("guide", {
    actualSubject: "向导正在为客人讲解",
    transportTypeMatch: false,
    hardRejectCode: "wrong_transport_type",
  })), null);
});

test("只有最低可用视觉或 transport 图片位明确要求交通类别时才硬拒绝类型错误", () => {
  const coreTransport = slot("vehicle-as-core", {
    moduleType: "day",
    subject: "接送体验",
    primaryVisualSubject: "客人抵达后由工作人员迎接并登上商务车",
    queryCore: { subject: "商务车", action: "接送", identity: "商务接送车辆" },
  });
  assert.equal(classifyTransportType(coreTransport), "business_transfer_vehicle");
  assert.equal(failedHardRequirement(coreTransport, completeAudit("wrong-vehicle", {
    actualSubject: "另一类别的交通工具",
    transportTypeMatch: false,
    hardRejectCode: "wrong_transport_type",
  })), "wrong_transport_type");

  const transportSlot = slot("transport-module", {
    moduleType: "transport",
    subject: "轻型飞机",
    primaryVisualSubject: "旅客与行李在停机坪旁准备登机",
    queryCore: {},
  });
  assert.equal(classifyTransportType(transportSlot), "bush_plane");
});

test("完整视觉判断必须显式返回全部 Core 与可见冲突字段", () => {
  const complete = completeAudit("complete-judgment");
  assert.equal(completeVisualJudgment(complete), true);
  for (const field of ["coreSubjectMatch", "coreActionMatch", "identityMatch", "visibleLocationConflict", "visibleIdentityConflict"]) {
    const incomplete = { ...complete };
    delete incomplete[field];
    assert.equal(completeVisualJudgment(incomplete), false, `缺少 ${field} 时不得默认通过`);
  }
});

test("主体无法识别才硬拒绝，主体较小或不是第一视觉中心只影响排序", () => {
  const base = { actualSubject: "远处背景里很小的一架飞机", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, subjectClear: true, subjectLargeEnough: true, subjectPrimary: true, transportType: "bush_plane", transportTypeMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none" };
  const target = slot("tiny-plane", { moduleType: "transport", location: "Kenya", activity: "", subject: "bush plane" });
  assert.equal(failedHardRequirement(target, { ...base, subjectClear: false }), "subject_not_clear");
  assert.equal(failedHardRequirement(target, { ...base, subjectLargeEnough: false }), null);
  assert.equal(failedHardRequirement(target, { ...base, subjectPrimary: false }), null);
});

test("当前Query候选全部不合格后才执行下一Query，并在找到exact后早停", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-after-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let auditBatch = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeScopeNodeIds: ["amboseli"], knowledgeBaseUrl: "http://192.168.100.210:8020", trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("query-after-reject", { moduleType: "day", location: "Amboseli", activity: "Walking Safari", subject: "Walking Safari", primaryVisualSubject: "Walking Safari", searchIntent: ["步行游猎", "丛林徒步", "walking safari", "guided bush walk"] })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => { const query = queries[0]; calls.push(query); const id = calls.length; const records = Array.from({ length: 4 }, (_, index) => ({ recordId: `rec-${id}-${index + 1}`, filename: `image-${id}-${index + 1}.jpg`, fragmentContent: query, sourcePaths: [], ranking: index + 1 })); return { status: "completed", queryId: `qry-${id}`, queryText: query, records, candidates: records.map((record) => ({ imageUrl: `http://192.168.100.210:9000/${record.filename}`, pageUrl: `http://192.168.100.210:8020/q/${id}`, title: record.filename, sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: `qry-${id}`, knowledgeSourcePaths: [] })) }; },
      downloadCandidate: async (item, { directory, publicPrefix }) => { const filePath = path.join(directory, `${item.knowledgeRecordId}.jpg`); await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#887766" } }).jpeg().toFile(filePath); return { ...item, filePath, publicUrl: `${publicPrefix}/${item.knowledgeRecordId}.jpg`, sha256: item.knowledgeRecordId, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => { auditBatch += 1; return candidates.map((item) => { const rejected = auditBatch === 1; return completeAudit(item, { actualSubject: rejected ? "游猎车辆" : "向导带领的徒步游猎", activityMatch: !rejected, subjectMatch: !rejected, eligible: !rejected, matchLevel: rejected ? "mismatch" : "exact", hardRejectCode: rejected ? "activity_mismatch" : "none", reason: "测试判断" }); }); },
      searchWebBatch: async () => { throw new Error("不得调用公网"); }, searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.deepEqual(calls, ["步行游猎", "丛林徒步"]);
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].candidates.length, 8);
  const rejected = result.results[0].candidates.filter((candidate) => candidate.autoReviewStatus === "hard_reject");
  assert.ok(rejected.length > 0);
  assert.ok(rejected.every((candidate) => candidate.hardJudgment.matchLevel === "mismatch" && candidate.hardJudgment.eligible === false));
  assert.equal(result.metrics.previewAudited, 8);
  assert.equal(result.results[0].candidates.filter((candidate) => candidate.candidateStatus === "not_auto_reviewed").length, 0);
});

test("普通图片位同一Scope仅在no_match时继续且默认最多执行两个有效Query", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-two-query-scope-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["amboseli"],
    knowledgeQueriesPerSlot: 4,
    slots: [slot("two-query-cap", {
      location: "Amboseli",
      subject: "湿地象群",
      activity: "湿地象群",
      primaryVisualSubject: "湿地象群",
      fidelityQuery: "湿地象群",
      alternateQueries: ["象群湿地", "wetland elephants", "elephants in wetlands"],
      queryCore: { subject: "象群", action: "湿地活动", subjectEn: "elephants", actionEn: "in wetlands" },
    })],
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        calls.push(queries[0]);
        return { status: "completed", queryId: `no-match-${calls.length}`, queryText: queries[0], scopeState: "no_match", message: "未找到匹配内容", records: [], candidates: [] };
      },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.deepEqual(calls, ["湿地象群", "象群湿地"]);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.attempts.length, 2);
  assert.equal(result.results[0].status, "not_found");
});

test("审核波次为两张时会继续处理当前候选池直到全部不合格", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-audit-all-downloaded-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audited = [];
  const records = Array.from({ length: 5 }, (_, index) => ({ recordId: `audit-${index + 1}`, filename: `${index + 1}.jpg`, fragmentContent: "Amboseli", sourcePaths: [], ranking: index + 1 }));
  const candidates = records.map((record, index) => ({ imageUrl: `http://192.168.100.210:9000/audit-${index + 1}.jpg`, pageUrl: `http://192.168.100.210:8020/q/audit`, title: record.filename, sourceKind: "knowledge_library", knowledgeRecordId: record.recordId, knowledgeQueryId: "qry-audit", knowledgeSourcePaths: [] }));
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeScopeNodeIds: ["amboseli"], knowledgeQueriesPerSlot: 1, knowledgeBaseUrl: "http://192.168.100.210:8020", trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 5, visionCandidatesPerSlot: 2,
    slots: [slot("audit-all", { location: "Amboseli", activity: "", subject: "Amboseli scenery", primaryVisualSubject: "Amboseli scenery" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-audit", queryText: queries[0], records, candidates }),
      downloadCandidate: async (item, { directory, publicPrefix }) => { const filePath = path.join(directory, `${item.knowledgeRecordId}.jpg`); await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#778899" } }).jpeg().toFile(filePath); return { ...item, filePath, publicUrl: `${publicPrefix}/${item.knowledgeRecordId}.jpg`, sha256: item.knowledgeRecordId, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates: batch }) => { audited.push(...batch.map((item) => item.knowledgeRecordId)); return batch.map((item) => completeAudit(item, { actualSubject: "不匹配的普通风景", subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch", score: 50, reason: "主体不匹配" })); },
      searchWebBatch: async () => { throw new Error("不得调用公网"); }, searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "not_found");
  assert.deepEqual(new Set(audited), new Set(["audit-1", "audit-2", "audit-3", "audit-4", "audit-5"]));
  assert.equal(result.results[0].candidates.length, records.length);
  assert.ok(result.results[0].candidates.every((candidate) => !candidate.localUrl && candidate.localPreviewUrl && candidate.manualOnly === true));
  assert.equal(result.results[0].candidates.filter((candidate) => candidate.autoReviewStatus === "hard_reject").length, 5);
  assert.equal(result.results[0].candidates.filter((candidate) => candidate.candidateStatus === "not_auto_reviewed").length, 0);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates.filter((record) => record.judgmentStatus === "rejected").length, 5);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates.filter((record) => record.judgmentStatus === "not_auto_reviewed").length, 0);
});

test("首个Query已有合格候选时不再执行后续可能失败的Query", async (t) => {
  for (const laterStatus of ["failed", "needs_clarification"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `knowledge-preserve-before-${laterStatus}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const found = knowledgeFixture("步行游猎", { count: 1, prefix: `preserved-${laterStatus}`, fragment: "向导带队步行游猎" });
    const result = await runImageSearchSkill({
      root, sourceMode: "knowledge_only", knowledgeScopeNodeIds: ["kenya"], knowledgeQueriesPerSlot: 2,
      knowledgeBaseUrl: "http://192.168.100.210:8020", trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
      slots: [slot(`preserve-${laterStatus}`, { location: "肯尼亚", subject: "步行Safari", activity: "步行Safari", primaryVisualSubject: "步行Safari", searchIntent: ["步行游猎", "丛林徒步"] })],
      visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
      adapters: {
        searchKnowledgeImages: async () => {
          calls += 1;
          return calls === 1 ? found : { status: laterStatus, queryId: `later-${laterStatus}`, queryText: "丛林徒步", records: [], candidates: [], clarificationNodeIds: [] };
        },
        downloadCandidate: async (candidate, { directory, publicPrefix }) => {
          const filePath = path.join(directory, `${candidate.knowledgeRecordId}-${candidate.imageUrl.includes('/original/') ? 'original' : 'preview'}.jpg`);
          await writeDistinctTestImage(filePath, candidate.imageUrl.includes('/original/') ? 2 : 1);
          return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: path.basename(filePath), width: 1400, height: 900 };
        },
        judgeCandidatesBatch: async ({ candidates }) => candidates.map(candidate => completeAudit(candidate, { actualSubject: "向导带领游客在草原徒步行走", reason: "步行游猎动作清晰" })),
        searchWebBatch: async () => { throw new Error("不得调用公网"); },
        searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
      },
    });
    assert.equal(calls, 1, laterStatus);
    assert.equal(result.results[0].status, "success", laterStatus);
    assert.equal(result.results[0].candidates.length, 1, laterStatus);
    assert.equal(result.results[0].selected.knowledgeQueries[0], "步行游猎", laterStatus);
  }
});

test("preview不可用时仅救援一张文件名或路径高度匹配的原图", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-one-original-rescue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloads = 0;
  const records = Array.from({ length: 3 }, (_, index) => ({
    recordId: `rescue-${index + 1}`,
    assetId: `rescue-asset-${index + 1}`,
    filename: `walking-safari-${index + 1}.jpg`,
    fragmentContent: "步行游猎",
    sourcePaths: [`肯尼亚/Walking Safari/walking-safari-${index + 1}.jpg`],
    preview: null,
    matchedFile: { relation: "matched_file", url: `http://192.168.100.210:9000/original/walking-safari-${index + 1}.jpg`, filename: `walking-safari-${index + 1}.jpg`, versionId: `rescue-asset-${index + 1}` },
  }));
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeScopeNodeIds: ["kenya"], knowledgeQueriesPerSlot: 1, downloadsPerSlot: 6,
    knowledgeBaseUrl: "http://192.168.100.210:8020", trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("one-rescue", { location: "肯尼亚", subject: "步行Safari", activity: "步行Safari", primaryVisualSubject: "步行Safari" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => ({ status: "completed", queryId: "qry-rescue", queryText: queries[0], records, candidates: records.map(record => ({ imageUrl: record.matchedFile.url, title: record.filename, sourceKind: "knowledge_library", knowledgeAssetId: record.assetId, knowledgeRecordId: record.recordId, knowledgeSourcePaths: record.sourcePaths, knowledgePreview: null, knowledgeMatchedFile: record.matchedFile })) }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloads += 1;
        const filePath = path.join(directory, `rescued-${downloads}.jpg`);
        await writeDistinctTestImage(filePath, downloads);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/rescued-${downloads}.jpg`, sha256: `rescued-${downloads}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map(candidate => completeAudit(candidate, { actualSubject: "持枪向导带领客人徒步行走", reason: "步行Safari动作清晰" })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(downloads, 1);
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.originalDownloadBudget.used, 1);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.candidates.filter(record => record.previewStatus === "rescued_original").length, 1);
});

test("最细Scope无结果时逐级退到父级和国家搜索，不查询知识库根目录", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-progressive-scope-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "country", formal_name: "示例国", parent_node_id: "root" },
    { node_id: "region", formal_name: "北境湖区", parent_node_id: "country" },
  ]);
  const calls = [];
  const found = knowledgeFixture("夜间追踪发光甲虫", { count: 1, prefix: "generic-fallback", fragment: "悬索桥下夜间追踪发光甲虫", sourcePaths: ["示例国/北境湖区/发光甲虫.jpg"] });
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    knowledgeQueriesPerSlot: 2,
    slots: [slot("progressive-scope", {
      location: "云影峡谷",
      country: "示例国",
      primaryVisualSubject: "云影峡谷夜间追踪发光甲虫",
      subject: "云影峡谷夜间追踪发光甲虫",
      activity: "云影峡谷夜间追踪发光甲虫",
      locationRole: "scope_only",
      queryCore: { subject: "发光甲虫", action: "夜间追踪", subjectEn: "glowworm", actionEn: "night tracking" },
      fidelityQuery: "发光甲虫夜间追踪",
      alternateQueries: ["glowworm night tracking"],
      visualContext: { scopeFallbackLocations: ["北境湖区"] },
    })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async ({ queries, scopeNodeIds }) => {
        calls.push({ query: queries[0], scopeNodeIds: [...scopeNodeIds] });
        return scopeNodeIds.includes("country") ? { ...found, queryText: queries[0] } : { status: "completed", queryId: `empty-${queries[0]}`, queryText: queries[0], scopeState: "empty", message: "内容为空", records: [], candidates: [] };
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const original = candidate.imageUrl.includes("/original/");
        const filePath = path.join(directory, original ? "generic-original.jpg" : "generic-preview.jpg");
        await writeDistinctTestImage(filePath, original ? 2 : 1);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: path.basename(filePath), width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "悬索桥下夜间追踪发光甲虫", reason: "主体和追踪动作清晰" })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(calls.map((item) => item.scopeNodeIds[0]), ["region", "country"]);
  assert.deepEqual(calls.map((item) => item.query), ["发光甲虫夜间追踪", "发光甲虫夜间追踪"]);
  assert.ok(calls.every((item) => !item.scopeNodeIds.includes("root")));
  assert.deepEqual(result.results[0].pipelineEvidence.knowledgeSearch.scopePlan.scopes.map((item) => item.nodeIds[0]), ["region", "country"]);
});

test("具体酒店目录未解析时不查询地区国家知识库", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-unresolved-hotel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
  ]);
  let knowledgeCalls = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020",
    slots: [slot("unresolved-hotel", { moduleType: "hotel", location: "肯尼亚", hotel: "Mystery Sopa Lodge", subject: "酒店外观", activity: "", locationRole: "scope_only", queryCore: { subject: "酒店外观", subjectEn: "hotel exterior" }, fidelityQuery: "酒店外观", alternateQueries: ["hotel exterior"] })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async () => { knowledgeCalls += 1; return { status: "completed", records: [], candidates: [] }; },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(knowledgeCalls, 0);
  assert.equal(result.results[0].technicalStatus, "knowledge_hotel_scope_unresolved");
  assert.equal(result.results[0].status, "needs_user_action");
});

test("Scope Resolver 已确认同名目录歧义时不执行无 scope 全库查询", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-knowledge-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "tanzania", formal_name: "坦桑尼亚", parent_node_id: "root" },
    { node_id: "singita-kenya", formal_name: "Singita", parent_node_id: "kenya" },
    { node_id: "singita-tanzania", formal_name: "Singita", parent_node_id: "tanzania" },
  ]);
  let knowledgeCalls = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    slots: [slot("ambiguous-singita", { moduleType: "hotel", hotel: "Singita", location: "", subject: "Singita", activity: "", visualGoal: "酒店代表图" })],
    adapters: {
      loadKnowledgeHierarchy: async () => hierarchy,
      searchKnowledgeImages: async () => { knowledgeCalls += 1; return { status: "completed", records: [], candidates: [] }; },
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(knowledgeCalls, 0);
  assert.equal(result.metrics.knowledgeCalls, 0);
  assert.equal(result.results[0].status, "needs_user_action");
  assert.equal(result.results[0].technicalStatus, "knowledge_needs_clarification");
  assert.deepEqual(new Set(result.results[0].pipelineEvidence.knowledgeSearch.clarificationNodeIds), new Set(["singita-kenya", "singita-tanzania"]));
});

test("knowledge_only 对无结果、需澄清、失败和超时直接返回，不进入公网或 controlled fallback", async (t) => {
  const cases = [
    ["empty", { status: "completed", candidates: [], records: [], queryId: "qry-empty", durationMs: 10 }, "not_found", "knowledge_not_found"],
    ["clarify", { status: "needs_clarification", candidates: [], records: [], queryId: "qry-clarify", durationMs: 12, clarificationNodeIds: ["node-a"] }, "needs_user_action", "knowledge_needs_clarification"],
    ["failed", { status: "failed", candidates: [], records: [], queryId: "qry-failed", durationMs: 14, errorId: "err-1" }, "failed", "knowledge_failed"],
  ];
  for (const [name, knowledgeResult, expectedStatus, expectedTechnical] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `knowledge-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await runImageSearchSkill({ root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", slots: [slot(name)], adapters: { searchKnowledgeImages: async ({ queries }) => ({ queryText: queries[0], scope: null, clarificationNodeIds: [], ...knowledgeResult }), searchWebBatch: async () => { throw new Error("不得调用公网"); }, searchCommonsImages: async () => { throw new Error("不得调用 Commons"); } } });
    assert.equal(result.results[0].status, expectedStatus, name);
    assert.equal(result.results[0].technicalStatus, expectedTechnical, name);
    assert.equal(result.metrics.searchCalls, 0, name);
    assert.equal(result.metrics.commonsCalls, 0, name);
    assert.equal(result.results[0].pipelineEvidence.controlledFallback.entered, false, name);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeout = Object.assign(new Error("知识库查询超时"), { code: "knowledge_timeout", queryId: "qry-timeout", durationMs: 99 });
  const result = await runImageSearchSkill({ root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", slots: [slot("timeout")], adapters: { searchKnowledgeImages: async () => { throw timeout; }, searchWebBatch: async () => { throw new Error("不得调用公网"); }, searchCommonsImages: async () => { throw new Error("不得调用 Commons"); } } });
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].technicalStatus, "knowledge_timeout");
  assert.equal(result.metrics.knowledgeTimeouts, 1);
  assert.equal(result.metrics.knowledgeOnlyVerified, true);
});

test("knowledge_first 仅在知识库产生最终合格图时停止，否则进入现有公网链路", async (t) => {
  const cases = [
    ["success", "completed", true, true, 0],
    ["not-found", "completed", false, false, 4],
    ["clarification", "needs_clarification", false, false, 4],
    ["failed", "failed", false, false, 4],
    ["timeout", "timeout", false, false, 4],
    ["all-rejected", "completed", true, false, 4],
  ];
  for (const [name, status, hasKnowledgeCandidate, approved, expectedWebCalls] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `knowledge-first-${name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    let webCalls = 0;
    const candidate = { imageUrl: "http://192.168.100.210:9000/signed/hotel.jpg", pageUrl: "http://192.168.100.210:8020/api/knowledge/output?query_id=qry-first", title: "hotel.jpg", alt: "测试酒店外观", sourceKind: "knowledge_library", knowledgeRecordId: "knowledge-first-1", knowledgeQueryId: "qry-first" };
    await runImageSearchSkill({
      root, sourceMode: "knowledge_first", knowledgeBaseUrl: "http://192.168.100.210:8020",
      visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
      slots: [slot("hotel-first", { moduleType: "hotel", hotel: "测试酒店", activity: "", subject: "酒店外观" })],
      adapters: {
        searchKnowledgeImages: async ({ queries }) => {
          if (status === "timeout") throw Object.assign(new Error("知识库查询超时"), { code: "knowledge_timeout", queryId: "qry-timeout" });
          return { status, queryId: "qry-first", queryText: queries[0], scope: null, durationMs: 8, clarificationNodeIds: status === "needs_clarification" ? ["node-a", "node-b"] : [], records: hasKnowledgeCandidate ? [{ recordId: "knowledge-first-1", filename: "hotel.jpg", mimeType: "image/jpeg", fragmentContent: "测试酒店外观", sourcePaths: ["测试酒店"] }] : [], candidates: hasKnowledgeCandidate ? [candidate] : [] };
        },
        searchWebBatch: async () => { webCalls += 1; return []; },
        downloadCandidate: async (item, { directory, publicPrefix }) => {
          const filePath = path.join(directory, "hotel.jpg");
          await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#665544" } }).jpeg().toFile(filePath);
          return { ...item, filePath, publicUrl: `${publicPrefix}/hotel.jpg`, sha256: "hotel-hash", width: 1400, height: 900 };
        },
        judgeCandidatesBatch: async ({ candidates }) => candidates.map((item) => completeAudit(item, { actualSubject: "测试酒店外观", locationMatch: approved, hotelIdentityMatch: approved, subjectMatch: approved, eligible: approved, matchLevel: approved ? "exact" : "mismatch", hardRejectCode: approved ? "none" : "hotel_identity_mismatch", score: approved ? 95 : 10, reason: approved ? "知识库候选合格" : "酒店身份不符" })),
      },
    });
    assert.equal(webCalls, expectedWebCalls, name);
  }
});

async function runAuditedFixture(t, slotInput, { candidateCount = 1, judgments }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hard-match-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return runImageSearchSkill({
    root,
    slots: [slotInput],
    searchApiKey: "search-key",
    searchModel: "search-model",
    visionApiKey: "vision-key",
    visionBaseUrl: "https://vision.example/v1",
    visionModel: "vision-model",
    sourcePagesPerSlot: 1,
    downloadsPerSlot: candidateCount,
    visionCandidatesPerSlot: candidateCount,
    adapters: {
      searchWebBatch: async () => [{ title: "受控候选页", pageUrl: "https://example.com/page", officialHint: true }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => Array.from({ length: candidateCount }, (_, index) => ({ ...page, fixtureIndex: index, imageUrl: `${page.pageUrl}/candidate-${index + 1}.jpg` })),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const number = candidate.fixtureIndex + 1;
        const filePath = path.join(directory, `candidate-${number}.jpg`);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * number, g: 90, b: 120 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/candidate-${number}.jpg`, sha256: `controlled-hash-${number}`, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => judgments(candidates).map((item) => completeAudit(item.candidateId, item)),
    },
  });
}

async function runLayeredFixture(t, {
  slotInput = slot("layered", { location: "Singita Grumeti Serengeti Tanzania", activity: "anti-poaching observation post visit", subject: "anti-poaching observation post" }),
  exactCandidates = [{ name: "exact-pool", actualSubject: "酒店泳池", semanticScore: 25 }],
  fallbackCandidates = [{ name: "fallback-ranger", actualSubject: "Grumeti ranger patrol team carrying field equipment", semanticScore: 30 }],
  exactEligible = false,
  fallbackAudit = {},
  events = [],
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-layered-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  return runImageSearchSkill({
    root, slots: [slotInput], searchApiKey: "search", searchModel: "search-model",
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "vision-model",
    sourcePagesPerSlot: 1, downloadsPerSlot: 4, visionCandidatesPerSlot: 4,
    adapters: {
      searchWebBatch: async ({ queries }) => {
        const fallback = queries.some((query) => /ranger led|ranger patrol|game scout|Maasai cultural|Maasai people|night reserve|balloon flight/i.test(query));
        events.push(fallback ? "fallback_search" : "exact_search");
        return [{ title: fallback ? "Fallback activity page" : "Exact activity page", pageUrl: `https://example.com/${fallback ? "fallback" : "exact"}` }];
      },
      searchCommonsImages: async () => [],
      extractPageImages: async (page, options) => {
        const fallback = page.pageUrl.endsWith("/fallback");
        events.push(fallback ? "fallback_semantic_extract" : "exact_semantic_extract");
        if (!fallback) assert.match(options.semanticTerms.join(" "), /anti-poaching observation post/i);
        return (fallback ? fallbackCandidates : exactCandidates).map((candidate) => ({ ...page, imageUrl: `${page.pageUrl}/${candidate.name}.jpg`, alt: candidate.actualSubject, semanticScore: candidate.semanticScore || 0 }));
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadIndex += 1;
        const filePath = path.join(directory, `layer-${downloadIndex}.jpg`);
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: { r: 30 * downloadIndex, g: 80, b: 110 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/layer-${downloadIndex}.jpg`, sha256: `layer-hash-${downloadIndex}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ slot: judgedSlot, candidates }) => {
        const fallback = /ranger patrol|conservation work|Maasai cultural|wilderness walking|hot air balloon/i.test(judgedSlot.activity || "");
        events.push(fallback ? "fallback_visual" : "exact_visual");
        return candidates.map((candidate) => completeAudit(candidate, {
          actualSubject: candidate.alt,
          locationMatch: fallback ? fallbackAudit.locationMatch ?? true : true,
          hotelIdentityMatch: true,
          activityMatch: fallback ? fallbackAudit.activityMatch ?? true : exactEligible,
          coreActionMatch: fallback ? fallbackAudit.coreActionMatch ?? fallbackAudit.activityMatch ?? true : exactEligible,
          subjectMatch: fallback ? fallbackAudit.subjectMatch ?? true : exactEligible,
          coreSubjectMatch: fallback ? fallbackAudit.coreSubjectMatch ?? fallbackAudit.subjectMatch ?? true : exactEligible,
          watermarkFree: true,
          nonAI: fallbackAudit.nonAI ?? true,
          photographic: fallbackAudit.photographic ?? true,
          technicalUsable: true,
          eligible: fallback ? fallbackAudit.eligible ?? true : exactEligible,
          hardRejectCode: "none",
          score: 92,
          reason: candidate.alt,
        }));
      },
    },
  });
}

test("多 slot 单批次并发处理，多 query 且单 slot 失败不影响其他 slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-skill-"));
  const files = new Map();
  let searchActive = 0;
  let searchPeak = 0;
  let colorIndex = 0;
  const events = [];
  try {
    const adapters = {
      searchWebBatch: async ({ queries }) => {
        searchActive += 1; searchPeak = Math.max(searchPeak, searchActive);
        await new Promise((resolve) => setTimeout(resolve, 8));
        searchActive -= 1;
        if (queries.some((query) => query.includes("失败目标"))) throw new Error("provider unavailable");
        if (queries.some((query) => query.includes("空目标"))) return [];
        return [{ title: queries.join(" | "), pageUrl: `https://example.com/${encodeURIComponent(queries[0])}`, officialHint: false }];
      },
      searchCommonsImages: async (query) => { if (query.includes("失败目标")) throw new Error("commons unavailable"); return []; },
      extractPageImages: async (page) => [{ ...page, imageUrl: `${page.pageUrl}/image.jpg`, alt: page.title }],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        colorIndex += 1;
        const filePath = path.join(directory, `${colorIndex}.jpg`);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30 * colorIndex, g: 80, b: 120 } } }).jpeg().toFile(filePath);
        files.set(candidate.imageUrl, filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${colorIndex}.jpg`, sha256: `hash-${colorIndex}`, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => completeAudit(candidate, { score: 90 - index, actualSubject: candidate.alt, reason: "地点、活动和主体匹配" })),
    };
    const result = await runImageSearchSkill({
      root,
      slots: [slot("day-1"), slot("day-empty", { activity: "空目标", subject: "空目标", searchIntent: ["空目标", "空目标场景"], visualGoal: "空目标" }), slot("day-failed", { activity: "失败目标", subject: "失败目标", searchIntent: ["失败目标", "失败目标场景"], visualGoal: "失败目标" })],
      searchApiKey: "search-key", searchBaseUrl: "https://search.example/v1", searchModel: "search-model",
      visionApiKey: "vision-key", visionBaseUrl: "https://vision.example/v1", visionModel: "vision-model",
      concurrency: { slots: 3, search: 3, pages: 3, downloads: 3, vision: 2 }, adapters,
      onCapabilityCall: (event) => events.push(event),
    });
    assert.equal(result.metrics.businessBatches, 1);
    assert.ok(result.results[0].queriesUsed.length >= 2);
    assert.equal(result.results[0].status, "success");
    assert.ok(result.results[0].selected.candidateId.startsWith("candidate-"));
    assert.equal(result.results[0].selected.candidateId, result.results[0].candidates.find((item) => item.selected).candidateId);
    assert.equal(result.results[1].status, "not_found");
    assert.equal(result.results[2].status, "failed");
    assert.ok(searchPeak > 1);
    assert.ok(result.metrics.concurrencyPeak.slots > 1);
    assert.equal(result.metrics.searchCalls, 5);
    assert.equal(result.metrics.technicalRetries.search, 1);
    assert.equal(result.metrics.batchVisionCalls, 1);
    assert.equal(result.metrics.topConfirmationCalls, 0);
    assert.equal(result.metrics.automaticFollowupRounds, 0);
    assert.equal(result.results[0].constraints.minimumVisualProof.scopeLocation, "塞伦盖蒂");
    assert.ok(result.results[0].constraints.forbid.some((item) => item.includes("AI生成图")));
    assert.deepEqual([...new Set(events.filter((event) => event.phase !== "slot_progress").map((event) => event.capabilityId))].sort(), ["image_search", "visual_judgment"]);
    assert.deepEqual(events.filter((event) => event.phase === "slot_progress").map((event) => event.completedSlots), [0, 1, 2, 3]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Planner 提供 mustHave 时拒绝旧接口", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-contract-"));
  try {
    const result = await runImageSearchSkill({ root, slots: [{ ...slot("old-slot"), mustHave: ["旧字段"] }] });
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].warnings.join(" "), /不得提供 mustHave/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("没有真实视觉判断时不得默认通过", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-no-vision-"));
  try {
    let index = 0;
    const result = await runImageSearchSkill({
      root, slots: [slot("no-vision")], searchApiKey: "search-key", searchModel: "search-model",
      adapters: {
        searchWebBatch: async ({ queries }) => [{ title: queries.join(" "), pageUrl: "https://example.com/page" }],
        searchCommonsImages: async () => [],
        extractPageImages: async (page) => [{ ...page, imageUrl: "https://example.com/image.jpg" }],
        downloadCandidate: async (candidate, { directory, publicPrefix }) => {
          index += 1; const filePath = path.join(directory, `${index}.jpg`);
          await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#335577" } }).jpeg().toFile(filePath);
          return { ...candidate, filePath, publicUrl: `${publicPrefix}/${index}.jpg`, sha256: `no-vision-${index}`, width: 1200, height: 800 };
        },
      },
    });
    assert.equal(result.results[0].status, "needs_user_action");
    assert.equal(result.results[0].technicalStatus, "visual_judgment_unavailable");
    assert.equal(result.results[0].selected, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("约束由 Image Skill 内部基于 slot 事实构建", () => {
  const hotelConstraints = buildImageConstraints(slot("constraints-hotel", { moduleType: "hotel", hotel: "Example Lodge", subject: "Example Lodge 酒店外观" }));
  const experienceConstraints = buildImageConstraints(slot("constraints-experience", { moduleType: "day", hotel: "Example Lodge", subject: "步行体验", activity: "步行体验", queryCore: { subject: "户外步行", action: "行走" } }));
  assert.ok(hotelConstraints.mustHave.includes("必要身份：Example Lodge"));
  assert.ok(!experienceConstraints.mustHave.includes("必要身份：Example Lodge"));
  const constraints = experienceConstraints;
  assert.equal(constraints.minimumVisualProof.subject, "户外步行");
  assert.equal(constraints.minimumVisualProof.action, "行走");
  assert.ok(constraints.prefer.some((item) => item.includes("理想完整画面")));
  assert.ok(constraints.forbid.includes("明显水印"));
});

test("连续相似 DAY 的搜索 query 只保留Planner主体词，差异上下文留给筛选", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-similar-days-"));
  const slots = [
    slot("day-1", { location: "安博塞利", searchIntent: ["开阔草原游猎", "远山草原"], visualGoal: "以开阔草原和远山建立首日环境", visualContext: { dayRole: "环境建立", keyExperiences: ["安博塞利保护区", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
    slot("day-2", { location: "塞伦盖蒂中部", searchIntent: ["草原深度游猎", "草原纵深"], visualGoal: "表现深入草原后的行动感与空间纵深", visualContext: { dayRole: "深入观察", keyExperiences: ["塞伦盖蒂中部", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
    slot("day-3", { location: "恩戈罗恩戈罗", searchIntent: ["火山口游猎", "火山口地貌"], visualGoal: "表现火山口地貌中的游猎环境", visualContext: { dayRole: "地貌转换", keyExperiences: ["恩戈罗恩戈罗火山口", "全天游猎"], avoid: ["相邻 DAY 同义画面"] } }),
  ];
  const captured = [];
  try {
    const result = await runImageSearchSkill({
      root,
      slots,
      searchApiKey: "search-key",
      searchModel: "search-model",
      adapters: {
        searchWebBatch: async ({ queries }) => { captured.push(queries); return []; },
        searchCommonsImages: async () => [],
      },
    });
    assert.equal(result.metrics.searchCalls, 6);
    assert.equal(captured.length, 6);
    const querySets = captured;
    assert.equal(new Set(querySets.map((queries) => queries.join("\n"))).size, 6);
    assert.doesNotMatch(querySets.flat().join(" "), /环境建立|深入观察|地貌转换|相邻 DAY/);
    assert.ok(querySets.flat().every((query) => query.length <= 120));
    assert.doesNotMatch(querySets.flat().join(" "), /狮子|大象|日出|黄昏|热气球/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("酒店 slot 不搜索 Commons，普通 slot 每批最多一次", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-sources-"));
  let commonsCalls = 0;
  try {
    const result = await runImageSearchSkill({
      root,
      slots: [slot("hotel", { moduleType: "hotel", hotel: "Example Lodge", subject: "酒店公共空间" }), slot("day")],
      searchApiKey: "search-key", searchModel: "search-model",
      adapters: {
        searchWebBatch: async () => [],
        searchCommonsImages: async () => { commonsCalls += 1; return []; },
      },
    });
    assert.equal(commonsCalls, 1);
    assert.equal(result.metrics.commonsCalls, 1);
    assert.equal(result.metrics.searchCalls, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("官方 Gallery 命中后补取酒店落地页，并优先下载可确认酒店身份的主体图", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hotel-gallery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractedPages = [];
  const downloadedUrls = [];
  let index = 0;
  const result = await runImageSearchSkill({
    root,
    slots: [slot("image:hotel:sabora:primary", { moduleType:"hotel", location:"Grumeti Reserve Tanzania", hotel:"Singita Sabora Tented Camp", activity:"", subject:"可确认 Singita Sabora Tented Camp 身份的帐篷营地、客房或公共空间" })],
    searchApiKey:"search-key", searchModel:"search-model", visionApiKey:"vision-key", visionBaseUrl:"https://vision.example/v1", visionModel:"vision-model",
    sourcePagesPerSlot:2, downloadsPerSlot:2, visionCandidatesPerSlot:2,
    adapters: {
      searchWebBatch: async () => [{ title:"Singita Sabora Gallery", pageUrl:"https://singita.com/lodge/singita-sabora-tented-camp/gallery", officialHint:true, searchRank:1 }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => {
        extractedPages.push(page.pageUrl);
        if (/gallery\/?$/.test(page.pageUrl)) return [{ ...page, imageUrl:"https://images.ctfassets.net/demo/moon-with-lilies.jpg?w=2400", alt:"Moon with lilies", semanticText:"moon with lilies atmosphere" }];
        return [
          { ...page, imageUrl:"https://images.ctfassets.net/demo/moon-with-lilies.jpg?w=2400", alt:"Moon with lilies", semanticText:"moon with lilies atmosphere" },
          { ...page, imageUrl:"https://images.ctfassets.net/demo/sabora-tented-suite-exterior.jpg?w=2400", alt:"Singita Sabora tented suite exterior", semanticText:"Singita Sabora Tented Camp guest tent exterior" },
          { ...page, imageUrl:"https://images.ctfassets.net/demo/sabora-lounge.jpg?w=2400", alt:"Singita Sabora lounge", semanticText:"Singita Sabora Tented Camp public lounge interior" },
        ];
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadedUrls.push(candidate.imageUrl);
        index += 1;
        const filePath = path.join(directory, `hotel-${index}.jpg`);
        await sharp({ create:{ width:1600, height:1000, channels:3, background:{ r:60 * index, g:90, b:110 } } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl:`${publicPrefix}/hotel-${index}.jpg`, sha256:`hotel-${index}`, width:1600, height:1000 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: candidate.alt, score: 95, reason: "官方酒店主体空间" })),
    },
  });
  assert.deepEqual(extractedPages, ["https://singita.com/lodge/singita-sabora-tented-camp/gallery", "https://singita.com/lodge/singita-sabora-tented-camp/"]);
  assert.equal(result.results[0].pipelineEvidence.officialSourcePages, 2);
  assert.ok(result.results[0].pipelineEvidence.officialExtractedCandidates >= 4);
  assert.equal(downloadedUrls.length, 2);
  assert.ok(downloadedUrls.every((url) => /suite|lounge/.test(url)));
  assert.equal(result.results[0].status, "success");
  assert.match(result.results[0].selected.imageUrl, /suite|lounge/);
});

test("DAY2酒店室内与DAY6帐篷室内均不能通过游猎视觉职责", async (t) => {
  for (const [id, actualSubject] of [["day-2", "Faru Faru 酒店室内休息区"], ["day-6", "Sabora 帐篷内部客厅"]]) {
    const subject = id === "day-6" ? "野生动物保护工作" : "野生动物观察";
    const result = await runAuditedFixture(t, slot(id, { activity: subject, subject, queryCore: { subject, action: "现场观察" } }), {
      judgments: (candidates) => candidates.map((candidate) => completeAudit(candidate, { actualSubject, activityMatch: false, coreActionMatch: false, subjectMatch: false, coreSubjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "wrong_activity", score: 88, reason: "地点可能相关，但实际主体是住宿室内，不承担目标活动职责" })),
    });
    assert.equal(result.results[0].status, "not_found");
    assert.equal(result.results[0].selected, null);
    assert.equal(result.results[0].candidates[0].rejection, "wrong_activity");
    assert.equal(result.results[0].candidates[0].hardJudgment.activityMatch, false);
  }
});

test("封面按candidateId绑定同一视觉记录与本地文件，不受判断返回顺序影响", async (t) => {
  const result = await runAuditedFixture(t, slot("cover", { moduleType: "cover", location: "坦桑尼亚", activity: "", subject: "塞伦盖蒂草原雄狮", visualGoal: "以草原雄狮作为唯一封面焦点", aspectRatio: "5:3" }), {
    candidateCount: 2,
    judgments: (candidates) => [
      completeAudit(candidates[1], { actualSubject: "塞伦盖蒂草原雄狮", score: 96, reason: "主体与封面职责一致" }),
      completeAudit(candidates[0], { actualSubject: "酒店室内", subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch", score: 20, reason: "主体不符" }),
    ],
  });
  const selected = result.results[0].selected;
  const selectedRecord = result.results[0].candidates.find((candidate) => candidate.candidateId === selected.candidateId);
  assert.equal(result.results[0].status, "success");
  assert.equal(selected.actualSubject, "塞伦盖蒂草原雄狮");
  assert.equal(selected.localUrl, selectedRecord.localUrl);
  assert.equal(selected.actualSubject, selectedRecord.actualSubject);
  assert.equal(selected.hardJudgment.eligible, true);
  assert.match(selected.localUrl, /candidate-2\.jpg$/);
});

test("真实批量视觉请求和返回都以candidateId为硬契约", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-audit-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await Promise.all([1, 2].map(async (number) => {
    const filePath = path.join(root, `${number}.jpg`);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20 * number, g: 80, b: 140 } } }).jpeg().toFile(filePath);
    return { candidateId: `candidate-fixed-${number}`, filePath, pageUrl: `https://example.com/${number}`, title: `候选${number}`, officialHint: true };
  }));
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ judgments: [
      { candidateId: "candidate-fixed-2", actualSubject: "游猎车与草原", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 95 },
      { candidateId: "unknown", actualSubject: "未知", locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, hardRejectCode: "none", score: 99 },
      { candidateId: "candidate-fixed-1", actualSubject: "酒店室内", locationMatch: true, hotelIdentityMatch: true, activityMatch: false, subjectMatch: false, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: false, hardRejectCode: "activity_mismatch", score: 20 },
    ] }) } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const judgments = await judgeCandidatesBatch({ slot: { label: "DAY2", module: "day", context: "塞伦盖蒂", subject: "游猎", visualGoal: "游猎职责", mustHave: ["地点：塞伦盖蒂", "活动：游猎", "主体：游猎"], prefer: [], forbid: [] }, candidates: files, apiKey: "key", baseUrl: "https://vision.invalid", model: "model" });
  const promptText = requestBody.messages[0].content.find((item) => item.type === "text").text;
  assert.match(promptText, /candidateId=candidate-fixed-1/);
  assert.match(promptText, /locationMatch/);
  assert.match(promptText, /eligible/);
  assert.match(promptText, /photographic/);
  assert.deepEqual(judgments.map((item) => item.candidateId), ["candidate-fixed-2", "candidate-fixed-1"]);
});

test("候选图片视觉判断超时后返回可隔离的技术错误", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-audit-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "candidate.jpg");
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 40, g: 90, b: 140 } } }).jpeg().toFile(filePath);
  await assert.rejects(() => judgeCandidatesBatch({
    slot: { label: "DAY8", module: "day", context: "内罗毕", subject: "返程", visualGoal: "返程画面", mustHave: [], prefer: [], forbid: [] },
    candidates: [{ candidateId: "candidate-timeout", filePath, pageUrl: "https://example.com/timeout", title: "候选" }],
    apiKey: "key",
    baseUrl: "https://vision.invalid",
    model: "model",
    timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })),
  }), (error) => error.code === "audit_timeout");
});

test("搜索 query 不拼接 visualGoal、differenceFromAdjacent 或 DAY 长文", () => {
  const queries = buildImageQueries(slot("walking", {
    location: "Singita Grumeti",
    activity: "walking night safari",
    subject: "walking night safari",
    locationRole: "scope_only",
    queryCore: { subject: "night safari", action: "walking" },
    searchIntent: ["walking night safari", "guided bush walk"],
    visualGoal: "这是一段很长的视觉目标，不得进入搜索词",
    visualContext: { differenceFromAdjacent: "与前后日不同的冗长说明", daySourceFacts: "整段 DAY 文案" },
  }));
  assert.match(queries.join(" "), /walking night safari/);
  assert.doesNotMatch(queries.join(" "), /Singita Grumeti/);
  assert.doesNotMatch(queries.join(" "), /很长|前后日|整段 DAY/);
});

test("联网搜索也使用修复后的画面保真Query", () => {
  const queries = buildImageQueries(slot("transfer", {
    moduleType: "day",
    location: "内罗毕",
    activity: "商务车送机",
    subject: "商务车送机",
    primaryVisualSubject: "商务车送机",
    queryCore: { subject: "商务车", action: "送机", subjectEn: "business transfer vehicle", actionEn: "airport transfer" },
    locationRole: "scope_only",
    fidelityQuery: "证明当天核心体验并区别其他图片",
    alternateQueries: [],
  }));
  assert.match(queries[0], /商务车.*送机/);
  assert.doesNotMatch(queries.join(" "), /机场建筑|terminal exterior/);
});

test("无法形成安全Query的单个图片位转人工且不影响其他Slot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-query-repair-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let searchCalls = 0;
  const result = await runImageSearchSkill({
    root,
    slots: [
      slot("safe", { primaryVisualSubject: "草原象群", subject: "草原象群", activity: "草原象群", searchIntent: ["草原象群", "elephant herd"] }),
      slot("manual", { primaryVisualSubject: "证明当天核心体验；补充当天体验", subject: "", activity: "", searchIntent: [] }),
    ],
    searchApiKey: "search-key",
    searchBaseUrl: "https://search.example/v1",
    searchModel: "search-model",
    adapters: {
      searchWebBatch: async () => { searchCalls += 1; return []; },
      searchCommonsImages: async () => [],
    },
  });
  assert.equal(result.results.find((item) => item.slotId === "manual").status, "needs_user_action");
  assert.equal(result.results.find((item) => item.slotId === "manual").technicalStatus, "query_core_unrecoverable");
  assert.equal(result.results.find((item) => item.slotId === "safe").status, "not_found");
  assert.equal(searchCalls, 2);
});

test("搜索非法JSON类技术错误以完全相同 query 重试一次", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-search-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const result = await runImageSearchSkill({
    root, slots: [slot("retry", { location: "Singita Grumeti", activity: "walking safari", subject: "walking safari" })],
    searchApiKey: "key", searchModel: "model",
    adapters: {
      searchWebBatch: async ({ queries }) => { seen.push([...queries]); if (seen.length === 1) throw new SyntaxError("Gemini 搜索未返回可解析的 JSON"); return []; },
      searchCommonsImages: async () => [],
    },
  });
  assert.equal(result.metrics.searchCalls, 3);
  assert.equal(result.metrics.technicalRetries.search, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen.length, 3);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.entered, false);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.reason, "disabled_by_query_scope_plan");
  assert.equal(result.results[0].status, "not_found");
});

test("地图主图与坦桑尼亚位置冲突图即使其他判断为true也硬拒绝", async (t) => {
  for (const [id, actualSubject, photographic, expected] of [
    ["day-map", "DAY7 草原飞机返程路线地图", false, "non_photographic"],
    ["transport-china", "中国内蒙古呼伦贝尔机场的草原飞机照片", true, "place_mismatch"],
  ]) {
    const result = await runAuditedFixture(t, slot(id, { moduleType: id.startsWith("transport") ? "transport" : "day", location: "坦桑尼亚", activity: "草原飞机返程", subject: "草原飞机" }), {
      judgments: (candidates) => candidates.map((candidate) => completeAudit(candidate, photographic
        ? { actualSubject, locationMatch: false, visibleLocationConflict: true, eligible: false, matchLevel: "mismatch", hardRejectCode: "wrong_location", score: 95, reason: actualSubject }
        : { actualSubject, photographic: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "non_photographic", score: 95, reason: actualSubject })),
    });
    assert.equal(result.results[0].status, "not_found");
    assert.equal(result.results[0].candidates[0].rejection, expected === "place_mismatch" ? "wrong_location" : expected);
  }
});

test("徒步游猎不能被酒店泳池木栈道人物照冒充", async (t) => {
  const result = await runAuditedFixture(t, slot("walking-pool", { location: "示例保护区", activity: "户外徒步观察", subject: "户外徒步观察", queryCore: { subject: "向导徒步", action: "步行观察" } }), {
    judgments: (candidates) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "酒店泳池边木栈道上的服务员", coreActionMatch: false, activityMatch: false, coreSubjectMatch: false, subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "wrong_activity", score: 95, reason: "泳池边酒店服务场景" })),
  });
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.results[0].candidates[0].rejection, "wrong_activity");
});

test("DAY primary 明确活动不能被模型误判为合格的酒店空间冒充", async (t) => {
  for (const [activity, actualSubject] of [
    ["塞伦盖蒂西部游猎", "酒店泳池躺椅与遮阳伞休闲区"],
    ["草原飞机返程", "营地 lounge 与餐厅"],
    ["马赛文化体验", "豪华客房与卧室"],
    ["反偷猎观察站参访", "帐篷室内起居空间"],
  ]) {
    const result = await runAuditedFixture(t, slot(`guard-${activity}`, { activity, subject: activity, queryCore: { subject: activity, action: "参与该体验" } }), {
      judgments: (candidates) => candidates.map((candidate) => completeAudit(candidate, { actualSubject, coreActionMatch: false, activityMatch: false, coreSubjectMatch: false, subjectMatch: false, transportTypeMatch: activity === "草原飞机返程" ? false : true, eligible: false, matchLevel: "mismatch", hardRejectCode: activity === "草原飞机返程" ? "wrong_transport_type" : "wrong_activity", score: 99, reason: "候选不承担目标体验" })),
    });
    assert.equal(result.results[0].status, "not_found", activity);
    assert.equal(result.results[0].candidates[0].rejection, activity === "草原飞机返程" ? "wrong_transport_type" : "wrong_activity", activity);
  }
});

test("活动语义相关候选优先消耗有限下载名额", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-semantic-ranking-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const downloadedUrls = [];
  const result = await runImageSearchSkill({
    root,
    slots: [slot("semantic", { location: "Singita Grumeti", activity: "anti-poaching observation post", subject: "anti-poaching observation post" })],
    searchApiKey: "key", searchModel: "model", visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    sourcePagesPerSlot: 1, downloadsPerSlot: 1, visionCandidatesPerSlot: 1,
    adapters: {
      searchWebBatch: async () => [{ title: "Anti-poaching activity", pageUrl: "https://example.com/activity", officialHint: true }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => [
        { ...page, imageUrl: "https://example.com/pool.jpg", alt: "large pool", highResHint: true, semanticScore: 0, genericActivityPenalty: 36 },
        { ...page, imageUrl: "https://example.com/ranger.jpg", alt: "ranger at observation post", semanticScore: 70, semanticMatches: ["ranger", "observation post"], genericActivityPenalty: 0 },
      ],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadedUrls.push(candidate.imageUrl);
        const filePath = path.join(directory, "ranger.jpg");
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: "#556644" } }).jpeg().toFile(filePath);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/ranger.jpg`, sha256: "semantic-ranger", width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "反偷猎巡护员位于观察站", score: 96, reason: "活动主体匹配" })),
    },
  });
  assert.deepEqual(downloadedUrls, ["https://example.com/ranger.jpg"]);
  assert.equal(result.results[0].pipelineEvidence.semanticRelevantCandidates, 1);
  assert.equal(result.results[0].selected.semanticScore, 70);
  assert.deepEqual(result.results[0].selected.semanticMatches, ["ranger", "observation post"]);
});

test("精确活动图合格时记录 exact_match 且不进入 fallback", async (t) => {
  const events = [];
  const result = await runLayeredFixture(t, {
    exactCandidates: [{ name: "exact-post", actualSubject: "Grumeti anti-poaching observation post with game scouts", semanticScore: 70 }],
    exactEligible: true,
    events,
  });
  const item = result.results[0];
  assert.equal(item.status, "success");
  assert.equal(item.matchLevel, "exact_match");
  assert.equal(item.selected.matchLevel, "exact_match");
  assert.equal(item.pipelineEvidence.exactMatchSuccess, true);
  assert.equal(item.pipelineEvidence.controlledFallback.entered, false);
  assert.deepEqual(events, ["exact_search", "exact_semantic_extract", "exact_visual"]);
});

test("精确层无合格图时停止，不再进入旧 controlled fallback", async (t) => {
  const events = [];
  const result = await runLayeredFixture(t, { events });
  assert.deepEqual(events, ["exact_search", "exact_semantic_extract", "exact_visual"]);
  assert.equal(result.results[0].pipelineEvidence.semanticExtractionCompleted, true);
  assert.equal(result.results[0].pipelineEvidence.visualJudgmentCompleted, true);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.entered, false);
  assert.equal(result.results[0].pipelineEvidence.controlledFallback.reason, "disabled_by_query_scope_plan");
  assert.equal(result.results[0].status, "not_found");
  assert.equal(result.metrics.automaticFollowupRounds, 0);
  assert.equal(result.metrics.businessBatches, 1);
});

test("Knowledge 查询缓存签名隔离 Scope、访问身份、top_k 与筛选参数", () => {
  const base = { source: "http://192.168.100.210:8020/", accessIdentity: "tenant-a", scopeNodeIds: ["region", "hotel"], query: "  Pool  ", topK: 5, resultType: "image", options: { status: "active", locale: "en" } };
  const equivalent = buildKnowledgeQueryCacheKey({ ...base, source: "http://192.168.100.210:8020", scopeNodeIds: ["hotel", "region"], query: "pool", options: { locale: "en", status: "active" } });
  assert.equal(buildKnowledgeQueryCacheKey(base), equivalent);
  assert.notEqual(buildKnowledgeQueryCacheKey(base), buildKnowledgeQueryCacheKey({ ...base, scopeNodeIds: ["other-hotel"] }));
  assert.notEqual(buildKnowledgeQueryCacheKey(base), buildKnowledgeQueryCacheKey({ ...base, accessIdentity: "tenant-b" }));
  assert.notEqual(buildKnowledgeQueryCacheKey(base), buildKnowledgeQueryCacheKey({ ...base, topK: 10 }));
  assert.notEqual(buildKnowledgeQueryCacheKey(base), buildKnowledgeQueryCacheKey({ ...base, options: { status: "archived", locale: "en" } }));
});

test("同一次运行相同 Scope 与 Query 的并发 Slot 只提交一次知识库请求，但各自独立视觉审核", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-query-coalescing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let actualRequests = 0;
  let downloadCalls = 0;
  const auditedSlots = [];
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["shared-scope"],
    knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [
      slot("cache-slot-a", { location: "Amboseli", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd", searchIntent: ["elephant herd", "savanna elephants"] }),
      slot("cache-slot-b", { location: "Amboseli", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd", searchIntent: ["elephant herd", "savanna elephants"] }),
    ],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    concurrency: { slots: 3, search: 3, downloads: 3, vision: 2 },
    adapters: {
      searchKnowledgeImages: async ({ queries }) => { actualRequests += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return knowledgeFixture(queries[0], { queryId: "qry-shared", prefix: "shared", fragment: "elephant herd" }); },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { downloadCalls += 1; const index = Number(candidate.title.match(/(\d+)\.jpg$/)?.[1] || downloadCalls); const filePath = path.join(directory, `shared-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/shared-${index}.jpg`, sha256: `shared-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ slot: auditSlot, candidates }) => { auditedSlots.push(auditSlot.slotId); const approved = auditSlot.slotId === "cache-slot-a"; return candidates.map((candidate) => completeAudit(candidate, approved ? { actualSubject: "elephant herd", score: 90 } : { actualSubject: "hotel room", subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch", score: 20 })); },
      searchWebBatch: async () => { throw new Error("knowledge_only 不得访问公网"); },
      searchCommonsImages: async () => { throw new Error("knowledge_only 不得访问 Commons"); },
    },
  });
  assert.equal(actualRequests, 2);
  assert.equal(result.metrics.knowledgeLogicalQueries, 3);
  assert.equal(result.metrics.knowledgeActualRequests, 2);
  assert.equal(result.metrics.knowledgeQueryReused, 1);
  assert.equal(result.metrics.knowledgeQueryInFlightReused, 1);
  assert.equal(downloadCalls, 5);
  assert.deepEqual(new Set(auditedSlots), new Set(["cache-slot-a", "cache-slot-b"]));
  assert.equal(result.results.find((item) => item.slotId === "cache-slot-a").status, "success");
  assert.equal(result.results.find((item) => item.slotId === "cache-slot-b").status, "not_found");
  assert.equal(result.metrics.searchCalls, 0);
  assert.equal(result.metrics.commonsCalls, 0);
});

test("Knowledge 失败结果不会固化为本次运行的缓存命中", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-failed-query-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let actualRequests = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["shared-scope"], knowledgeQueriesPerSlot: 1,
    slots: [
      slot("failed-cache-a", { location: "Amboseli", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd" }),
      slot("failed-cache-b", { location: "Amboseli", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd" }),
    ],
    concurrency: { slots: 1, search: 1 },
    adapters: {
      searchKnowledgeImages: async ({ queries }) => { actualRequests += 1; return { status: "failed", queryId: `qry-failed-${actualRequests}`, queryText: queries[0], errorId: "knowledge-test-failure", candidates: [], records: [] }; },
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(actualRequests, 2);
  assert.equal(result.metrics.knowledgeActualRequests, 2);
  assert.equal(result.metrics.knowledgeQueryReused, 0);
  assert.ok(result.results.every((item) => item.status === "failed"));
});

test("同一素材被多个 Knowledge Query 返回时合并 provenance，且不重复下载或审核", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-candidate-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let downloads = 0;
  let audited = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["walking-scope"], knowledgeQueriesPerSlot: 2,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 6,
    slots: [slot("merged-asset", { location: "Amboseli", activity: "Walking Safari", subject: "Walking Safari", primaryVisualSubject: "Walking Safari", searchIntent: ["步行游猎", "丛林徒步"] })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        calls += 1;
        if (calls === 1) return knowledgeFixture(queries[0], { queryId: "qry-walk-1", prefix: "walk-first", count: 1, assetIds: ["shared-walk"], fragment: "walking safari" });
        return knowledgeFixture(queries[0], { queryId: "qry-walk-2", prefix: "walk-second", count: 4, assetIds: ["shared-walk", "walk-2", "walk-3", "walk-4"], fragment: "guided walking safari" });
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloads; const filePath = path.join(directory, `merge-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/merge-${index}.jpg`, sha256: `merge-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => {
        const firstQuery = calls === 1;
        audited += candidates.length;
        return candidates.map((candidate, index) => completeAudit(candidate, firstQuery
          ? { actualSubject: "unrelated room", coreSubjectMatch: false, subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "wrong_subject", score: 20 }
          : { actualSubject: "guided walking safari", score: 95 - index }));
      },
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.metrics.knowledgeUniqueCandidates, 4);
  assert.equal(result.metrics.knowledgeMergedDuplicates, 1);
  assert.equal(downloads, 5);
  assert.equal(audited, 4);
  const merged = result.results[0].pipelineEvidence.knowledgeSearch.candidates.find((candidate) => candidate.assetKey === "asset:shared-walk");
  assert.deepEqual(merged.queryIds, ["qry-walk-1", "qry-walk-2"]);
  assert.deepEqual(merged.queryTexts, ["步行游猎", "丛林徒步"]);
});

test("批量视觉审核按评分择优，不受模型返回数组顺序影响", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-quality-ranking-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["mara"], knowledgeQueriesPerSlot: 1, trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("quality-rank", { location: "Masai Mara", activity: "leopard safari", subject: "leopard", primaryVisualSubject: "leopard" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-quality", prefix: "quality", fragment: "leopard" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloadIndex; const filePath = path.join(directory, `quality-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/quality-${index}.jpg`, sha256: `quality-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => [
        completeAudit(candidates[0], { actualSubject: "leopard", score: 55, relevance: 60, composition: 60 }),
        completeAudit(candidates[1], { actualSubject: "leopard", score: 70, relevance: 70, composition: 70 }),
        completeAudit(candidates[2], { actualSubject: "leopard", score: 98, relevance: 98, composition: 96, luxury: 95 }),
        completeAudit(candidates[3], { actualSubject: "leopard", score: 65, relevance: 65, composition: 65 }),
      ],
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(result.results[0].selected.sourceTitle, "quality-3.jpg");
  const eligibleNotSelected = result.results[0].candidates.filter((candidate) => candidate.selected !== true && candidate.hardJudgment?.eligible === true);
  assert.ok(eligibleNotSelected.length >= 1);
  assert.ok(eligibleNotSelected.every((candidate) => candidate.qualificationStatus === "eligible" && candidate.autoRejected === false));
});

test("最高分候选命中硬拒绝时不可采用，改选下一张合格候选", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-hard-reject-ranking-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["mara"], knowledgeQueriesPerSlot: 1, trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("hard-reject-rank", { location: "Masai Mara", activity: "leopard safari", subject: "leopard", primaryVisualSubject: "leopard" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-hard", prefix: "hard", fragment: "leopard" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloadIndex; const filePath = path.join(directory, `hard-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/hard-${index}.jpg`, sha256: `hard-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => completeAudit(candidate, index === 0
        ? { actualSubject: "lion", score: 100, relevance: 100, subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch" }
        : { actualSubject: "leopard", score: 90 - index })),
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(result.results[0].selected.sourceTitle, "hard-2.jpg");
  const rejected = result.results[0].candidates.find((candidate) => candidate.sourceTitle === "hard-1.jpg");
  assert.equal(rejected.autoReviewStatus, "hard_reject");
  assert.equal(rejected.hardJudgment.eligible, false);
});

test("本批最优图与已有成品重复时尝试下一张合格候选", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-next-best-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["kenya"], knowledgeQueriesPerSlot: 1, trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], existingImages: [{ sha256: "duplicate-best" }],
    slots: [slot("next-best", { location: "Kenya", activity: "bush plane", subject: "bush plane", primaryVisualSubject: "bush plane", moduleType: "transport" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-plane", prefix: "plane", fragment: "bush plane" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloadIndex; const filePath = path.join(directory, `plane-${index}.jpg`); await writeDistinctTestImage(filePath, index); const originalIndex = Number(candidate.title.match(/(\d+)\.jpg$/)?.[1] || index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/plane-${index}.jpg`, sha256: candidate.imageUrl.includes("/original/") && originalIndex === 1 ? "duplicate-best" : `plane-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => completeAudit(candidate, { actualSubject: "bush plane", transportType: "bush_plane", transportTypeMatch: true, score: 99 - index * 10 })),
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(result.results[0].selected.sourceTitle, "plane-2.jpg");
  const duplicate = result.results[0].candidates.find((candidate) => candidate.sourceTitle === "plane-1.jpg");
  assert.equal(duplicate.rejection, "exact-duplicate");
  assert.equal(duplicate.candidateStatus, "downloaded_not_selected");
  assert.equal(duplicate.originalDownloaded, true);
});

test("前四张全部不合格时继续审核当前候选池下一批四张", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-cumulative-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let queryCalls = 0;
  let downloads = 0;
  let audits = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["amboseli"], knowledgeQueriesPerSlot: 1, downloadsPerSlot: 5, trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("budget", { location: "Amboseli", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        queryCalls += 1;
        if (queryCalls === 1) return knowledgeFixture(queries[0], { queryId: "qry-budget-1", prefix: "budget-1", count: 8, fragment: "elephant herd" });
        return { status: "completed", queryId: "qry-budget-2", queryText: queries[0], scopeState: "no_match", message: "未找到匹配内容", records: [], candidates: [] };
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloads; const filePath = path.join(directory, `budget-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/budget-${index}.jpg`, sha256: `budget-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async ({ candidates }) => { audits += candidates.length; return candidates.map((candidate) => completeAudit(candidate, { actualSubject: "hotel room", subjectMatch: false, eligible: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch", score: 10 })); },
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(queryCalls, 2);
  assert.equal(downloads, 8);
  assert.equal(audits, 8);
  const audit = result.results[0].pipelineEvidence.knowledgeSearch;
  assert.deepEqual(audit.originalDownloadBudget, { limit: 5, used: 0, remaining: 5 });
  assert.equal(audit.previewAudited, 8);
  assert.equal(audit.autoReviewLimit, 4);
  assert.equal(audit.notAutoReviewedCount, 0);
  assert.equal(audit.candidates.filter((candidate) => candidate.downloadStatus === "not_requested").length, 8);
  assert.equal(result.results[0].candidates.length, 8);
  assert.equal(result.results[0].candidates.filter((candidate) => candidate.candidateStatus === "not_auto_reviewed").length, 0);
});

test("知识库返回10张 preview 全部保留，首批四张出现高质量eligible后早停且只下载最终采用的1张 matched_file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-preview-first-ten-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetched = [];
  const audited = [];
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["mara"], knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 6, visionCandidatesPerSlot: 6,
    slots: [slot("preview-ten", { location: "Masai Mara", activity: "leopard safari", subject: "leopard", primaryVisualSubject: "leopard", searchIntent: ["花豹游猎", "leopard safari"] })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: (() => { let calls = 0; return async ({ queries }) => { calls += 1; return calls === 1
        ? knowledgeFixture(queries[0], { queryId: "qry-preview-ten", prefix: "preview-ten", count: 10, fragment: "leopard safari" })
        : { status: "completed", queryId: "qry-preview-ten-empty", queryText: queries[0], scopeState: "no_match", records: [], candidates: [], clarificationNodeIds: [] }; }; })(),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        fetched.push(candidate.imageUrl);
        const index = fetched.length;
        const filePath = path.join(directory, `preview-ten-${index}.jpg`);
        await writeDistinctTestImage(filePath, index);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/preview-ten-${index}.jpg`, sha256: `preview-ten-hash-${index}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => {
        audited.push(...candidates.map((candidate) => candidate.candidateId));
        return candidates.map((candidate, index) => completeAudit(candidate, { actualSubject: "leopard", score: 70 + index }));
      },
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  const imageResult = result.results[0];
  assert.equal(imageResult.candidates.length, 10);
  assert.equal(new Set(audited).size, 4);
  assert.equal(fetched.filter((url) => url.includes("/preview/")).length, 10);
  assert.equal(fetched.filter((url) => url.includes("/original/")).length, 1);
  assert.equal(result.metrics.previewReturned, 10);
  assert.equal(result.metrics.previewUnique, 10);
  assert.equal(result.metrics.previewAudited, 4);
  assert.equal(result.metrics.matchedFileDownloadAttempts, 1);
  assert.equal(result.metrics.matchedFileDownloadSuccess, 1);
  assert.equal(result.metrics.originalDownloadSavedCount, 1);
  assert.equal(imageResult.candidates.filter((candidate) => candidate.selected).length, 1);
  assert.equal(imageResult.candidates.filter((candidate) => candidate.localPreviewUrl).length, 10);
  assert.equal(imageResult.candidates.filter((candidate) => candidate.candidateStatus === "not_auto_reviewed").length, 6);
  assert.equal(imageResult.candidates.find((candidate) => candidate.selected).candidateStatus, "selected");
});

test("首批四张只有representative时继续审核下一批四张，并在第七张exact后停止搜索", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-dynamic-review-wave-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let queryCalls = 0;
  const auditedRanks = [];
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["scope"], knowledgeQueriesPerSlot: 2,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 3,
    slots: [slot("dynamic-wave", { subject: "核心体验", activity: "核心体验", primaryVisualSubject: "理想完整体验", searchIntent: ["核心体验", "核心体验备用词"] })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        queryCalls += 1;
        return knowledgeFixture(queries[0], { queryId: "dynamic-wave-query", prefix: "dynamic-wave", count: 8, fragment: "核心体验" });
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const rank = Number(candidate.title.match(/-(\d+)\.jpg$/)?.[1] || 1);
        const filePath = path.join(directory, `dynamic-wave-${candidate.imageUrl.includes("/original/") ? "original" : "preview"}-${rank}.jpg`);
        await writeDistinctTestImage(filePath, rank);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: path.basename(filePath), width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => {
        const rank = Number(candidate.title.match(/-(\d+)\.jpg$/)?.[1] || 1);
        auditedRanks.push(rank);
        return completeAudit(candidate, rank === 7
          ? { actualSubject: "核心体验完整画面", matchLevel: "exact", score: 96, relevance: 96 }
          : { actualSubject: "核心体验代表画面", matchLevel: "representative", score: 70, relevance: 70 });
      }),
      searchWebBatch: async () => { throw new Error("不得访问公网"); },
      searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(queryCalls, 1);
  assert.deepEqual(new Set(auditedRanks), new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.match(result.results[0].selected.sourceTitle, /-7\.jpg$/);
  assert.equal(result.results[0].pipelineEvidence.knowledgeSearch.earlyStopReason, "exact_eligible");
});

test("preview 已审核但 matched_file 下载失败时保留候选并单独标记原件失败", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-original-download-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["mara"], knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 1,
    slots: [slot("original-failed", { location: "Masai Mara", activity: "leopard safari", subject: "leopard", primaryVisualSubject: "leopard" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-original-failed", prefix: "original-failed", count: 1, fragment: "leopard" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        if (candidate.imageUrl.includes("/original/")) throw new Error("文件过大，超过资源上限");
        const filePath = path.join(directory, "original-failed-preview.webp");
        await writeDistinctTestImage(filePath, 1);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/original-failed-preview.webp`, sha256: "preview-only", width: 960, height: 640 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: "leopard", score: 96 })),
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  const imageResult = result.results[0];
  assert.equal(imageResult.status, "needs_user_action");
  assert.equal(imageResult.technicalStatus, "preview_found_original_download_failed");
  assert.equal(imageResult.candidates.length, 1);
  assert.equal(imageResult.candidates[0].localUrl, null);
  assert.ok(imageResult.candidates[0].localPreviewUrl);
  assert.equal(imageResult.candidates[0].autoReviewStatus, "original_download_failed");
  assert.equal(imageResult.candidates[0].originalDownloadStatus, "failed");
  assert.equal(imageResult.candidates[0].rejection, "preview_found_original_download_failed");
  assert.equal(result.metrics.matchedFileDownloadAttempts, 1);
  assert.equal(result.metrics.matchedFileDownloadSuccess, 0);
  assert.equal(result.metrics.knowledgeNotFound, 0);
});

test("知识库首选原件分辨率不足时继续采用下一张合格原件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-resolution-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalAttempts = [];
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["nairobi"], knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 2,
    slots: [slot("resolution-fallback", { location: "Nairobi", activity: "Giraffe Centre interaction", subject: "feeding giraffe", primaryVisualSubject: "feeding giraffe" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-resolution-fallback", prefix: "giraffe", count: 2, fragment: "feeding giraffe visitor" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const isOriginal = candidate.imageUrl.includes("/original/");
        const rank = Number(candidate.title.match(/-(\d+)\.jpg$/)?.[1] || 1);
        if (isOriginal) {
          originalAttempts.push(rank);
          if (rank === 1) throw Object.assign(new Error("图片分辨率不足：实际 521×377，至少需要 900×500"), { code: "image_resolution_insufficient", actualWidth: 521, actualHeight: 377, minWidth: 900, minHeight: 500 });
        }
        const filePath = path.join(directory, `${isOriginal ? "original" : "preview"}-${rank}.jpg`);
        await writeDistinctTestImage(filePath, rank);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: `${isOriginal ? "original" : "preview"}-${rank}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => completeAudit(candidate, { actualSubject: "feeding giraffe visitor", score: 100 - index })),
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  const imageResult = result.results[0];
  assert.deepEqual(originalAttempts, [1, 2]);
  assert.equal(imageResult.status, "success");
  assert.match(imageResult.selected.sourceTitle, /-2\.jpg$/);
  const lowResolution = imageResult.candidates.find((candidate) => /-1\.jpg$/.test(candidate.sourceTitle));
  assert.equal(lowResolution.candidateStatus, "manual_only");
  assert.equal(lowResolution.autoReviewStatus, "original_resolution_insufficient");
  assert.equal(lowResolution.rejection, "resolution_failed");
  assert.equal(lowResolution.originalWidth, 521);
  assert.equal(lowResolution.originalHeight, 377);
});

test("所有合格 preview 的原件都低清时明确报告尺寸并保留人工候选", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-resolution-all-low-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["nairobi"], knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"], downloadsPerSlot: 2,
    slots: [slot("resolution-all-low", { location: "Nairobi", activity: "Giraffe Centre interaction", subject: "feeding giraffe", primaryVisualSubject: "feeding giraffe" })],
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-resolution-all-low", prefix: "giraffe-low", count: 2, fragment: "feeding giraffe visitor" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const rank = Number(candidate.title.match(/-(\d+)\.jpg$/)?.[1] || 1);
        if (candidate.imageUrl.includes("/original/")) throw Object.assign(new Error(`图片分辨率不足：实际 ${520 + rank}×377，至少需要 900×500`), { code: "image_resolution_insufficient", actualWidth: 520 + rank, actualHeight: 377, minWidth: 900, minHeight: 500 });
        const filePath = path.join(directory, `preview-low-${rank}.jpg`);
        await writeDistinctTestImage(filePath, rank);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/${path.basename(filePath)}`, sha256: `preview-low-${rank}`, width: 521, height: 377 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate, index) => completeAudit(candidate, { actualSubject: "feeding giraffe visitor", score: 100 - index })),
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  const imageResult = result.results[0];
  assert.equal(imageResult.status, "needs_user_action");
  assert.equal(imageResult.technicalStatus, "knowledge_original_resolution_insufficient");
  assert.match(imageResult.matchReason, /521×377/);
  assert.equal(imageResult.candidates.length, 2);
  assert.ok(imageResult.candidates.every((candidate) => candidate.localPreviewUrl && candidate.candidateStatus === "manual_only" && candidate.rejection === "resolution_failed"));
  assert.equal(result.metrics.knowledgeNotFound, 0);
});

test("视觉审核超时后已下载候选仍作为 Step4 人工候选保留", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-retain-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let downloadIndex = 0;
  const result = await runImageSearchSkill({
    root, sourceMode: "knowledge_only", knowledgeBaseUrl: "http://192.168.100.210:8020", knowledgeScopeNodeIds: ["kenya"], knowledgeQueriesPerSlot: 1, trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: [slot("retain-timeout", { location: "Kenya", activity: "elephant herd", subject: "elephant herd", primaryVisualSubject: "elephant herd" })], visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: "qry-timeout-retain", prefix: "timeout-retain", fragment: "elephant herd" }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => { const index = ++downloadIndex; const filePath = path.join(directory, `timeout-retain-${index}.jpg`); await writeDistinctTestImage(filePath, index); return { ...candidate, filePath, publicUrl: `${publicPrefix}/timeout-retain-${index}.jpg`, sha256: `timeout-retain-hash-${index}`, width: 1400, height: 900 }; },
      judgeCandidatesBatch: async () => { throw Object.assign(new Error("视觉审核超时"), { code: "audit_timeout" }); },
      searchWebBatch: async () => { throw new Error("不得访问公网"); }, searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(result.results[0].status, "needs_user_action");
  assert.equal(result.results[0].technicalStatus, "visual_judgment_inconclusive");
  assert.equal(result.results[0].candidates.length, 4);
  assert.ok(result.results[0].candidates.every((candidate) => !candidate.localUrl && candidate.localPreviewUrl && candidate.reviewTimeout && candidate.manualOnly));
});

test("默认视觉审核并发为3", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-vision-three-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active = 0;
  let peak = 0;
  let imageIndex = 0;
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["kenya"],
    knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: ["elephants", "leopard", "walking safari"].map((subject, index) => slot(`vision-${index + 1}`, { location: "Kenya", activity: subject, subject, primaryVisualSubject: subject })),
    visionApiKey: "vision",
    visionBaseUrl: "https://vision.invalid",
    visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => knowledgeFixture(queries[0], { queryId: `qry-${queries[0]}`, prefix: queries[0].replace(/\s+/g, "-"), count: 1, fragment: queries[0] }),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const index = ++imageIndex;
        const filePath = path.join(directory, `vision-${index}.jpg`);
        await writeDistinctTestImage(filePath, index);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/vision-${index}.jpg`, sha256: `vision-hash-${index}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return candidates.map((candidate) => completeAudit(candidate, { actualSubject: candidate.sourceTitle, score: 90 }));
      },
      searchWebBatch: async () => { throw new Error("不得访问公网"); },
      searchCommonsImages: async () => { throw new Error("不得访问 Commons"); },
    },
  });
  assert.equal(peak, 3);
  assert.equal(result.metrics.concurrencyPeak.vision, 3);
  assert.equal(result.metrics.knowledgeOnlyVerified, true);
});

test("默认多图片位与知识库搜索并发上限为4", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-image-slot-four-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let activeSearches = 0;
  let peakSearches = 0;
  let imageIndex = 0;
  const subjects = ["elephants", "leopard", "walking safari", "bush plane"];
  const result = await runImageSearchSkill({
    root,
    sourceMode: "knowledge_only",
    knowledgeBaseUrl: "http://192.168.100.210:8020",
    knowledgeScopeNodeIds: ["kenya"],
    knowledgeQueriesPerSlot: 1,
    trustedKnowledgeOrigins: ["http://192.168.100.210:9000"],
    slots: subjects.map((subject, index) => slot(`slot-four-${index + 1}`, { location: "Kenya", activity: subject, subject, primaryVisualSubject: subject, fidelityQuery: subject, alternateQueries: [`${subject} photo`] })),
    visionApiKey: "vision",
    visionBaseUrl: "https://vision.invalid",
    visionModel: "model",
    adapters: {
      searchKnowledgeImages: async ({ queries }) => {
        activeSearches += 1;
        peakSearches = Math.max(peakSearches, activeSearches);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeSearches -= 1;
        return knowledgeFixture(queries[0], { queryId: `qry-four-${queries[0]}`, prefix: `four-${queries[0].replace(/\s+/g, "-")}`, count: 1, fragment: queries[0] });
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const index = ++imageIndex;
        const filePath = path.join(directory, `slot-four-${index}.jpg`);
        await writeDistinctTestImage(filePath, index);
        return { ...candidate, filePath, publicUrl: `${publicPrefix}/slot-four-${index}.jpg`, sha256: `slot-four-${index}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map((candidate) => completeAudit(candidate, { actualSubject: candidate.sourceTitle, score: 90 })),
      searchWebBatch: async () => { throw new Error("不得调用公网"); },
      searchCommonsImages: async () => { throw new Error("不得调用 Commons"); },
    },
  });
  assert.equal(peakSearches, 4);
  assert.equal(result.metrics.concurrencyPeak.slots, 4);
  assert.equal(result.metrics.concurrencyPeak.search, 4);
});
test("Web只补结构化身份：普通两条、酒店四类且不使用理想长句", () => {
  assert.deepEqual(buildWebExecutionQueries({ moduleType: "day", country: "测试国家", primaryVisualSubject: "不该进入搜索的长句" }, ["核心主体动作", "core action", "ignored"]), ["core action", "核心主体动作"]);
  assert.deepEqual(buildWebExecutionQueries({ moduleType: "hotel", hotel: { officialName: "Official Hotel" } }, ["very specific ideal"]), ["Official Hotel exterior", "Official Hotel suite", "Official Hotel pool", "Official Hotel public space"]);
  assert.deepEqual(buildWebExecutionQueries({ moduleType: "dining", hotel: "Official Hotel",exactIdentityRequired:true,queryCore:{identity:"Official Hotel"} }, ["户外晚餐"], "hotel_experience"), ["Official Hotel 户外晚餐"]);
  assert.deepEqual(buildWebExecutionQueries({ moduleType: "dining", hotel: "Context Hotel", country: "Destination" }, ["户外晚餐"], "destination_experience"), ["Destination 户外晚餐"]);
  assert.deepEqual(buildWebExecutionQueries({ moduleType: "hotel" }, ["suite"]), []);
});

test("Web fallback区分内容缺失、服务降级、目录缺失与审核故障", () => {
  const target = { moduleType: "hotel", hotel: "Known Hotel" };
  for (const status of ["knowledge_failed", "knowledge_timeout"]) assert.equal(classifyWebFallback({ kind: "search_failed", technicalStatus: status }, target).reason, "knowledge_service_degraded_fallback");
  assert.equal(classifyWebFallback({ kind: "no_eligible" }, target).reason, "content_not_found_fallback");
  assert.equal(classifyWebFallback({ kind: "inconclusive", technicalStatus: "knowledge_hotel_scope_unresolved" }, target).allowed, true);
  for (const kind of ["visual_failed", "visual_unavailable"]) assert.equal(classifyWebFallback({ kind }, target).allowed, false);
  assert.equal(classifyWebFallback({ kind: "inconclusive", technicalStatus: "visual_judgment_inconclusive" }, target).allowed, false);
  assert.equal(classifyWebFallback({ kind: "no_candidate" }, { moduleType: "hotel" }).allowed, false);
});

test("Web同一审核波次先排序再采用，不采用模型数组第一张", async (t) => {
  const result = await runAuditedFixture(t, slot("web-ranked"), { candidateCount: 4, judgments: (candidates) => candidates.map((candidate, index) => ({ candidateId: candidate.candidateId, score: index === 2 ? 99 : 88, relevance: index === 2 ? 99 : 88 })) });
  const output = result.results[0];
  assert.equal(output.status, "success");
  assert.match(output.selected.localUrl, /candidate-3\.jpg$/);
  assert.equal(output.pipelineEvidence.webExecution.executedQueries.length, 1);
  assert.equal(output.pipelineEvidence.webExecution.auditBatches[0].candidateIds.length, 4);
});

test("Web首批普通representative继续看现有池第二批，不能直接搜新词", async (t) => {
  let wave = 0;
  const result = await runAuditedFixture(t, slot("web-dynamic"), { candidateCount: 6, judgments: (candidates) => { wave += 1; return candidates.map((candidate, index) => ({ candidateId: candidate.candidateId, matchLevel: wave === 1 ? "representative" : "exact", score: wave === 1 ? 70 : 96 - index, relevance: wave === 1 ? 70 : 96 })); } });
  const output = result.results[0];
  assert.equal(output.status, "success");
  assert.deepEqual(output.pipelineEvidence.webExecution.auditBatches.map((batch) => batch.candidateIds.length), [4, 2]);
  assert.equal(output.pipelineEvidence.webExecution.executedQueries.length, 1);
  assert.equal(output.candidates.length, 6);
});

test("Web审核漏返回候选判断时保留人工状态，不继续搜索", async (t) => {
  const result = await runAuditedFixture(t, slot("web-missing"), { candidateCount: 2, judgments: () => [] });
  assert.equal(result.results[0].status, "needs_user_action");
  assert.equal(result.results[0].candidates.length, 2);
  assert.equal(result.results[0].pipelineEvidence.webExecution.executedQueries.length, 1);
  assert.ok(result.results[0].candidates.every((item) => item.rejection === "needs_user_judgment"));
});

test("Web累计预算不随Query重置，下载失败和超预算候选都保留", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await runImageSearchSkill({
    root, slots: [slot("web-budget")], downloadsPerSlot: 2, sourcePagesPerSlot: 2,
    adapters: {
      searchWebBatch: async () => { calls += 1; return [{ pageUrl: "https://example.com/test" }]; },
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => Array.from({ length: 5 }, (_, index) => ({ ...page, imageUrl: `https://example.com/${index}.jpg` })),
      downloadCandidate: async () => { throw new Error("download broken"); },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].pipelineEvidence.webExecution.stopReason, "slot_resource_budget");
  assert.equal(result.results[0].pipelineEvidence.webExecution.downloadsUsed, 2);
  assert.equal(result.results[0].candidates.length, 5);
  assert.equal(result.results[0].candidates.filter((item) => item.originalDownloadStatus === "failed").length, 2);
});

test("Web下一Query必须等待当前候选审核结束，查询实际逐条发送", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-serial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let queries = 0;
  let reviewing = false;
  const result = await runImageSearchSkill({
    root, slots: [slot("web-serial")], sourcePagesPerSlot: 4, downloadsPerSlot: 6,
    visionApiKey: "vision", visionBaseUrl: "https://vision.invalid", visionModel: "model",
    adapters: {
      searchWebBatch: async ({ queries: current }) => { assert.equal(reviewing, false); assert.equal(current.length, 1); queries += 1; events.push(`search${queries}`); return [{ pageUrl: `https://example.com/q${queries}` }]; },
      searchCommonsImages: async () => [],
      extractPageImages: async (page) => [{ ...page, imageUrl: `${page.pageUrl}/image.jpg` }],
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const filePath = path.join(directory, `serial-${queries}.jpg`);
        await sharp({ create: { width: 1400, height: 900, channels: 3, background: { r: queries * 40, g: 100, b: 80 } } }).jpeg().toFile(filePath);
        return { filePath, publicUrl: `${publicPrefix}/serial-${queries}.jpg`, sha256: `serial-${queries}`, width: 1400, height: 900 };
      },
      judgeCandidatesBatch: async ({ candidates }) => {
        reviewing = true; events.push(`audit${queries}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        reviewing = false;
        return candidates.map((candidate) => completeAudit(candidate, queries === 1 ? { eligible: false, subjectMatch: false, coreSubjectMatch: false, matchLevel: "mismatch", hardRejectCode: "subject_mismatch" } : {}));
      },
    },
  });
  assert.deepEqual(events, ["search1", "audit1", "search2", "audit2"]);
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].candidates.length, 2);
});
