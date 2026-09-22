import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeHierarchy, buildKnowledgeScopePlan, explicitEntityRoute, knowledgeSourcePathMatches, knowledgeEntityProbeEvidence, knowledgeEntityProbeAuditCandidate, resolveKnowledgeScope } from "../server/knowledge-scope-resolver.mjs";
import { AGENT_PROMPT_VERSION, buildAgentFactBasis, generateAgentPlan } from "../server/agent-trip-planner.mjs";
import { plannerRequestJson } from "./helpers/simple-pipeline-fixture.mjs";

const nodes = [
  { node_id: "root", formal_name: "Root" },
  { node_id: "country", formal_name: "Kenya", parent_node_id: "root" },
  { node_id: "region", formal_name: "Amboseli", parent_node_id: "country" },
  { node_id: "city", formal_name: "Nairobi", parent_node_id: "country" },
];
const tree = buildKnowledgeHierarchy(nodes);
const slot = { moduleType: "hotel", hotel: "Aurora Wilderness Lodge", exactIdentityRequired: true, country: "Kenya", location: "Amboseli", primaryVisualSubject: "酒店外观", queryCore: { subject: "酒店建筑", identity: "Aurora Wilderness Lodge", identityEn: "Aurora Wilderness Lodge" } };
const scopePlan = (value = slot, hierarchy = tree) => buildKnowledgeScopePlan(value, resolveKnowledgeScope(value, hierarchy), hierarchy);

test("专属实体目录缺失仅补查一个已确认地区，两条查询且身份保持必要", () => {
  const plan = scopePlan();
  assert.equal(plan.blockedReason, null);
  assert.equal(plan.stopBoundary, "entity_parent_probe");
  assert.equal(plan.explicitEntityFastPath.parentProbeUsed, true);
  assert.deepEqual(plan.scopes.map((item) => ({ role: item.role, mode: item.sourcePathMode, ids: item.resolution.nodeIds, maxQueries: item.maxQueries })), [
    { role: "entity_parent_probe", mode: "entity_probe", ids: ["region"], maxQueries: 2 },
  ]);
  assert.equal(slot.exactIdentityRequired, true);
  const attraction = scopePlan({ ...slot, moduleType: "day", hotel: undefined, queryCore: { subject: "观景台标牌", identity: "Observation Hill" } });
  assert.equal(attraction.scopes[0].role, "entity_parent_probe");
  assert.deepEqual(attraction.scopes[0].resolution.nodeIds, ["region"]);
});

test("国家、根目录、缺国家佐证或模糊地区均不能成为父级补查", () => {
  for (const location of ["Kenya", "Root", "Unconfirmed Valley"]) assert.equal(scopePlan({ ...slot, location }).blockedReason, "entity_directory_missing", location);
  const ambiguous = buildKnowledgeHierarchy([...nodes, { node_id: "duplicate", formal_name: "Amboseli", parent_node_id: "country" }]);
  assert.deepEqual(scopePlan(slot, ambiguous).scopes, []);
  assert.deepEqual(scopePlan({ ...slot, country: "Otherland" }).scopes, []);
  assert.equal(scopePlan({ ...slot, country: "" }).scopes[0].role, "entity_parent_probe", "地区Registry可证明国家归属");
  const unknownRegion = buildKnowledgeHierarchy([...nodes, { node_id: "unknown", formal_name: "Northern Valley", parent_node_id: "country" }]);
  assert.deepEqual(scopePlan({ ...slot, country: "", location: "Northern Valley" }, unknownRegion).scopes, []);
});

test("真实DAY形状可用结构化停留点和已确认国家补查纳瓦沙，不把酒店停留点当地区", () => {
  const hierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "Root" },
    { node_id: "country", formal_name: "Kenya", parent_node_id: "root" },
    { node_id: "naivasha", formal_name: "纳瓦沙湖", parent_node_id: "country" },
    { node_id: "sopa", formal_name: "Lake Naivasha Sopa Resort", parent_node_id: "naivasha" },
  ]);
  const day = {
    moduleType: "day", location: "东非大裂谷观景台", exactIdentityRequired: true,
    visualContext: { geographicLocation: "东非大裂谷观景台", scopeFallbackLocations: ["纳瓦沙湖", "Lake Naivasha Sopa Resort"] },
    queryCore: { identity: "东非大裂谷观景台", identityEn: "Great Rift Valley viewpoint", subjectEn: "Great Rift Valley landscape", actionEn: "overlooking" },
  };
  const resolved = resolveKnowledgeScope(day, hierarchy);
  assert.deepEqual(resolved.nodeIds, ["naivasha"]);
  const corroborated = { ...resolved, facts: [...resolved.facts, "Kenya"] };
  const plan = buildKnowledgeScopePlan(day, corroborated, hierarchy);
  assert.deepEqual(plan.scopes.map((scope) => scope.resolution.nodeIds[0]), ["naivasha"]);
  assert.equal(plan.scopes[0].sourcePathMode, "entity_probe");
  assert.equal(plan.scopes[0].maxQueries, 2);
  assert.equal(day.exactIdentityRequired, true);
  assert.deepEqual(buildKnowledgeScopePlan(day, resolved, hierarchy).scopes, [], "没有国家佐证时不猜");
  const proseOnly = { ...resolved, facts: [...resolved.facts, "Visit Kenya and its beautiful lakes"] };
  assert.deepEqual(buildKnowledgeScopePlan(day, proseOnly, hierarchy).scopes, [], "自由文字不能证明国家");
  const withDestination = { ...day, destination: "Kenya" };
  assert.deepEqual(scopePlan(withDestination, hierarchy).scopes[0].resolution.nodeIds, ["naivasha"]);
  const realShapeHierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库" },
    { node_id: "product", formal_name: "坦桑尼亚官方产品资料", parent_node_id: "root" },
    { node_id: "country", formal_name: "肯尼亚", parent_node_id: "product" },
    { node_id: "naivasha", formal_name: "纳瓦沙湖", parent_node_id: "country" },
    { node_id: "sopa", formal_name: "Lake Naivasha Sopa Resort", parent_node_id: "naivasha" },
  ]);
  const realShape = { ...day, destination: "肯尼亚", queryCore: { ...day.queryCore, identity: "东非大裂谷观景台" } };
  assert.deepEqual(scopePlan(realShape, realShapeHierarchy).scopes[0].resolution.nodeIds, ["naivasha"]);
  const ambiguous = { ...corroborated, status: "ambiguous", nodeIds: [] };
  assert.deepEqual(buildKnowledgeScopePlan(day, ambiguous, hierarchy).scopes, []);
});

