import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKnowledgeHierarchy,
  buildKnowledgeQuery,
  buildKnowledgeQueryPlan,
  buildKnowledgeScopePlan,
  classifyKnowledgeImagePurpose,
  knowledgeSourcePathMatches,
  resolveKnowledgeChildScope,
  resolveKnowledgeClarification,
  resolveKnowledgeScope,
} from "../server/knowledge-scope-resolver.mjs";

const hierarchy = buildKnowledgeHierarchy([
  { node_id: "root", formal_name: "根知识库", parent_node_id: null },
  { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
  { node_id: "tanzania", formal_name: "坦桑尼亚", parent_node_id: "root" },
  { node_id: "amboseli", formal_name: "安博塞利", parent_node_id: "kenya" },
  { node_id: "observation-hill", formal_name: "Observation Hill", parent_node_id: "amboseli" },
  { node_id: "masai-mara", formal_name: "马赛马拉", parent_node_id: "kenya" },
  { node_id: "nairobi", formal_name: "内罗毕", parent_node_id: "kenya" },
  { node_id: "giraffe-centre", formal_name: "Giraffe Centre", parent_node_id: "nairobi" },
  { node_id: "ritz", formal_name: "Ritz Carton", parent_node_id: "masai-mara" },
  { node_id: "serengeti", formal_name: "塞伦盖蒂", parent_node_id: "tanzania" },
  { node_id: "samburu", formal_name: "桑布鲁", parent_node_id: "kenya" },
  { node_id: "angama", formal_name: "AngamaAmboseli", parent_node_id: "amboseli" },
  { node_id: "angama-stay", formal_name: "Stay", parent_node_id: "angama" },
  { node_id: "angama-food", formal_name: "Food", parent_node_id: "angama" },
  { node_id: "angama-activities", formal_name: "Wilderness & Safari", parent_node_id: "angama" },
  { node_id: "angama-balloon", formal_name: "Ballooning", parent_node_id: "angama-activities" },
  { node_id: "jw", formal_name: "JW Marriot Hotel Nairobi", parent_node_id: "kenya" },
  { node_id: "saruni-mara", formal_name: "Saruni", parent_node_id: "masai-mara" },
  { node_id: "saruni-samburu", formal_name: "Saruni", parent_node_id: "samburu" },
]);

test("酒店、地区和轻微目录拼写差异均通过真实上下文确定性解析", () => {
  const hotel = resolveKnowledgeScope({ moduleType: "hotel", hotel: "Angama Amboseli", location: "Amboseli" }, hierarchy);
  assert.equal(hotel.status, "resolved");
  assert.deepEqual(hotel.nodeIds, ["angama"]);

  const region = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利", primaryVisualSubject: "象群与乞力马扎罗雪峰" }, hierarchy);
  assert.deepEqual(region.nodeIds, ["amboseli"]);

  const typo = resolveKnowledgeScope({ moduleType: "hotel", hotel: "JW Marriott Hotel Nairobi", location: "Nairobi" }, hierarchy);
  assert.deepEqual(typo.nodeIds, ["jw"]);

  const abbreviatedTypo = resolveKnowledgeScope({ moduleType: "hotel", hotel: "The Ritz-Carlton, Masai Mara Safari Camp", location: "Masai Mara" }, hierarchy);
  assert.deepEqual(abbreviatedTypo.nodeIds, ["ritz"]);

  const duplicateBrand = resolveKnowledgeScope({ moduleType: "hotel", hotel: "Saruni Leopard Hill", location: "Kenya" }, hierarchy);
  assert.deepEqual(duplicateBrand.nodeIds, ["saruni-mara"]);
});

test("消歧只在候选节点中选择唯一事实匹配，无法唯一时保持未解决", () => {
  const resolved = resolveKnowledgeClarification({ moduleType: "day", location: "安博塞利" }, ["amboseli", "serengeti"], hierarchy);
  assert.deepEqual(resolved.nodeIds, ["amboseli"]);

  const unresolved = resolveKnowledgeClarification({ moduleType: "day", subject: "草原风景" }, ["amboseli", "serengeti"], hierarchy);
  assert.notEqual(unresolved.status, "resolved");
});

test("持久映射必须由当前 Slot 事实重新验证，不能让旧节点覆盖当前地点", () => {
  const corrected = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利" }, hierarchy, { cachedNodeId: "kenya" });
  assert.deepEqual(corrected.nodeIds, ["amboseli"]);
  assert.equal(corrected.reason, "unique_hierarchy_match");

  const validated = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利" }, hierarchy, { cachedNodeId: "amboseli" });
  assert.equal(validated.reason, "persistent_mapping_validated");
});

test("中文地点嵌入业务后缀时仍可确定性解析到已有地区节点", () => {
  const result = resolveKnowledgeScope({ moduleType: "day", location: "马赛马拉核心区" }, hierarchy);
  assert.deepEqual(result.nodeIds, ["masai-mara"]);

  const conservancy = resolveKnowledgeScope({ moduleType: "day", location: "Naboisho私人保护区中心", region: "Naboisho Conservancy" }, hierarchy);
  assert.deepEqual(conservancy.nodeIds, ["masai-mara"]);
});

test("酒店模块使用固定高价值类别Query，不重复酒店名或Planner长画面", () => {
  const slot = { moduleType: "hotel", hotel: "Angama Amboseli", subject: "酒店泳池", location: "安博塞利", locationRole: "scope_only", visualGoal: "与徒步游猎图片形成差异", fidelityQuery: "酒店泳池", alternateQueries: ["度假酒店泳池", "hotel pool"], queryCore: { subject: "酒店泳池", subjectEn: "hotel pool" } };
  const scope = resolveKnowledgeScope(slot, hierarchy);
  assert.equal(buildKnowledgeQuery(slot, scope), "酒店外观");
  assert.deepEqual(buildKnowledgeQueryPlan(slot, scope).queries, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
  assert.equal(buildKnowledgeQueryPlan(slot, scope).strategy, "sequential_hotel_value_categories_until_selected");
  assert.deepEqual(buildKnowledgeQueryPlan(slot, scope).plannerQueries, []);
  assert.ok(buildKnowledgeQueryPlan(slot, scope).queries.every((query) => !query.includes("Angama")));
});

test("scope_only只删除真实地点及别名，保留体验身份、英文Query与原顺序", () => {
  const walking = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "安博塞利",
    locationRole: "scope_only",
    primaryVisualSubject: "向导带队步行Safari",
    queryCore: { subject: "步行Safari", action: "徒步", identity: "步行Safari", subjectEn: "walking safari", actionEn: "hiking", identityEn: "walking safari" },
    fidelityQuery: "步行Safari 徒步 草原 向导",
    alternateQueries: ["徒步游猎 草原", "walking safari guide savanna"],
  }, null);
  assert.deepEqual(walking.queries, ["步行Safari 徒步 草原 向导", "徒步游猎 草原", "walking safari guide savanna"]);
  assert.ok(walking.querySteps.every((step) => step.scopeCleanup === false && step.originalQuery === step.finalQuery));

  const scoped = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "马赛马拉",
    locationRole: "scope_only",
    primaryVisualSubject: "追踪狮群与猎豹",
    queryCore: { subject: "狮群与猎豹", action: "追踪", identity: "游猎" },
    fidelityQuery: "狮群 猎豹 游猎 追踪",
    alternateQueries: ["非洲狮 猎豹 草原 游猎车", "lion cheetah safari Masai Mara"],
  }, null);
  assert.deepEqual(scoped.queries, ["狮群 猎豹 游猎 追踪", "非洲狮 猎豹 草原 游猎车", "lion cheetah safari"]);
  assert.deepEqual(scoped.querySteps[2], {
    query: "lion cheetah safari",
    source: "planner",
    level: "broadened",
    coreVisualTarget: "追踪狮群与猎豹",
    originalQuery: "lion cheetah safari Masai Mara",
    scopeCleanup: true,
    removedScopeLocations: ["Masai Mara"],
    finalQuery: "lion cheetah safari",
  });
});