test("实体快路由保持identity及布尔值契约，仅identityEn不能触发", () => {
  const english = { moduleType: "day", exactIdentityRequired: true, queryCore: { identity: "东非大裂谷观景台", identityEn: "Great Rift Valley viewpoint" } };
  assert.equal(explicitEntityRoute(english).matched, true);
  assert.equal(explicitEntityRoute(english).entityName, "东非大裂谷观景台");
  for (const exactIdentityRequired of [undefined, false, "true"]) {
    assert.equal(explicitEntityRoute({ ...english, exactIdentityRequired }).matched, false);
  }
  assert.equal(explicitEntityRoute({ ...english, queryCore: {} }).matched, false);
  assert.equal(explicitEntityRoute({ ...english, queryCore: { identityEn: "Great Rift Valley viewpoint" } }).matched, false);
  assert.equal(explicitEntityRoute({ ...english, queryCore: { subjectEn: "Great Rift Valley viewpoint" } }).matched, false);
});

test("已有实体目录保持Stay和根目录搜索，目录歧义不绕过消歧", () => {
  const hotel = { ...slot, hotel: "Angama Amboseli", primaryVisualSubject: "酒店客房", queryCore: { subject: "客房", identity: "Angama Amboseli" } };
  const hierarchy = buildKnowledgeHierarchy([...nodes,
    { node_id: "hotel", formal_name: "Angama Amboseli", parent_node_id: "region" },
    { node_id: "stay", formal_name: "Stay", parent_node_id: "hotel" },
  ]);
  const plan = scopePlan(hotel, hierarchy);
  assert.deepEqual(plan.scopes.map((item) => item.role), ["hotel_child", "hotel_root"]);
  assert.ok(plan.scopes.every((item) => item.sourcePathMode === "entity_identity"));
  const duplicate = buildKnowledgeHierarchy([...nodes,
    { node_id: "hotel1", formal_name: "Angama Amboseli", parent_node_id: "region" },
    { node_id: "hotel2", formal_name: "Angama Amboseli", parent_node_id: "region" },
  ]);
  assert.deepEqual(scopePlan(hotel, duplicate).scopes, []);
});

test("父地区路径不证明实体，完整同一别名不能拼接或只命中品牌", () => {
  const resolution = scopePlan().scopes[0].resolution;
  const check = (paths, anchors = [slot.queryCore.identity]) => knowledgeSourcePathMatches(resolution, paths, { mode: "entity_probe", identityAnchors: anchors });
  assert.equal(check(["Kenya/Amboseli/ordinary-photo.jpg"]).match, null);
  assert.equal(check(["Kenya/Amboseli/Aurora Wilderness Lodge/exterior.jpg"]).match, true);
  assert.equal(check(["Kenya/Amboseli/Aurora/Wilderness Lodge/exterior.jpg"]).match, null);
  assert.equal(check(["Kenya/Amboseli/Angama Mara/exterior.jpg"], ["Angama Amboseli"]).match, null);
  assert.equal(check(["Kenya/Amboseli/Saruni Leopard Hill/exterior.jpg"], ["Angama Amboseli"]).identityStatus, "conflict");
});