test("非酒店模块的visual_identity命名实体Query仍原样保留", () => {
  const slot = {
    moduleType: "day",
    location: "内罗毕",
    locationRole: "visual_identity",
    primaryVisualSubject: "Karen Blixen Museum建筑",
    queryCore: { subject: "博物馆建筑", identity: "Karen Blixen Museum" },
    fidelityQuery: "Karen Blixen Museum building",
    alternateQueries: ["Karen Blixen Museum exterior", "凯伦故居博物馆建筑"],
  };
  const plan = buildKnowledgeQueryPlan(slot, null);
  assert.deepEqual(plan.queries, [slot.fidelityQuery, ...slot.alternateQueries]);
  assert.ok(plan.querySteps.every((step) => step.source === "planner" && step.originalQuery === step.finalQuery));
});

test("Planner负责语义理解，Query Builder只移除真实Scope地点并保留可见实体", () => {
  const walking = buildKnowledgeQueryPlan({ moduleType: "day", location: "Masai Mara", primaryVisualSubject: "Walking Safari", activity: "徒步游猎", searchIntent: ["步行游猎", "丛林徒步", "walking safari", "guided bush walk"] }, null).queries;
  assert.deepEqual(walking, ["步行游猎", "丛林徒步", "walking safari", "guided bush walk"]);
  assert.ok(walking.every((query) => !/safari vehicle|game drive/i.test(query)));

  const predators = buildKnowledgeQueryPlan({ moduleType: "day", location: "Masai Mara", primaryVisualSubject: "Masai Mara lion / cheetah", activity: "狮群与猎豹游猎", searchIntent: ["猎豹游猎", "狮群游猎", "cheetah safari", "lion pride safari"] }, null).queries;
  assert.deepEqual(predators, ["猎豹游猎", "狮群游猎", "cheetah safari", "lion pride safari"]);
  assert.ok(predators.every((query) => !/predator/i.test(query)));
  assert.ok(predators.every((query) => !/maasai village/i.test(query)));

  const starBed = buildKnowledgeQueryPlan({ moduleType: "day", location: "Masai Mara", primaryVisualSubject: "Star Bed", activity: "星空床", searchIntent: ["星空床户外住宿", "户外星空床", "star bed sleep out", "outdoor sleep out bed"] }, null).queries;
  assert.deepEqual(starBed, ["星空床户外住宿", "户外星空床", "star bed sleep out", "outdoor sleep out bed"]);
  assert.ok(starBed.every((query) => !/maasai village/i.test(query)));

  const carnivore = buildKnowledgeQueryPlan({ moduleType: "dining", location: "Nairobi", locationRole: "visual_identity", diningLocation: "The Carnivore", primaryVisualSubject: "The Carnivore 特色烤肉晚餐", searchIntent: ["特色烤肉上桌", "The Carnivore餐厅用餐", "The Carnivore restaurant"] }, null).queries;
  assert.equal(carnivore[0], "特色烤肉上桌");
  assert.match(carnivore.join(" "), /The Carnivore/i);
  assert.doesNotMatch(carnivore.join(" "), /Nairobi/i);

  const carnivoreDay = buildKnowledgeQueryPlan({ moduleType: "day", location: "Nairobi", primaryVisualSubject: "The Carnivore 百兽宴晚餐", searchIntent: ["百兽宴晚餐", "特色烤肉上桌", "game meat dinner", "grilled meat served"] }, null).queries;
  assert.deepEqual(carnivoreDay, ["百兽宴晚餐", "特色烤肉上桌", "game meat dinner", "grilled meat served"]);

  const museum = buildKnowledgeQueryPlan({ moduleType: "day", location: "Nairobi", locationRole: "scope_only", primaryVisualSubject: "博物馆参观", activity: "博物馆参观", queryCore: { subject: "博物馆", action: "参观", identity: "Karen Blixen Museum" }, fidelityQuery: "博物馆参观", alternateQueries: ["博物馆建筑"] }, null).queries;
  assert.deepEqual(museum, ["博物馆参观", "博物馆建筑"]);
  assert.doesNotMatch(museum.join(" "), /凯伦|Karen Blixen|Nairobi/i);
});

test("Knowledge Query 不读取 visualDuty，说明性文字不会进入查询", () => {
  const atmosphere = buildKnowledgeQueryPlan({
    moduleType: "day",
    primaryVisualSubject: "星空床打开屋顶仰望非洲星空",
    activity: "星空床体验",
    searchIntent: ["星空床户外住宿", "户外星空床", "star bed sleep out", "outdoor sleep out bed"],
    visualDuty: "证明当天核心体验并区别其他图片，保留自费状态",
  }, null);
  assert.equal(atmosphere.visualTarget.coreVisualTarget, "星空床打开屋顶仰望非洲星空");
  assert.equal(atmosphere.visualTarget.representativeAllowed, true);
  assert.equal(atmosphere.queries[0], "星空床户外住宿");
  assert.deepEqual(atmosphere.queries, ["星空床户外住宿", "户外星空床", "star bed sleep out", "outdoor sleep out bed"]);
  assert.doesNotMatch(atmosphere.queries.join(" "), /证明当天|区别其他|保留自费/);
  assert.ok(atmosphere.querySteps.every((step) => step.coreVisualTarget === atmosphere.visualTarget.coreVisualTarget));

  const walking = buildKnowledgeQueryPlan({
    moduleType: "day",
    primaryVisualSubject: "持枪向导带队步行Safari",
    activity: "步行Safari",
    searchIntent: ["持枪向导步行", "向导带队徒步", "armed guide walking safari"],
    visualDuty: "突出持枪向导带队步行Safari",
  }, null).queries;
  assert.ok(walking.every((query) => /持枪|向导|armed|guide|ranger/i.test(query)));

  const balloon = buildKnowledgeQueryPlan({
    moduleType: "day",
    primaryVisualSubject: "热气球俯瞰草原日出与迁徙兽群",
    activity: "热气球之旅",
    searchIntent: ["热气球草原日出", "热气球迁徙兽群", "hot air balloon safari"],
    visualDuty: "表达热气球俯瞰草原日出与迁徙兽群",
  }, null).queries;
  assert.ok(balloon.every((query) => /热气球|hot air balloon/i.test(query)));

  const facilityProof = buildKnowledgeQueryPlan({
    moduleType: "day",
    hotel: "Example Lodge",
    primaryVisualSubject: "Example Lodge专属星空床打开屋顶仰望非洲星空",
    activity: "星空床体验",
    searchIntent: ["酒店星空床", "星空床设施", "star bed lodge"],
    visualDuty: "确认并展示酒店专属星空床设施",
  }, null);
  assert.equal(facilityProof.visualTarget.representativeAllowed, false);
  assert.ok(!facilityProof.queries.includes("仰望非洲星空"));
});

test("酒店空间图先进入唯一明确的空间子目录，再回酒店根 scope", () => {
  const hotelRoot = resolveKnowledgeScope({ moduleType: "hotel", hotel: "Angama Amboseli", subject: "Angama Amboseli" }, hierarchy);
  const representative = resolveKnowledgeChildScope({ moduleType: "hotel", hotel: "Angama Amboseli", subject: "Angama Amboseli" }, hotelRoot, hierarchy);
  assert.equal(representative.decision.entered, true);
  assert.deepEqual(representative.scopeResolution.nodeIds, ["angama-stay"]);

  const dining = resolveKnowledgeChildScope({ moduleType: "dining", hotel: "Angama Amboseli", subject: "Bush Breakfast", activity: "草原早餐" }, hotelRoot, hierarchy);
  assert.equal(dining.decision.entered, true);
  assert.equal(dining.decision.category, "dining");
  assert.deepEqual(dining.scopeResolution.nodeIds, ["angama-food"]);

  const balloon = resolveKnowledgeChildScope({ moduleType: "day", hotel: "Angama Amboseli", subject: "Hot Air Balloon", activity: "热气球" }, hotelRoot, hierarchy);
  assert.equal(balloon.decision.entered, true);
  assert.deepEqual(balloon.scopeResolution.nodeIds, ["angama-activities"]);
});

test("多个同等合理酒店子目录时保持酒店根节点，不猜目录", () => {
  const ambiguousHierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "root" },
    { node_id: "amboseli", formal_name: "安博塞利", parent_node_id: "kenya" },
    { node_id: "angama", formal_name: "AngamaAmboseli", parent_node_id: "amboseli" },
    { node_id: "food", formal_name: "Food", parent_node_id: "angama" },
    { node_id: "dining", formal_name: "Dining", parent_node_id: "angama" },
  ]);
  const rootScope = resolveKnowledgeScope({ moduleType: "dining", hotel: "Angama Amboseli", subject: "Bush Breakfast" }, ambiguousHierarchy);
  const result = resolveKnowledgeChildScope({ moduleType: "dining", hotel: "Angama Amboseli", subject: "Bush Breakfast" }, rootScope, ambiguousHierarchy);
  assert.equal(result.decision.entered, false);
  assert.equal(result.decision.reason, "multiple_equally_plausible_child_scopes");
  assert.deepEqual(result.scopeResolution.nodeIds, ["angama"]);
});

test("封面只生成目的地代表性方向，不引入历史持久化", () => {
  const plan = buildKnowledgeQueryPlan({ moduleType: "cover", location: "Amboseli", subject: "目的地封面", searchIntent: ["草原野生动物", "草原象群", "savanna wildlife"] }, null);
  assert.deepEqual(plan.queries, ["草原野生动物", "草原象群", "savanna wildlife"]);
  assert.equal(plan.strategy, "planner_queries");
});

test("六类图片用途都只执行Planner给出的2至4条短Query", () => {
  const fields = (subject, first, second, extras = {}) => ({
    primaryVisualSubject: subject,
    location: extras.location || "示例地区",
    locationRole: extras.locationRole || "scope_only",
    queryCore: { subject: first, action: "", identity: extras.identity || "" },
    fidelityQuery: first,
    alternateQueries: [second],
    ...extras,
  });
  const cases = [
    [{ moduleType: "hotel", hotel: "Example Lodge", ...fields("酒店泳池", "酒店泳池", "hotel pool") }, "hotel_space"],
    [{ moduleType: "dining", hotel: "Example Lodge", ...fields("私人酒窖品酒", "酒窖品酒", "wine cellar tasting") }, "hotel_experience"],
    [{ moduleType: "day", ...fields("象群与远山", "象群与远山", "elephants and mountains", { location: "Example Reserve" }) }, "destination_experience"],
    [{ moduleType: "day", ...fields("Karen Blixen Museum建筑", "Karen Blixen Museum building", "museum exterior", { location: "Nairobi", locationRole: "visual_identity", identity: "Karen Blixen Museum" }) }, "explicit_entity"],
    [{ moduleType: "transport", ...fields("草原飞机接驳", "草原飞机", "bush plane") }, "transport"],
    [{ moduleType: "cover", ...fields("草原野生动物", "草原野生动物", "savanna wildlife", { location: "Example Country" }) }, "cover"],
  ];
  for (const [slot, purpose] of cases) {
    const plan = buildKnowledgeQueryPlan(slot, null);
    assert.equal(classifyKnowledgeImagePurpose(slot), purpose);
    assert.ok(plan.queries.length >= 2 && plan.queries.length <= 4);
    if (slot.moduleType === "hotel") assert.deepEqual(plan.queries, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
    else assert.deepEqual(plan.queries, [slot.fidelityQuery, ...slot.alternateQueries]);
  }
});

test("不同图片用途统一优先采用Planner的2至4条短Query", () => {
  const cases = [
    { moduleType: "hotel", hotel: "Example Lodge", subject: "酒店泳池", searchIntent: ["酒店泳池", "度假酒店泳池", "hotel pool"] },
    { moduleType: "dining", subject: "草原丛林早餐", searchIntent: ["草原早餐", "户外早餐", "bush breakfast"] },
    { moduleType: "day", location: "Amboseli", subject: "湿地象群", searchIntent: ["湿地象群", "俯瞰湿地象群", "elephants in wetlands"] },
    { moduleType: "transport", subject: "草原小型飞机", searchIntent: ["草原小型飞机", "小型飞机接驳", "bush plane"] },
  ];
  for (const slot of cases) {
    const plan = buildKnowledgeQueryPlan(slot, null);
    if (slot.moduleType === "hotel") {
      assert.deepEqual(plan.queries, ["酒店外观", "酒店套房", "酒店泳池", "酒店公共空间"]);
      assert.deepEqual(plan.plannerQueries, []);
      assert.equal(plan.strategy, "sequential_hotel_value_categories_until_selected");
    } else {
      assert.deepEqual(plan.queries, slot.searchIntent);
      assert.deepEqual(plan.plannerQueries, slot.searchIntent);
      assert.deepEqual(plan.fallbackQueries, []);
      assert.equal(plan.strategy, "planner_queries");
    }
  }
});

test("封面Scope继续来自已确认行程实体，Query来自Planner", () => {
  const slot = { moduleType: "cover", location: "Kenya", routeNodes: ["Amboseli", "Masai Mara"], subject: "Amboseli象群与雪山", searchIntent: ["象群与雪山", "草原象群", "elephants Kilimanjaro", "elephant herd snow mountain"] };
  const scope = resolveKnowledgeScope(slot, hierarchy);
  const scopePlan = buildKnowledgeScopePlan(slot, scope, hierarchy);
  assert.deepEqual(scopePlan.scopes.map((item) => item.resolution.nodeIds[0]), ["kenya"]);
  assert.equal(scopePlan.scopes[0].sourcePathMode, "country_context");
  assert.deepEqual(buildKnowledgeQueryPlan(slot, scopePlan.scopes[0].resolution).queries, slot.searchIntent);
});

test("Query Builder完全忽略 visualGoal 与相邻图片差异说明", () => {
  const viewpoint = buildKnowledgeQueryPlan({ moduleType: "day", subject: "Angama专属观景台看日落", activity: "观景台日落", searchIntent: ["日落观景台", "sunset scenic viewpoint", "sunset observation deck"], visualGoal: "与主图象群不同，并区别马拉河迁徙" }, null);
  assert.deepEqual(viewpoint.queries, ["日落观景台", "sunset scenic viewpoint", "sunset observation deck"]);
  const breakfast = buildKnowledgeQueryPlan({ moduleType: "day", subject: "马拉草原丛林早餐", searchIntent: ["草原丛林早餐", "草原户外早餐", "bush breakfast", "outdoor breakfast savanna"], visualGoal: "不同于角马大迁徙主图" }, null);
  assert.deepEqual(breakfast.queries, ["草原丛林早餐", "草原户外早餐", "bush breakfast", "outdoor breakfast savanna"]);
});

test("Observation Hill 只是拍摄位置时搜索湿地象群，只有景点本体才要求实体身份", () => {
  const experienceSlot = {
    moduleType: "day",
    location: "Observation Hill / 安博塞利",
    primaryVisualSubject: "Observation Hill山顶俯瞰湿地与象群",
    subject: "Observation Hill山顶俯瞰湿地与象群",
    searchIntent: ["湿地象群", "山顶俯瞰湿地象群", "elephants in wetlands", "wetland elephants from viewpoint"],
    visualDuty: "证明当天独特视角并区别其他图片",
  };
  assert.equal(classifyKnowledgeImagePurpose(experienceSlot), "destination_experience");
  assert.deepEqual(buildKnowledgeQueryPlan(experienceSlot, null).queries, ["湿地象群", "山顶俯瞰湿地象群", "elephants in wetlands", "wetland elephants from viewpoint"]);

  const identitySlot = { moduleType: "day", location: "安博塞利", subject: "Observation Hill入口标牌", searchIntent: ["观景山入口", "观景山标牌", "Observation Hill entrance"] };
  assert.equal(classifyKnowledgeImagePurpose(identitySlot), "explicit_entity");
  assert.match(buildKnowledgeQueryPlan(identitySlot, null).queries[0], /观景山/);
});

test("游船与动物组合生成2至4条中文优先、英文随后短查询", () => {
  assert.deepEqual(buildKnowledgeQueryPlan({ moduleType: "transport", subject: "游船", activity: "游船", searchIntent: ["游船", "观光游船", "boat ride", "safari boat"] }, null).queries,
    ["游船", "观光游船", "boat ride", "safari boat"]);
  assert.deepEqual(buildKnowledgeQueryPlan({ moduleType: "day", subject: "度假村内游猎遇长颈鹿与水羚", searchIntent: ["长颈鹿与水羚", "长颈鹿", "水羚", "giraffe waterbuck"] }, null).queries,
    ["长颈鹿与水羚", "长颈鹿", "水羚", "giraffe waterbuck"]);
  assert.deepEqual(buildKnowledgeQueryPlan({ moduleType: "day", subject: "新月岛上斑马与长颈鹿自由漫步", searchIntent: ["斑马与长颈鹿自由漫步", "斑马自由漫步", "长颈鹿自由漫步", "zebra giraffe roaming"] }, null).queries,
    ["斑马与长颈鹿自由漫步", "斑马自由漫步", "长颈鹿自由漫步", "zebra giraffe roaming"]);
  assert.deepEqual(buildKnowledgeQueryPlan({ moduleType: "day", subject: "游船追踪湖中河马家族", searchIntent: ["游船追踪河马", "游船观赏河马", "boat safari hippos", "hippo boat ride"] }, null).queries,
    ["游船追踪河马", "游船观赏河马", "boat safari hippos", "hippo boat ride"]);
});

test("未知体验只从Planner拆好的queryCore补救，不读取完整画面长句", () => {
  const slot = {
    moduleType: "day",
    location: "云岭保护区",
    primaryVisualSubject: "云岭保护区夜间追踪发光甲虫",
    subject: "云岭保护区夜间追踪发光甲虫",
    activity: "云岭保护区夜间追踪发光甲虫",
    locationRole: "scope_only",
    queryCore: { subject: "发光甲虫", action: "追踪", subjectEn: "glowworm", actionEn: "tracking" },
    fidelityQuery: "证明当天核心体验并区别于其他图片",
    alternateQueries: ["glowworm tracking"],
    visualDuty: "证明当天核心体验并区别于其他图片，保留自费状态",
  };
  const plan = buildKnowledgeQueryPlan(slot, null);
  const queries = plan.queries;
  assert.deepEqual(queries, ["发光甲虫追踪", "glowworm tracking"]);
  assert.deepEqual(plan.plannerQueries, ["glowworm tracking"]);
  assert.deepEqual(plan.fallbackQueries, ["发光甲虫追踪"]);
  assert.ok(queries.length >= 2 && queries.length <= 4);
  assert.ok(queries.every((query) => !/^(?:landscape|experience|view|activity)$/i.test(query)));
});

test("说明性Query被拒绝后只用queryCore修复，不退回primaryVisualSubject", () => {
  const plan = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "云岭保护区",
    primaryVisualSubject: "证明当天核心体验；补充体验；区别于其他图片；保留自费状态；体现核心体验；当日最具视觉价值；云岭保护区夜间追踪发光甲虫",
    subject: "云岭保护区夜间追踪发光甲虫",
    activity: "夜间追踪发光甲虫",
    locationRole: "scope_only",
    queryCore: { subject: "发光甲虫", action: "追踪", subjectEn: "glowworm", actionEn: "tracking" },
    fidelityQuery: "补充当天体验",
    alternateQueries: ["glowworm tracking"],
    visualDuty: "证明当天最具视觉价值",
    visualGoal: "区别于其他图片并保留自费状态",
  }, null);
  assert.deepEqual(plan.queries, ["发光甲虫追踪", "glowworm tracking"]);
  assert.ok(plan.queries.every((query) => query !== plan.visualTarget.coreVisualTarget));
  assert.doesNotMatch(plan.queries.join(" "), /证明当天|补充体验|区别于其他图片|保留自费状态|体现核心体验|当日最具视觉价值/);
});