test("逐图证明仅来自绑定路径或文件名，不接受同结果共享描述和其他图片路径", () => {
  const candidate = {
    knowledgeSourcePathMode: "entity_probe", sourceKind: "knowledge_library",
    alt: "Aurora Wilderness Lodge", knowledgeFragmentContent: "Aurora Wilderness Lodge", semanticText: "Aurora Wilderness Lodge",
    knowledgeSourcePaths: ["Kenya/Amboseli/Aurora Wilderness Lodge/other.jpg", "Kenya/Amboseli/generic/hero.jpg"],
    knowledgePreview: { filename: "hero.jpg" },
  };
  assert.equal(knowledgeEntityProbeEvidence(slot, candidate).match, null);
  assert.equal(knowledgeEntityProbeEvidence(slot, { ...candidate, knowledgePreview: { filename: "Aurora-Wilderness-Lodge-exterior.jpg" } }).match, true);
  assert.equal(knowledgeEntityProbeEvidence(slot, { ...candidate, knowledgePreview: { filename: "hero.jpg", sourceDisplayPath: "Kenya/Amboseli/Aurora Wilderness Lodge/hero.jpg" } }).match, true);
  const mixed = { ...candidate, knowledgeSourcePaths: ["Kenya/Amboseli/Aurora Wilderness Lodge/hero.jpg", "Kenya/Amboseli/Other/hero.jpg"] };
  assert.equal(knowledgeEntityProbeEvidence(slot, mixed).match, null, "重复basename不能证明绑定关系");
  const wrongHotel = { ...candidate, knowledgePreview: { filename: "hero.jpg", sourceDisplayPath: "Kenya/Amboseli/Angama Amboseli/hero.jpg" } };
  assert.equal(knowledgeEntityProbeEvidence(slot, wrongHotel).identityStatus, "conflict");
  const splitName = { ...candidate, knowledgePreview: { filename: "hero.jpg", sourceDisplayPath: "Kenya/Amboseli/Aurora/Wilderness Lodge/hero.jpg" }, knowledgeSourcePaths: [] };
  assert.equal(knowledgeEntityProbeEvidence(slot, splitName).match, null);
});

test("父级补查不接受缺物业地点的品牌简称", () => {
  const jw = { ...slot, hotel: "JW Marriott Hotel Nairobi", location: "Nairobi", queryCore: { identity: "JW Marriott Hotel Nairobi" } };
  assert.ok(!scopePlan(jw).scopes[0].identityAnchors.includes("JW 万豪"));
  assert.equal(knowledgeEntityProbeEvidence(jw, { knowledgePreview: { filename: "JW 万豪.jpg" } }).match, null);
  assert.equal(knowledgeEntityProbeEvidence(jw, { knowledgePreview: { filename: "内罗毕JW万豪.jpg" } }).match, true);
});

test("送Vision前清除共享片段与父页面身份，保留当前图片路径和文件", () => {
  const candidate = {
    candidateId: "photo-1", knowledgeSourcePathMode: "entity_probe", sourceKind: "knowledge_library", filePath: "fixture.jpg", publicUrl: "/fixture.jpg",
    alt: "shared entity", imageTitle: "shared", caption: "shared", structuredImageText: "shared", localContext: "shared", entitySectionText: "shared",
    entityPagePath: "/shared-entity", pageUrl: "https://example.test/shared-entity", summary: "shared", semanticText: "query entity", knowledgeFragmentContent: "shared",
    knowledgePreview: { filename: "hero.jpg", sourceDisplayPath: "Kenya/Amboseli/Aurora Wilderness Lodge/hero.jpg" },
    knowledgeSourcePaths: ["Kenya/Amboseli/Other/other.jpg"],
  };
  const sanitized = knowledgeEntityProbeAuditCandidate(candidate);
  for (const key of ["imageTitle", "caption", "structuredImageText", "localContext", "entitySectionText", "entityPagePath", "pageUrl", "summary", "semanticText", "knowledgeFragmentContent"]) assert.equal(sanitized[key], "", key);
  assert.equal(sanitized.alt, "hero.jpg");
  assert.deepEqual(sanitized.knowledgeSourcePaths, [candidate.knowledgePreview.sourceDisplayPath]);
  assert.equal(sanitized.filePath, candidate.filePath);
  assert.equal(candidate.alt, "shared entity", "不改审计原记录");
  const ordinary = { ...candidate, knowledgeSourcePathMode: "entity_identity" };
  assert.equal(knowledgeEntityProbeAuditCandidate(ordinary), ordinary, "既有专属目录不改行为");
});

test("Planner在同一次请求明确区分裂谷地貌与唯一观景台身份", async () => {
  let calls = 0;
  const factBasis = buildAgentFactBasis({ destination: "Kenya", days: [{ description: "在观景台眺望裂谷地貌" }] });
  await generateAgentPlan({ project: { projectId: "landscape-identity-contract", inputFingerprint: "fixture", factBasis }, simpleSkillContract: true, requestJson: async (options) => {
    calls += 1;
    const prompt = options.messages[0].content;
    assert.match(prompt, /Core是地貌主体/);
    assert.match(prompt, /特定观景台的建筑、入口、标牌/);
    assert.match(prompt, /地区路径也不能证明照片就是该平台/);
    assert.match(prompt, /不扩到国家或根目录/);
    return plannerRequestJson({ delayMs: 0 })(options);
  } });
  assert.equal(calls, 1);
  assert.match(AGENT_PROMPT_VERSION, /landscape-identity-boundary/);
});