test("最细地点不存在时按父级地区再到国家规划Scope，不进入知识库根目录", () => {
  const genericHierarchy = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "country", formal_name: "示例国", parent_node_id: "root" },
    { node_id: "region", formal_name: "北境湖区", parent_node_id: "country" },
  ]);
  const slot = {
    moduleType: "day",
    location: "云影峡谷",
    country: "示例国",
    primaryVisualSubject: "悬索桥下追踪发光甲虫",
    visualContext: { scopeFallbackLocations: ["北境湖区"] },
  };
  const resolved = resolveKnowledgeScope(slot, genericHierarchy);
  assert.deepEqual(resolved.nodeIds, ["region"]);
  const plan = buildKnowledgeScopePlan(slot, resolved, genericHierarchy);
  assert.deepEqual(plan.scopes.map((item) => item.resolution.nodeIds[0]), ["region", "country"]);
  assert.ok(plan.scopes.every((item) => item.resolution.nodeIds[0] !== "root"));
});

test("资料容器不能被识别为国家，地区只放宽到真实国家节点", () => {
  const nested = buildKnowledgeHierarchy([
    { node_id: "root", formal_name: "根知识库", parent_node_id: null },
    { node_id: "container", formal_name: "坦桑尼亚官方产品资料", parent_node_id: "root" },
    { node_id: "kenya", formal_name: "肯尼亚", parent_node_id: "container" },
    { node_id: "amboseli", formal_name: "安博塞利", parent_node_id: "kenya" },
  ]);
  const slot = { moduleType: "day", location: "安博塞利", subject: "象群", visualContext: { destination: "肯尼亚" } };
  const scope = resolveKnowledgeScope(slot, nested);
  const plan = buildKnowledgeScopePlan(slot, scope, nested);
  assert.deepEqual(plan.scopes.map((item) => item.resolution.nodeIds[0]), ["amboseli", "kenya"]);
  assert.ok(plan.scopes.every((item) => item.resolution.nodeIds[0] !== "container"));
});

test("普通餐饮体验不因当天酒店自动锁店，明确酒店专属体验仍锁定酒店", () => {
  const diningSlot = { moduleType: "dining", location: "The Ritz-Carlton, Masai Mara Safari Camp", subject: "Bush Breakfast", activity: "丛林早餐" };
  const diningRoot = resolveKnowledgeScope(diningSlot, hierarchy);
  const diningPlan = buildKnowledgeScopePlan(diningSlot, diningRoot, hierarchy);
  assert.equal(classifyKnowledgeImagePurpose(diningSlot), "destination_experience");
  assert.deepEqual(diningPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["masai-mara", "kenya"]);
  assert.equal(diningPlan.stopBoundary, "country");

  const hotelDiningSlot = { moduleType: "dining", hotel: "The Ritz-Carlton, Masai Mara Safari Camp", location: "马赛马拉", subject: "Ritz-Carlton 私人酒窖品酒", activity: "私人酒窖品酒" };
  const hotelDiningRoot = resolveKnowledgeScope(hotelDiningSlot, hierarchy);
  const hotelDiningPlan = buildKnowledgeScopePlan(hotelDiningSlot, hotelDiningRoot, hierarchy);
  assert.equal(classifyKnowledgeImagePurpose(hotelDiningSlot), "hotel_experience");
  assert.deepEqual(hotelDiningPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["ritz"]);
  assert.equal(hotelDiningPlan.stopBoundary, "hotel_root");

  const exclusiveSlot = { moduleType: "day", location: "安博塞利", subject: "Angama专属观景台日落", activity: "Angama专属观景台日落", visualContext: { routeNodes: ["Angama Amboseli"] } };
  const exclusiveRoot = resolveKnowledgeScope(exclusiveSlot, hierarchy);
  const exclusivePlan = buildKnowledgeScopePlan(exclusiveSlot, exclusiveRoot, hierarchy);
  assert.equal(classifyKnowledgeImagePurpose(exclusiveSlot), "hotel_experience");
  assert.deepEqual(exclusivePlan.scopes.map((item) => item.resolution.nodeIds[0]), ["angama"]);
  assert.equal(exclusivePlan.childScopeDecision.rootIncludesSelectedChild, true);
});

test("真实Planner长画面均提供短Query，Builder不再从完整原句自行拆词", () => {
  const cases = [
    { primaryVisualSubject: "黄昏金光下帐篷营地对望雪山", queryCore: { subject: "帐篷营地与雪山", subjectEn: "tented camp and mountain" }, fidelityQuery: "帐篷营地与雪山", alternateQueries: ["帐篷营地", "tented camp mountain"] },
    { primaryVisualSubject: "夜间观景台旁河马上岸觅食", queryCore: { subject: "河马", action: "上岸觅食", subjectEn: "hippo", actionEn: "coming ashore to feed" }, fidelityQuery: "河马上岸觅食", alternateQueries: ["河马上岸", "hippo coming ashore"] },
    { primaryVisualSubject: "草原星空下的篝火晚餐", queryCore: { subject: "篝火晚餐", subjectEn: "campfire dinner" }, fidelityQuery: "篝火晚餐", alternateQueries: ["草原篝火用餐", "campfire dinner"] },
    { primaryVisualSubject: "护林员带领徒步识别动物足迹与粪便", queryCore: { subject: "护林员", action: "徒步识别动物足迹", subjectEn: "ranger", actionEn: "wildlife tracking on foot" }, fidelityQuery: "护林员徒步追踪", alternateQueries: ["动物足迹识别", "wildlife tracking"] },
  ];
  for (const item of cases) {
    const expected = [item.fidelityQuery, ...item.alternateQueries];
    const plan = buildKnowledgeQueryPlan({ moduleType: "day", location: "示例地区", locationRole: "scope_only", ...item }, null);
    assert.deepEqual(plan.queries, expected);
    assert.deepEqual(plan.plannerQueries, expected);
    assert.deepEqual(plan.fallbackQueries, []);
    assert.equal(plan.strategy, "planner_queries");
    assert.ok(plan.queries.length >= 2 && plan.queries.length <= 4);
    assert.ok(plan.queries.every((query) => query !== item.primaryVisualSubject));
    assert.ok(plan.queries.every((query) => !/^(?:landscape|activity|experience|view)$/i.test(query)));
  }
});

test("观景台只是拍摄载体时由locationRole阻止地点进入Query", () => {
  const subject = "夜间观景台旁河马上岸觅食";
  const queries = buildKnowledgeQueryPlan({ moduleType: "day", location: "纳瓦沙湖观景台", locationRole: "scope_only", subject, activity: subject, queryCore: { subject: "河马", action: "上岸觅食" }, fidelityQuery: "纳瓦沙湖观景台 河马上岸觅食", alternateQueries: ["河马上岸"] }, null).queries;
  assert.deepEqual(queries, ["河马上岸觅食", "河马上岸"]);
  assert.doesNotMatch(queries.join(" "), /观景台|scenic viewpoint|panoramic observation deck/i);
});

test("步行游猎 Query 保留角色和动作，但地点只用于 Scope", () => {
  const queries = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "安博塞利",
    subject: "持枪向导带队在安博塞利进行步行Safari",
    searchIntent: ["持枪向导步行游猎", "向导带队丛林徒步", "armed guide walking safari", "guided bush walk ranger"],
  }, null).queries;
  assert.deepEqual(queries, ["持枪向导步行游猎", "向导带队丛林徒步", "armed guide walking safari", "guided bush walk ranger"]);
  assert.ok(queries.every((query) => !/安博塞利|amboseli/i.test(query)));
});

test("Planner生成的共同动作与主体短词原样保留", () => {
  const crossing = buildKnowledgeQueryPlan({ moduleType: "day", subject: "天国之渡角马和斑马渡河", searchIntent: ["角马斑马渡河", "角马渡河", "wildebeest zebra crossing"] }, null).queries;
  assert.equal(crossing[0], "角马斑马渡河");
  assert.ok(crossing.every((query) => /渡河|crossing/i.test(query)));

  const tracking = buildKnowledgeQueryPlan({ moduleType: "day", subject: "私人保护区独家路线追踪花豹与狮群", searchIntent: ["追踪花豹", "追踪猎豹", "追踪狮群", "leopard tracking"] }, null).queries;
  assert.deepEqual(tracking.slice(0, 3), ["追踪花豹", "追踪猎豹", "追踪狮群"]);
  assert.ok(tracking.every((query) => !/predator safari/i.test(query)));

  const balloon = buildKnowledgeQueryPlan({ moduleType: "day", subject: "热气球俯瞰草原日出与迁徙兽群", searchIntent: ["热气球草原日出", "热气球迁徙兽群", "hot air balloon safari"] }, null).queries;
  assert.equal(balloon[0], "热气球草原日出");
  assert.ok(balloon.every((query) => /热气球|hot air balloon/i.test(query)));
});

test("Planner第一条短Query只要可搜索就原样保留，不按queryCore逐字误判", () => {
  const cases = [
    {
      label: "徒步导览",
      slot: {
        moduleType: "day",
        primaryVisualSubject: "新月岛徒步导览时身旁漫步的斑马与长颈鹿",
        queryCore: { subject: "斑马长颈鹿", action: "徒步", subjectEn: "zebra giraffe", actionEn: "walking safari" },
        locationRole: "scope_only",
        fidelityQuery: "徒步观察斑马与长颈鹿",
        alternateQueries: ["walking among zebra giraffe"],
      },
      first: "徒步观察斑马与长颈鹿",
    },
    {
      label: "马拉河横渡",
      slot: {
        moduleType: "day",
        primaryVisualSubject: "马拉河角马横渡",
        queryCore: { subject: "角马", action: "渡河", identity: "马拉河", subjectEn: "wildebeest", actionEn: "river crossing", identityEn: "Mara River" },
        locationRole: "scope_only",
        fidelityQuery: "角马横渡河流",
        alternateQueries: ["wildebeest river crossing"],
      },
      first: "角马横渡河流",
      forbidden: /马拉河|Mara River/i,
    },
    {
      label: "烤肉上桌",
      slot: {
        moduleType: "day",
        primaryVisualSubject: "The Carnivore餐厅烤肉上桌",
        queryCore: { subject: "烤肉", action: "上桌", identity: "The Carnivore", subjectEn: "grilled meat", actionEn: "serving", identityEn: "The Carnivore" },
        locationRole: "scope_only",
        fidelityQuery: "烤肉上桌",
        alternateQueries: ["grilled meat served"],
      },
      first: "烤肉上桌",
      forbidden: /The Carnivore|餐厅环境|restaurant interior/i,
    },
    {
      label: "商务车送机",
      slot: {
        moduleType: "transport",
        primaryVisualSubject: "商务车机场送机",
        queryCore: { subject: "商务车", action: "送机", subjectEn: "business transfer vehicle", actionEn: "airport transfer" },
        locationRole: "scope_only",
        fidelityQuery: "商务车送机",
        alternateQueries: ["business airport transfer"],
      },
      first: "商务车送机",
      forbidden: /机场建筑|terminal exterior/,
    },
  ];
  for (const item of cases) {
    const plan = buildKnowledgeQueryPlan(item.slot, null);
    assert.equal(plan.queries[0], item.first, item.label);
    assert.equal(plan.repairStatus, "planner_valid", item.label);
    assert.equal(plan.strategy, "planner_queries", item.label);
    if (item.forbidden) assert.doesNotMatch(plan.queries.join(" "), item.forbidden, item.label);
  }
});

test("无效Planner Query修复只组合queryCore，不读取地点、时间或完整画面描述", () => {
  const cases = [
    {
      label: "地点和时间只属于Scope上下文",
      slot: {
        moduleType: "day",
        location: "安博塞利",
        primaryVisualSubject: "湿地象群与雪山",
        queryCore: { subject: "湿地象群与雪山", identity: "安博塞利清晨", subjectEn: "wetland elephants and mountain" },
        locationRole: "scope_only",
        fidelityQuery: "证明当天核心体验并区别其他图片",
        alternateQueries: [],
      },
      first: "湿地象群与雪山",
      forbidden: /安博塞利|清晨/,
    },
    {
      label: "主体已含动作时不重复追加",
      slot: {
        moduleType: "day",
        location: "纳瓦沙湖",
        primaryVisualSubject: "河马上岸觅食",
        queryCore: { subject: "河马上岸觅食", action: "上岸觅食", identity: "纳瓦沙湖观景台", subjectEn: "hippo coming ashore to feed", actionEn: "coming ashore to feed" },
        locationRole: "scope_only",
        fidelityQuery: "证明当天核心体验并区别其他图片",
        alternateQueries: [],
      },
      first: "观景台河马上岸觅食",
      forbidden: /纳瓦沙湖|上岸觅食\s+上岸觅食/,
    },
    {
      label: "目录实体删除且动作只出现一次",
      slot: {
        moduleType: "dining",
        location: "内罗毕",
        diningLocation: "The Carnivore",
        primaryVisualSubject: "The Carnivore野味烤肉上桌",
        queryCore: { subject: "野味烤肉上桌", action: "上桌", identity: "The Carnivore", subjectEn: "game meat served", actionEn: "served", identityEn: "The Carnivore" },
        locationRole: "scope_only",
        fidelityQuery: "证明当天核心体验并区别其他图片",
        alternateQueries: [],
      },
      first: "The Carnivore 野味烤肉上桌",
      forbidden: /上桌\s+上桌|served\s+served/i,
    },
  ];
  for (const item of cases) {
    const plan = buildKnowledgeQueryPlan(item.slot, null);
    assert.equal(plan.queries[0], item.first, item.label);
    assert.doesNotMatch(plan.queries.join(" | "), item.forbidden, item.label);
    assert.equal(plan.querySteps[0].source, "repair", item.label);
  }
});

test("时间只在属于地点上下文时删除，定义体验的夜间动作继续保留", () => {
  const plan = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "示例保护区",
    primaryVisualSubject: "夜间游猎追踪动物",
    queryCore: { subject: "夜间游猎", action: "追踪动物", subjectEn: "night safari", actionEn: "wildlife tracking" },
    searchIntent: ["夜间游猎追踪动物", "night safari wildlife tracking"],
  }, null);
  assert.equal(plan.queries[0], "夜间游猎追踪动物");
  assert.ok(plan.queries.some((query) => /night safari/i.test(query)));
});

test("合格Planner Query中的夜间日落等视觉词不触发过滤或整组重写", () => {
  const cases = [
    {
      location: "The Ritz-Carlton, Masai Mara Safari Camp",
      primaryVisualSubject: "户外长桌星空晚宴",
      queryCore: { subject: "户外长桌晚宴", subjectEn: "outdoor long-table dinner" },
      fidelityQuery: "草原星空晚宴 户外长桌 银河",
      alternateQueries: ["starlit outdoor dinner table under milky way", "bush dinner long table night sky"],
    },
    {
      location: "Angama Amboseli",
      locationRole: "visual_identity",
      primaryVisualSubject: "观景台望向雪山的日落视野",
      queryCore: { subject: "观景台日落雪山视野", identity: "Angama Amboseli", subjectEn: "viewpoint overlooking snow mountain at sunset", identityEn: "Angama Amboseli" },
      fidelityQuery: "Angama 观景台 乞力马扎罗雪山 日落",
      alternateQueries: ["Angama Amboseli viewpoint Kilimanjaro sunset", "observation deck facing snow mountain dusk"],
    },
    {
      location: "安博塞利国家公园",
      primaryVisualSubject: "夜间游猎车灯下出现的夜行动物",
      queryCore: { subject: "夜行动物", action: "在车灯下出现", identity: "夜间游猎", subjectEn: "nocturnal animal", actionEn: "illuminated by spotlight", identityEn: "night game drive" },
      fidelityQuery: "夜间游猎 车灯 夜行动物",
      alternateQueries: ["night game drive spotlight nocturnal animal", "nocturnal wildlife illuminated on night safari"],
    },
    {
      location: "Saruni Leopard Hill",
      locationRole: "visual_identity",
      primaryVisualSubject: "帐篷屋顶打开露出星空床",
      queryCore: { subject: "开顶帐篷星空床", identity: "Saruni Leopard Hill", subjectEn: "star bed in tent", identityEn: "Saruni Leopard Hill" },
      fidelityQuery: "Saruni 星空床 帐篷顶打开 星空",
      alternateQueries: ["star bed with open tent roof under stars", "tent roof opening to night sky star bed"],
    },
    {
      location: "长颈鹿中心",
      locationRole: "visual_identity",
      primaryVisualSubject: "游客与长颈鹿近距离互动",
      queryCore: { subject: "罗特希尔德长颈鹿", action: "与游客近距离互动", identity: "长颈鹿中心", subjectEn: "Rothschild giraffe", actionEn: "interacting with guest up close", identityEn: "Giraffe Centre" },
      fidelityQuery: "长颈鹿中心 罗特希尔德长颈鹿 互动",
      alternateQueries: ["Giraffe Centre Nairobi Rothschild giraffe feeding", "guest face to face with giraffe at centre"],
    },
  ];
  for (const slot of cases) {
    const expected = [slot.fidelityQuery, ...slot.alternateQueries];
    const plan = buildKnowledgeQueryPlan({ moduleType: "day", locationRole: slot.locationRole || "scope_only", ...slot }, null);
    assert.deepEqual(plan.queries, expected);
    assert.ok(plan.querySteps.every((step) => step.source === "planner" && step.scopeCleanup === false && step.originalQuery === step.finalQuery));
  }
});

test("无效Planner Query回退时保留作为画面身份的night game drive", () => {
  const plan = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "示例保护区",
    locationRole: "scope_only",
    primaryVisualSubject: "夜间游猎追踪动物",
    queryCore: { subject: "夜行动物", action: "追踪", identity: "night game drive", subjectEn: "nocturnal wildlife", actionEn: "tracking", identityEn: "night game drive" },
    fidelityQuery: "证明当天核心体验并区别其他图片",
    alternateQueries: [],
  }, null);
  assert.match(plan.queries.join(" | "), /night game drive/i);
});

test("无法从queryCore组成短Query时转人工，绝不把完整primaryVisualSubject塞回搜索", () => {
  const unresolvedLongCore = buildKnowledgeQueryPlan({
    moduleType: "day",
    primaryVisualSubject: "护林员带领游客徒步穿越丛林辨认动物足迹",
    queryCore: { subject: "一段无法直接组成短词但仍需保留的护林员徒步辨认动物足迹画面主体描述", action: "" },
    searchIntent: [],
  }, null);
  assert.deepEqual(unresolvedLongCore.queries, []);
  assert.equal(unresolvedLongCore.validationError.code, "query_core_unrecoverable");
  assert.ok(!unresolvedLongCore.queries.includes(unresolvedLongCore.visualTarget.coreVisualTarget));

  const unresolved = buildKnowledgeQueryPlan({ moduleType: "day", primaryVisualSubject: "证明当天核心体验；补充当天体验", searchIntent: [] }, null);
  assert.deepEqual(unresolved.queries, []);
  assert.equal(unresolved.validationError.code, "query_core_unrecoverable");
  assert.equal(unresolved.strategy, "needs_user_action_query_core_unrecoverable");
});

test("scope_only由Planner把精确身份留给Scope，Builder保持其通用短Query", () => {
  const plan = buildKnowledgeQueryPlan({
    moduleType: "day",
    primaryVisualSubject: "长颈鹿中心近距离喂食罗特希尔德长颈鹿",
    queryCore: {
      subject: "长颈鹿",
      action: "近距离喂食",
      identity: "长颈鹿中心",
      subjectEn: "giraffe",
      actionEn: "feeding",
      identityEn: "Giraffe Centre",
    },
    location: "长颈鹿中心",
    locationRole: "scope_only",
    fidelityQuery: "近距离喂食长颈鹿",
    alternateQueries: ["长颈鹿喂食", "giraffe feeding"],
  }, null);
  assert.equal(plan.queries[0], "近距离喂食长颈鹿");
  assert.deepEqual(plan.queries, ["近距离喂食长颈鹿", "长颈鹿喂食", "giraffe feeding"]);
  assert.doesNotMatch(plan.queries.join(" "), /长颈鹿中心|罗特希尔德|Giraffe Centre|Rothschild/i);
  assert.equal(plan.repairStatus, "planner_valid");
});

test("陌生目的地与陌生主体仍按字段语义清洗，不依赖项目专用词表", () => {
  const slot = {
    moduleType: "day",
    location: "云岭保护区",
    primaryVisualSubject: "云岭保护区萤光洞内近距离观察蓝冠甲虫",
    queryCore: {
      subject: "甲虫",
      action: "近距离观察",
      identity: "萤光洞",
      subjectEn: "beetle",
      actionEn: "close observation",
      identityEn: "Luminous Cavern",
    },
    searchIntent: [
      "云岭保护区萤光洞近距离观察甲虫",
      "游客近距离观察甲虫",
      "Luminous Cavern beetle close observation",
    ],
  };
  const detailedScope = {
    status: "resolved",
    nodeIds: ["luminous-cavern"],
    node: { formalName: "萤光洞", pathSegments: ["示例国", "云岭保护区", "萤光洞"] },
  };
  const countryScope = {
    status: "resolved",
    nodeIds: ["example-country"],
    node: { formalName: "示例国", pathSegments: ["示例国"] },
  };

  for (const scope of [detailedScope, countryScope]) {
    const plan = buildKnowledgeQueryPlan(slot, scope);
    assert.match(plan.queries[0], /甲虫/);
    assert.match(plan.queries[0], /近距离观察/);
    assert.ok(plan.queries.length >= 2 && plan.queries.length <= 4);
    assert.doesNotMatch(plan.queries.join(" "), /云岭保护区|示例国/i);
    assert.match(plan.queries.join(" "), /萤光洞|Luminous Cavern/i);
  }
});

test("DAY 附带酒店上下文不会把通用动物、Safari 或交通素材锁进酒店", () => {
  const genericSlots = [
    { moduleType: "day", location: "马赛马拉", hotel: "Saruni Leopard Hill", subject: "花豹 Safari" },
    { moduleType: "day", location: "安博塞利", hotel: "Angama Amboseli", subject: "象群与乞力马扎罗" },
    { moduleType: "day", location: "马赛马拉", hotel: "Saruni Leopard Hill", subject: "普通 Safari 游猎" },
  ];
  for (const slot of genericSlots) {
    assert.equal(classifyKnowledgeImagePurpose(slot), "destination_experience");
    const root = resolveKnowledgeScope(slot, hierarchy);
    const plan = buildKnowledgeScopePlan(slot, root, hierarchy);
    const expectedRegion = /安博塞利/.test(slot.location) ? "amboseli" : "masai-mara";
    assert.deepEqual(plan.scopes.map((item) => item.resolution.nodeIds[0]), [expectedRegion, "kenya"]);
    assert.ok(plan.scopes.every((item) => item.sourcePathMode === "country_context"));
  }
});

test("locationRole决定地点实体是否进入Query", () => {
  const cases = [
    [{ moduleType: "dining", location: "内罗毕", locationRole: "scope_only", diningLocation: "The Carnivore", subject: "The Carnivore特色烤肉", queryCore: { subject: "特色烤肉", action: "上桌", identity: "The Carnivore" }, fidelityQuery: "特色烤肉上桌", alternateQueries: ["特色烤肉餐厅"] }, /特色烤肉/],
    [{ moduleType: "day", location: "内罗毕", locationRole: "visual_identity", subject: "凯伦·布里克森博物馆", fidelityQuery: "凯伦博物馆建筑", alternateQueries: ["Karen Blixen Museum"] }, /凯伦博物馆/],
    [{ moduleType: "day", location: "内罗毕", locationRole: "scope_only", subject: "长颈鹿中心喂长颈鹿", queryCore: { subject: "长颈鹿", action: "游客喂食", identity: "长颈鹿中心" }, fidelityQuery: "游客喂长颈鹿", alternateQueries: ["长颈鹿互动"] }, /喂长颈鹿/],
  ];
  for (const [slot, expected] of cases) {
    const queries = buildKnowledgeQueryPlan(slot, null).queries;
    assert.match(queries[0], expected);
  }
  assert.doesNotMatch(buildKnowledgeQueryPlan(cases[0][0], null).queries.join(" "), /The Carnivore|内罗毕/i);
  assert.match(buildKnowledgeQueryPlan(cases[1][0], null).queries.join(" "), /凯伦|Karen Blixen/i);
  assert.doesNotMatch(buildKnowledgeQueryPlan(cases[2][0], null).queries.join(" "), /长颈鹿中心|内罗毕/i);
  assert.equal(buildKnowledgeQueryPlan({ moduleType: "day", location: "安博塞利", subject: "Observation Hill俯瞰湿地", searchIntent: ["山顶俯瞰湿地", "湿地全景", "wetlands panorama"], visualGoal: "与象群主图不同" }, null).queries[0], "山顶俯瞰湿地");
});

test("命名景点只作互动场景背景时按普通目的地体验审核，不再用实体目录误卡", () => {
  const slot = {
    moduleType: "day",
    location: "内罗毕",
    primaryVisualSubject: "长颈鹿中心与罗特希尔德长颈鹿零距离互动",
    subject: "长颈鹿中心与罗特希尔德长颈鹿零距离互动",
    activity: "游客与长颈鹿近距离互动",
    locationRole: "scope_only",
    queryCore: { subject: "长颈鹿", action: "游客互动", identity: "长颈鹿中心", subjectEn: "giraffe", actionEn: "visitor interaction", identityEn: "Giraffe Centre" },
    fidelityQuery: "游客与长颈鹿互动",
    alternateQueries: ["游客喂长颈鹿", "giraffe visitor interaction"],
    visualContext: { destination: "肯尼亚" },
  };
  assert.equal(classifyKnowledgeImagePurpose(slot), "destination_experience");
  const root = resolveKnowledgeScope(slot, hierarchy);
  const scopePlan = buildKnowledgeScopePlan(slot, root, hierarchy);
  assert.deepEqual(scopePlan.scopes.map((item) => item.resolution.nodeIds[0]), ["nairobi", "kenya"]);
  assert.equal(scopePlan.scopes[0].sourcePathMode, "country_context");
  const queryPlan = buildKnowledgeQueryPlan(slot, scopePlan.scopes[0].resolution);
  assert.equal(queryPlan.queries[0], "游客与长颈鹿互动");
  assert.doesNotMatch(queryPlan.queries.join(" "), /长颈鹿中心|Giraffe Centre|内罗毕|肯尼亚/i);
  assert.equal(queryPlan.visualTarget.coreVisualTarget, "罗特希尔德长颈鹿零距离互动");
  assert.equal(queryPlan.visualTarget.exactIdentityRequired, false);
  assert.equal(knowledgeSourcePathMatches(scopePlan.scopes[0].evidenceResolution, ["肯尼亚/内罗毕/Sarova/Panafric/panafric-experience-banner_.jpg"], { mode: scopePlan.scopes[0].sourcePathMode }).match, true);

  const identitySlot = { moduleType: "day", location: "内罗毕", subject: "长颈鹿中心入口建筑" };
  assert.equal(classifyKnowledgeImagePurpose(identitySlot), "explicit_entity");
  const identityRoot = resolveKnowledgeScope(identitySlot, hierarchy);
  const identityPlan = buildKnowledgeScopePlan(identitySlot, identityRoot, hierarchy);
  assert.equal(identityPlan.scopes[0].sourcePathMode, "entity_identity");
  assert.equal(knowledgeSourcePathMatches(identityPlan.scopes[0].evidenceResolution, ["肯尼亚/内罗毕/Sarova/Panafric/panafric-experience-banner_.jpg"], { mode: identityPlan.scopes[0].sourcePathMode, identityAnchors: identityPlan.scopes[0].identityAnchors }).match, false);
});

test("Query Builder 不重新裁决Planner画面，只执行结构化Query", () => {
  const plan = buildKnowledgeQueryPlan({
    moduleType: "day",
    location: "某地区",
    locationRole: "scope_only",
    primaryVisualSubject: "导览徒步，动物在身旁自由漫步",
    queryCore: { subject: "导览队伍", action: "徒步观察动物", identity: "" },
    fidelityQuery: "徒步观察动物",
    alternateQueries: ["向导带队徒步"],
  }, null);
  assert.deepEqual(plan.queries, ["徒步观察动物", "向导带队徒步"]);
  assert.equal(plan.validationError, undefined);
});

test("合格Planner Query在具体地点和国家Scope中保持原文与顺序不变", () => {
  const slot = {
    moduleType: "day",
    location: "安博塞利",
    locationRole: "scope_only",
    primaryVisualSubject: "护林员带队徒步观察动物足迹",
    queryCore: { subject: "护林员", action: "徒步观察动物足迹", subjectEn: "ranger", actionEn: "wildlife tracking walk" },
    fidelityQuery: "护林员徒步观察足迹",
    alternateQueries: ["动物足迹追踪", "ranger wildlife tracking"],
  };
  const expected = [slot.fidelityQuery, ...slot.alternateQueries];
  const specificScope = resolveKnowledgeScope(slot, hierarchy);
  const countryScope = { status: "resolved", nodeIds: ["kenya"], node: hierarchy.byId.get("kenya"), fullPath: hierarchy.byId.get("kenya").fullPath };
  assert.deepEqual(buildKnowledgeQueryPlan(slot, specificScope).queries, expected);
  assert.deepEqual(buildKnowledgeQueryPlan(slot, countryScope).queries, expected);
});

test("Scope Plan 预先确定逐级范围和不同图片用途的停止边界", () => {
  const hotelRoot = resolveKnowledgeScope({ moduleType: "hotel", hotel: "Angama Amboseli", subject: "Angama Amboseli" }, hierarchy);
  const hotelPlan = buildKnowledgeScopePlan({ moduleType: "hotel", hotel: "Angama Amboseli", subject: "Angama Amboseli" }, hotelRoot, hierarchy);
  assert.deepEqual(hotelPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["angama"]);
  assert.equal(hotelPlan.stopBoundary, "hotel_root");
  assert.equal(hotelPlan.childScopeDecision.reason, "hotel_module_locked_to_confirmed_hotel_root");

  const region = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利", subject: "象群" }, hierarchy);
  const dayPlan = buildKnowledgeScopePlan({ moduleType: "day", location: "安博塞利", subject: "象群" }, region, hierarchy);
  assert.deepEqual(dayPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["amboseli", "kenya"]);
  assert.equal(dayPlan.stopBoundary, "country");
  assert.equal(knowledgeSourcePathMatches(dayPlan.scopes[0].evidenceResolution, ["肯尼亚/马赛马拉/某酒店/Wildlife/elephants.jpg"], { mode: dayPlan.scopes[0].sourcePathMode }).match, false);
  assert.equal(knowledgeSourcePathMatches(dayPlan.scopes[1].evidenceResolution, ["肯尼亚/马赛马拉/某酒店/Wildlife/elephants.jpg"], { mode: dayPlan.scopes[1].sourcePathMode }).match, true);

  const transportPlan = buildKnowledgeScopePlan({ moduleType: "transport", location: "安博塞利", subject: "草原飞机" }, region, hierarchy);
  assert.deepEqual(transportPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["kenya"]);
  assert.equal(transportPlan.stopBoundary, "country");

  const entityRoot = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利", subject: "Observation Hill" }, hierarchy);
  const entityPlan = buildKnowledgeScopePlan({ moduleType: "day", location: "安博塞利", subject: "Observation Hill" }, entityRoot, hierarchy);
  assert.deepEqual(entityRoot.nodeIds, ["observation-hill"]);
  assert.deepEqual(entityPlan.scopes.map((item) => item.resolution.nodeIds[0]), ["observation-hill", "amboseli", "kenya"]);
  assert.equal(entityPlan.scopes[0].evidenceResolution.nodeIds[0], "observation-hill");
  assert.equal(knowledgeSourcePathMatches(entityPlan.scopes[0].evidenceResolution, ["肯尼亚/安博塞利/普通风景.jpg"], { identityAnchors: entityPlan.scopes[0].identityAnchors }).match, false);
  assert.equal(knowledgeSourcePathMatches(entityPlan.scopes[0].evidenceResolution, ["肯尼亚/安博塞利/Observation Hill/view.jpg"], { identityAnchors: entityPlan.scopes[0].identityAnchors }).match, true);
});

test("酒店精确目录不存在时停止知识库，不扩大到地区或国家", () => {
  const slot = {
    moduleType: "hotel",
    hotel: "Aurora Wilderness Lodge",
    location: "安博塞利",
    country: "肯尼亚",
    locationRole: "scope_only",
    primaryVisualSubject: "酒店无边泳池",
    queryCore: { subject: "酒店无边泳池", subjectEn: "infinity pool" },
    fidelityQuery: "酒店无边泳池",
    alternateQueries: ["infinity pool"],
  };
  const root = resolveKnowledgeScope(slot, hierarchy);
  assert.deepEqual(root.nodeIds, ["amboseli"]);
  const scopePlan = buildKnowledgeScopePlan(slot, root, hierarchy);
  assert.deepEqual(scopePlan.scopes, []);
  assert.equal(scopePlan.stopBoundary, "hotel_root");
  assert.equal(scopePlan.blockedReason, "hotel_directory_unresolved");
});

test("景点目录缺失时只在解析到的范围查询并用实体名硬校验，不跨实体采用", () => {
  const withoutObservationHill = buildKnowledgeHierarchy(hierarchy.records
    .filter((node) => node.nodeId !== "observation-hill")
    .map((node) => ({ node_id: node.nodeId, formal_name: node.formalName, parent_node_id: node.parentNodeId })));
  const slot = { moduleType: "day", location: "安博塞利", subject: "Observation Hill" };
  const root = resolveKnowledgeScope(slot, withoutObservationHill);
  const plan = buildKnowledgeScopePlan(slot, root, withoutObservationHill);
  assert.deepEqual(plan.scopes.map((item) => item.resolution.nodeIds[0]), ["amboseli", "kenya"]);
  assert.equal(plan.scopes[0].sourcePathMode, "entity_identity");
  assert.ok(plan.scopes[0].identityAnchors.includes("Observation Hill"));
  assert.equal(knowledgeSourcePathMatches(plan.scopes[0].evidenceResolution, ["肯尼亚/安博塞利/普通风景.jpg"], { mode: plan.scopes[0].sourcePathMode, identityAnchors: plan.scopes[0].identityAnchors }).match, false);
});

test("知识库 source_paths 是地点硬证据，冲突路径不能交给视觉模型覆盖", () => {
  const scope = resolveKnowledgeScope({ moduleType: "day", location: "安博塞利" }, hierarchy);
  assert.equal(knowledgeSourcePathMatches(scope, ["肯尼亚/安博塞利/象群"]).match, true);
  assert.equal(knowledgeSourcePathMatches(scope, ["肯尼亚/塞伦盖蒂/角马"]).match, false);
});

test("同名 leaf 必须同时匹配父级地区，不能跨地区误收 Saruni 图片", () => {
  const scope = resolveKnowledgeScope({ moduleType: "hotel", hotel: "Saruni Leopard Hill", location: "Masai Mara" }, hierarchy);
  assert.deepEqual(scope.nodeIds, ["saruni-mara"]);
  assert.equal(knowledgeSourcePathMatches(scope, ["肯尼亚/桑布鲁/Saruni/xxx.jpg"]).match, false);
  assert.equal(knowledgeSourcePathMatches(scope, ["肯尼亚/马赛马拉/Saruni Leopard Hill/xxx.jpg"]).match, true);
});

test("source_paths 身份判断复用 Registry alias 与 typo tolerance", () => {
  const scope = resolveKnowledgeScope({ moduleType: "hotel", hotel: "The Ritz-Carlton, Masai Mara Safari Camp", location: "Masai Mara" }, hierarchy);
  assert.deepEqual(scope.nodeIds, ["ritz"]);
  assert.equal(knowledgeSourcePathMatches(scope, ["The Ritz-Carlton, Masai Mara Safari Camp/hero.jpg"]).match, true);
});
