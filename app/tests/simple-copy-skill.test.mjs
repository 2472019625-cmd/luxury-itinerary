import test from "node:test";
import assert from "node:assert/strict";
import { buildHotelFactRows, normalizeCopyValueForSchema, runCopyWriterSkill, validateCopyCommitments, validateCopyValue } from "../server/simple-copy-skill.mjs";

const task = (targetId, targetPath, moduleType = "day") => ({
  targetId,
  targetPath,
  moduleType,
  facts: { source: `${targetId} 的确定事实` },
  factStatuses: { source: "confirmed" },
  plannerGoal: "只表达当前目标的客户价值",
  relevantContext: { destination: "肯尼亚" },
  outputSchema: { type: "string", minLength: 2 },
});

test('visual_card 与 DAY 同批并明确支持内部描述路径，不新增调用或重试', async () => {
  let calls = 0;
  const input = [task('day', 'days.0.description'), task('copy:visual:image:day:1:primary', 'simpleImageSlotBindings.image_day_1_primary.description', 'visual_card')];
  const result = await runCopyWriterSkill({ tasks: input, requestJson: async ({ messages }) => {
    calls++;
    assert.match(messages[0].content, /moduleType=visual_card/);
    assert.match(messages[0].content, /是合法的内部文案写回位置/);
    assert.match(messages[0].content, /每一个 visual_card target 都有独立结果/);
    const payload = JSON.parse(messages.at(-1).content);
    assert.equal(payload.batchKind, 'days');
    assert.deepEqual(payload.tasks.map(item => item.targetId), input.map(item => item.targetId));
    return { json: { results: payload.tasks.map(item => ({targetId: item.targetId, targetPath: item.targetPath, value: '沿已确认路线观察草原，从不同视角感受当天的自然景观。'})) } };
  }});
  assert.equal(calls, 1);
  assert.equal(result.results.every(item => item.status === 'success'), true);
  assert.equal(result.metrics.automaticBusinessRetryRounds, 0);
});

test("Copy 按全局、DAY、notes形成三个物理批次并按 targetId 隔离结构失败", async () => {
  let calls = 0;
  const events = [];
  const notesTask = { ...task("notes", "notes", "notes"), outputSchema: { type: "array", minItems: 1, items: { type: "string" } } };
  const input = [task("highlight-1", "highlights.0", "product_highlight"), task("day-1", "days.0.description"), task("day-2", "days.1.description"), notesTask];
  const seenBatchKinds = [];
  const result = await runCopyWriterSkill({
    tasks: input,
    itineraryContext: { destination: "肯尼亚", dayCount: 2 },
    requestJson: async ({ messages, emptyContentRetries, reasoningEffort }) => {
      calls += 1;
      assert.equal(emptyContentRetries, 1);
      assert.equal(reasoningEffort, "medium");
      assert.match(messages[0].content, /Copy Writer Skill/);
      assert.match(messages[0].content, /不是只能逐字复述 Excel/);
      assert.match(messages[0].content, /高端定制旅行产品内容营销写作者/);
      assert.match(messages[0].content, /真实事实 \+ 合理体验化展开 \+ 客户价值/);
      assert.match(messages[0].content, /不得把“可能看到”写成“保证\/必然看到”/);
      assert.match(messages[0].content, /禁止修改价格、交通承诺、接待等级/);
      assert.match(messages[0].content, /而不是检查某个词是否出现在 Excel/);
      assert.match(messages[0].content, /只有固定钟点、保证看到具体动物或获得某结果/);
      assert.match(messages[0].content, /同名 Spot 有真实区别时写区别/);
      const runtimeContract = messages[0].content.split("## Runtime response contract").at(-1);
      assert.doesNotMatch(runtimeContract, /荒野注解|同名 spot|酒店 editorialCopy/);
      assert.match(runtimeContract, /只输出 JSON 对象/);
      assert.match(runtimeContract, /禁止 Reviewer|不得返回 Reviewer/);
      const payload = JSON.parse(messages.at(-1).content);
      seenBatchKinds.push(payload.batchKind);
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "day-2" ? 123 : item.targetId === "notes" ? ["行前准备"] : "草原纵深｜以差异化区域串联完整观察体验。" })) }, attemptUsages: [{ attempt: 1 }] };
    },
    onCapabilityCall: (event) => events.push(event),
  });
  assert.equal(calls, 3);
  assert.equal(result.metrics.modelCalls, 3);
  assert.equal(result.metrics.businessBatches, 3);
  assert.equal(result.metrics.physicalBatches, 3);
  assert.equal(result.metrics.automaticBusinessRetryRounds, 0);
  assert.deepEqual(seenBatchKinds.sort(), ["days", "global", "notes"]);
  assert.equal(result.metrics.reasoningEffort, "medium");
  assert.equal(result.status, "partial_success");
  assert.deepEqual(result.results.map((item) => item.status), ["success", "success", "failed", "success"]);
  assert.equal(result.results[2].error.code, "invalid_output_schema");
  assert.equal(result.results[0].targetPath, "highlights.0");
  assert.deepEqual([...new Set(events.map((event) => event.capabilityId))].sort(), ["copy_task_progress", "copy_writer"]);
  assert.deepEqual([...new Set(events.map((event) => event.batchKind).filter(Boolean))].sort(), ["days", "global", "notes"]);
  const progressEvents = events.filter((event) => event.capabilityId === "copy_task_progress");
  assert.equal(progressEvents.at(-1).completedTasks, input.length);
  assert.equal(progressEvents.at(-1).totalTasks, input.length);
});

test("无 researchRequest 不触发联网，合理体验化表达不要求 Excel 原句", async () => {
  let researchCalls = 0;
  const result = await runCopyWriterSkill({
    tasks: [task("day-experience", "days.0.description")],
    researchFacts: async () => { researchCalls += 1; throw new Error("不应调用"); },
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      return { json: { results: [{ targetId: payload.tasks[0].targetId, targetPath: payload.tasks[0].targetPath, value: "把车程留给观察地貌渐变，抵达后以更从容的节奏进入当天体验。" }] }, attemptUsages: [{}] };
    },
  });
  assert.equal(researchCalls, 0);
  assert.equal(result.metrics.researchCalls, 0);
  assert.equal(result.results[0].status, "success");
});

test("研究结果只注入当前 target，研究技术失败时酒店使用供应商事实安全降级", async () => {
  const researched = { ...task("hotel", "hotels.0.editorialCopy", "hotel"), researchRequest: { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["空间"] } };
  const direct = task("transport", "transportSummary.0.editorialCopy", "transport");
  const result = await runCopyWriterSkill({
    tasks: [researched, direct],
    researchFacts: async () => { throw Object.assign(new Error("官方来源暂不可用"), { code: "copy_facts_research_failed" }); },
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      assert.deepEqual(payload.tasks.map((item) => item.targetId), ["hotel", "transport"]);
      const hotelTask = payload.tasks.find((item) => item.targetId === "hotel");
      assert.equal(hotelTask.facts.factsResearchOutcome.status, "failed");
      assert.deepEqual(hotelTask.facts.verifiedFacts, []);
      assert.match(hotelTask.facts.factsResearchOutcome.zeroFactBoundary, /禁止依赖模型常识/);
      return { json: { results: [
        { targetId: "hotel", targetPath: researched.targetPath, value: "依据供应商已确认资料，保留克制的酒店介绍。" },
        { targetId: "transport", targetPath: direct.targetPath, value: "以已确认交通类别组织整程移动体验。" },
      ] }, attemptUsages: [{}] };
    },
  });
  assert.equal(result.results.find((item) => item.targetId === "hotel").status, "success");
  assert.ok(result.results.find((item) => item.targetId === "hotel").warnings.some((item) => /事实研究发生技术故障/.test(item)));
  assert.equal(result.results.find((item) => item.targetId === "transport").status, "success");
  assert.equal(result.researchResults.find((item) => item.targetId === "hotel").status, "failed");
  assert.equal(result.metrics.researchCalls, 1);
  assert.equal(result.metrics.modelCalls, 1);
});

test("餐饮轻量事实研究失败时继续调用 Copy，并使用餐饮专属安全边界", async () => {
  const dining = {
    ...task("dining", "diningExperiences.0.editorialCopy", "dining"),
    facts: { sourceEvidence: ["DAY 1：在酒店安排星空晚宴"] },
    researchRequest: { researchType: "official_entity_facts", entityName: "Example Safari Camp", entityKind: "dining", focus: "星空晚宴", categories: ["餐饮形式", "体验特色"] },
  };
  const result = await runCopyWriterSkill({
    tasks: [dining],
    researchFacts: async () => { throw Object.assign(new Error("官方餐饮页面暂不可用"), { code: "copy_facts_research_failed" }); },
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      const writerTask = payload.tasks[0];
      assert.equal(writerTask.facts.factsResearchOutcome.status, "failed");
      assert.match(writerTask.facts.factsResearchOutcome.zeroFactBoundary, /菜单、食材、酒款/);
      assert.doesNotMatch(writerTask.facts.factsResearchOutcome.zeroFactBoundary, /酒店设施、设计/);
      return { json: { results: [{ targetId: "dining", targetPath: dining.targetPath, value: "享用已确认的星空晚宴，在特别用餐场景中感受不同于普通晚餐的节奏。" }] }, attemptUsages: [{}] };
    },
  });
  assert.equal(result.results[0].status, "success");
  assert.ok(result.results[0].warnings.some((warning) => /餐饮事实研究发生技术故障/.test(warning)));
  assert.equal(result.metrics.researchCalls, 1);
  assert.equal(result.metrics.modelCalls, 1);
});

test("hotel editorialCopy、proofPoints 和 factRows 共用一次研究，factRows 不增加 Writer 输出", async () => {
  const request = { researchType: "official_entity_facts", entityName: "Faru Faru Lodge", categories: ["位置", "客房", "设计", "设施"] };
  const editorial = { ...task("hotel-copy", "hotels.0.editorialCopy", "hotel"), researchRequest: request };
  const proofPoints = { ...task("hotel-proof", "hotels.0.proofPoints", "hotel"), researchRequest: request, outputSchema: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", minLength: 2 } } };
  const factRows = { ...task("hotel-fact-rows", "hotels.0.factRows", "hotel_fact_rows"), researchRequest: request, required: false, outputSchema: { type: "array", minItems: 4, maxItems: 4, items: { type: "object", required: ["key", "label", "text", "status"], properties: { key: { type: "string" }, label: { type: "string" }, text: { type: "string" }, status: { type: "string" }, sourceUrl: { type: "string" }, sourceClass: { type: "string" }, checkedAt: { type: "string" } }, additionalProperties: false } } };
  let researchCalls = 0;
  const result = await runCopyWriterSkill({
    tasks: [editorial, proofPoints, factRows],
    researchFacts: async () => {
      researchCalls += 1;
      return {
        researchType: request.researchType,
        entityName: request.entityName,
        status: "success",
        verifiedFacts: [{ category: "位置", fact: "临近 Grumeti River。", sourceUrl: "https://singita.com/lodge/singita-faru-faru-lodge/", sourceExcerpt: "located on the Grumeti River", sourceClass: "official_entity", checkedAt: "2026-09-04T00:00:00.000Z" }],
        categoryOutcomes: [{ category: "位置", status: "success" }, { category: "客房", status: "not_found" }, { category: "设计", status: "not_found" }, { category: "设施", status: "not_found" }],
        attemptUsages: [{}],
      };
    },
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      assert.deepEqual(payload.tasks.map((item) => item.targetId), ["hotel-copy", "hotel-proof"]);
      for (const item of payload.tasks) assert.equal(item.verifiedFacts.verifiedFacts[0].fact, "临近 Grumeti River。");
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "hotel-proof" ? ["临近 Grumeti River", "以河岸景观构成住宿环境"] : "Faru Faru Lodge 临近 Grumeti River，河岸环境让住宿本身成为草原体验的一部分。" })) }, attemptUsages: [{}] };
    },
  });
  assert.equal(researchCalls, 1);
  assert.equal(result.metrics.researchCalls, 1);
  assert.equal(result.metrics.modelCalls, 1);
  assert.deepEqual(result.results.map((item) => item.status), ["success", "success", "success"]);
  assert.deepEqual(result.results[2].value.map(({ key, label, text, status }) => ({ key, label, text, status })), [
    { key: "location", label: "位置", text: "临近 Grumeti River。", status: "success" },
    { key: "rooms", label: "客房", text: "", status: "not_found" },
    { key: "design", label: "设计", text: "", status: "not_found" },
    { key: "facilities", label: "设施", text: "", status: "not_found" },
  ]);
});

test("hotel factRows 研究技术失败时保留四行状态且不调用 Copy Writer", async () => {
  const request = { researchType: "official_entity_facts", entityName: "Unavailable Lodge", categories: ["位置", "客房", "设计", "设施"] };
  const factRows = { ...task("failed-fact-rows", "hotels.0.factRows", "hotel_fact_rows"), researchRequest: request, required: false, outputSchema: { type: "array", minItems: 4, maxItems: 4, items: { type: "object" } } };
  let writerCalls = 0;
  const result = await runCopyWriterSkill({
    tasks: [factRows],
    researchFacts: async () => { throw Object.assign(new Error("暂不可用"), { code: "copy_facts_research_failed" }); },
    requestJson: async () => { writerCalls += 1; throw new Error("不应调用"); },
  });
  assert.equal(writerCalls, 0);
  assert.equal(result.metrics.modelCalls, 0);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(result.results[0].value.map((row) => row.status), ["source_unavailable", "source_unavailable", "source_unavailable", "source_unavailable"]);
});

test("buildHotelFactRows 固定顺序保存核验事实与缺失状态", () => {
  const rows = buildHotelFactRows({
    status: "success",
    verifiedFacts: [{ category: "设施", fact: "设有室内泳池。", sourceUrl: "https://example.com", sourceClass: "official_entity", checkedAt: "2026-09-21T00:00:00.000Z" }],
    categoryOutcomes: [{ category: "位置", status: "not_found" }, { category: "客房", status: "source_unavailable" }, { category: "设计", status: "not_found" }, { category: "设施", status: "success" }],
  });
  assert.deepEqual(rows.map((row) => row.key), ["location", "rooms", "design", "facilities"]);
  assert.equal(rows[1].status, "source_unavailable");
  assert.equal(rows[3].text, "设有室内泳池。");
  assert.equal(rows[3].sourceUrl, "https://example.com");
});

test("酒店 verifiedFacts 为零时显式注入事实边界且 proofPoints 可按真实数量留空", async () => {
  const request = { researchType: "official_entity_facts", entityName: "Sparse Lodge", categories: ["空间与设计"] };
  const editorial = { ...task("sparse-copy", "hotels.0.editorialCopy", "hotel"), facts: { officialName: "Sparse Lodge", region: "保护区", nights: 1, supplierHotelContext: [] }, researchRequest: request };
  const proofPoints = { ...task("sparse-proof", "hotels.0.proofPoints", "hotel_proof_points"), facts: editorial.facts, researchRequest: request, outputSchema: { type: "array", minItems: 0, maxItems: 3, items: { type: "string" } } };
  const result = await runCopyWriterSkill({
    tasks: [editorial, proofPoints],
    researchFacts: async () => ({ researchType: request.researchType, entityName: request.entityName, status: "not_found", verifiedFacts: [], rejected: [], attemptUsages: [{}] }),
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      for (const item of payload.tasks) {
        assert.equal(item.facts.factsResearchOutcome.status, "not_found");
        assert.equal(item.facts.factsResearchOutcome.verifiedFactCount, 0);
        assert.match(item.facts.factsResearchOutcome.zeroFactBoundary, /禁止依赖模型常识/);
      }
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "sparse-proof" ? [] : "本次行程将在 Sparse Lodge 停留一晚；现有资料未提供更多可核验住宿事实。" })) }, attemptUsages: [{}] };
    },
  });
  assert.deepEqual(result.results.map((item) => item.status), ["success", "success"]);
  assert.deepEqual(result.results[1].value, []);
  assert.ok(result.results.every((item) => item.warnings.some((warning) => /酒店事实研究未获得可核验结果/.test(warning))));
});

test("酒店研究按字段部分缺失时继续生成并保留字段状态", async () => {
  const request = { researchType: "official_entity_facts", entityName: "Example Lodge", categories: ["位置", "客房", "设计", "设施"] };
  const hotelTask = { ...task("hotel-partial", "hotels.0.editorialCopy", "hotel"), researchRequest: request };
  const result = await runCopyWriterSkill({
    tasks: [hotelTask],
    researchFacts: async () => ({
      researchType: request.researchType,
      entityName: request.entityName,
      status: "success",
      verifiedFacts: [{ category: "位置", fact: "位于河岸。", sourceUrl: "https://examplelodge.com/location", sourceExcerpt: "river", sourceClass: "official_entity", checkedAt: "2026-09-21T00:00:00.000Z" }],
      categoryOutcomes: [
        { category: "位置", status: "success" },
        { category: "客房", status: "not_found" },
        { category: "设计", status: "source_unavailable" },
        { category: "设施", status: "not_found" },
      ],
      attemptUsages: [{}],
    }),
    requestJson: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content);
      assert.deepEqual(payload.tasks[0].facts.factsResearchOutcome.categoryOutcomes, [
        { category: "位置", status: "success" },
        { category: "客房", status: "not_found" },
        { category: "设计", status: "source_unavailable" },
        { category: "设施", status: "not_found" },
      ]);
      return { json: { results: [{ targetId: hotelTask.targetId, targetPath: hotelTask.targetPath, value: "酒店位于河岸，以已核验的位置事实说明住宿环境。" }] }, attemptUsages: [{}] };
    },
  });
  assert.equal(result.results[0].status, "success");
  assert.ok(result.results[0].warnings.some((warning) => /部分字段未获得可核验结果/.test(warning)));
});

test("门禁允许合理体验展开，只拒绝无依据的新具体承诺和订单边界", async () => {
  const sourceTask = {
    ...task("day-commitment", "days.0.description"),
    facts: { activity: "已确认夜间游猎；guided walking safari / 导览员带领" },
  };
  const result = await runCopyWriterSkill({
    tasks: [sourceTask],
    requestJson: async () => ({ json: { results: [{ targetId: sourceTask.targetId, targetPath: sourceTask.targetPath, value: "傍晚回到营地；夜间游猎会借助探照设备观察夜间环境，也有机会观察夜行动物。" }] }, attemptUsages: [{}] }),
  });
  assert.equal(result.results[0].status, "success");

  const allowed = [
    "傍晚回到营地。",
    "夜间游猎会借助探照设备观察夜间环境。",
    "跟随专业向导进入荒野徒步。",
    "有机会观察夜行动物。",
    "建议提前预约，以实际确认结果为准。",
  ];
  for (const value of allowed) assert.deepEqual(validateCopyCommitments(value, sourceTask), []);

  assert.match(validateCopyCommitments("19:30 准时出发。", sourceTask)[0], /固定钟点承诺/);
  assert.match(validateCopyCommitments("保证看到狮子和花豹。", sourceTask)[0], /保证性结果/);
  assert.match(validateCopyCommitments("零距离感受野生动物。", sourceTask)[0], /具体接近程度承诺/);
  assert.match(validateCopyCommitments("由国家一级专家全程陪同。", sourceTask)[0], /具体人员资质承诺/);
  assert.match(validateCopyCommitments("该活动必须提前30天预约。", sourceTask)[0], /强制预约时限/);
  assert.match(validateCopyCommitments("该活动需提前预约。", sourceTask)[0], /强制预约要求/);
  assert.match(validateCopyCommitments("本次已包含河景套房。", sourceTask)[0], /订单包含或确认承诺/);
  assert.deepEqual(validateCopyCommitments("夜间游猎会借助探照设备观察夜间环境。", { facts: { activity: "城市观光" } }), []);
  assert.deepEqual(validateCopyCommitments("白天跟随向导追踪兽群。", { moduleType: "hotel", facts: { verifiedFacts: [{ fact: "酒店采用现代有机设计。" }] } }), []);
  assert.deepEqual(validateCopyCommitments("客房露台面向水塘，公共空间设有泳池与管家服务。", { moduleType: "hotel", facts: { verifiedFacts: [{ fact: "酒店采用现代有机设计。" }] } }), []);
  assert.deepEqual(validateCopyCommitments("套房设有私人露台。", { moduleType: "hotel", facts: { verifiedFacts: [{ fact: "全部套房设有私人露台。" }] } }), []);

  assert.deepEqual(validateCopyCommitments("19:30 准时出发。", { facts: { departureTime: "19:30", timingStatus: "confirmed" } }), []);
  assert.deepEqual(validateCopyCommitments("该活动必须提前30天预约。", { facts: { reservationLeadTime: "提前30天", status: "reservation_required" } }), []);
});

test("单个物理批次技术重试耗尽只影响该批 targets", async () => {
  const input = [task("cover", "title", "cover"), task("day-1", "days.0.description"), task("day-2", "days.1.description"), { ...task("notes", "notes", "notes"), outputSchema: { type: "array", items: { type: "string" }, minItems: 1 } }];
  let physicalCalls = 0;
  const result = await runCopyWriterSkill({
    tasks: input,
    requestJson: async ({ messages, emptyContentRetries }) => {
      physicalCalls += 1;
      assert.equal(emptyContentRetries, 1);
      const payload = JSON.parse(messages.at(-1).content);
      if (payload.batchKind === "days") {
        const error = new Error("network failed after one technical retry");
        error.attemptUsages = [{ attempt: 1 }, { attempt: 2 }];
        throw error;
      }
      return { json: { results: payload.tasks.map((item) => ({ targetId: item.targetId, targetPath: item.targetPath, value: item.targetId === "notes" ? ["行前准备"] : "有效文案" })) }, attemptUsages: [{ attempt: 1 }] };
    },
  });
  assert.equal(physicalCalls, 3);
  assert.equal(result.metrics.businessBatches, 3);
  assert.equal(result.metrics.modelCalls, 4);
  assert.equal(result.metrics.transportAttempts, 4);
  assert.equal(result.metrics.automaticBusinessRetryRounds, 0);
  assert.equal(result.results.find((item) => item.targetId === "cover").status, "success");
  assert.equal(result.results.find((item) => item.targetId === "notes").status, "success");
  assert.ok(result.results.filter((item) => item.targetId.startsWith("day-")).every((item) => item.status === "failed"));
});

test("产品亮点契约不完整时明确返回且不自行规划", async () => {
  let calls = 0;
  const bad = { ...task("highlight-bad", "subtitle", "product_highlight") };
  const result = await runCopyWriterSkill({ tasks: [bad], requestJson: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, "needs_input");
  assert.equal(result.results[0].error.code, "invalid_highlight_contract");
});

test("outputSchema 校验对象和数组结构", () => {
  assert.deepEqual(validateCopyValue({ title: "证件", items: ["检查护照"] }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } }, additionalProperties: false }), []);
  assert.ok(validateCopyValue({ title: "证件", items: [3] }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } } }).length > 0);
  assert.deepEqual(validateCopyValue({ title: "证件", items: ["检查护照"] }, { oneOf: [{ type: "string" }, { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } } }] }), []);
});

test("notes item 的 warnings 被确定性移到结果级且不触发额外模型调用", async () => {
  const notesSchema = { type: "array", minItems: 1, items: { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, items: { type: "array", items: { type: "string" } } }, additionalProperties: false } };
  const direct = normalizeCopyValueForSchema([{ title: "行前准备", items: ["核对证件"], warnings: ["时效信息需核验"] }], notesSchema);
  assert.deepEqual(direct.value, [{ title: "行前准备", items: ["核对证件"] }]);
  assert.deepEqual(direct.warnings, ["时效信息需核验"]);
  let calls = 0;
  const result = await runCopyWriterSkill({
    tasks: [{ ...task("notes", "notes", "notes"), outputSchema: notesSchema }],
    requestJson: async ({ messages }) => {
      calls += 1;
      const input = JSON.parse(messages.at(-1).content).tasks[0];
      return { json: { results: [{ targetId: input.targetId, targetPath: input.targetPath, value: [{ title: "行前准备", items: ["核对证件"], warnings: ["时效信息需核验"] }], warnings: ["未识别日期"] }] }, attemptUsages: [{ attempt: 1 }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(result.results[0].value, [{ title: "行前准备", items: ["核对证件"] }]);
  assert.deepEqual(result.results[0].warnings, ["未识别日期", "时效信息需核验"]);
});

test("Notes 非法 tone 使用字段契约默认展示值且保留 warning", () => {
  const notesSchema = { type: "array", minItems: 1, items: { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, tone: { enum: ["gold", "warning"] }, items: { type: "array", items: { type: "string" } } }, additionalProperties: false } };
  const normalized = normalizeCopyValueForSchema([{ title: "行前准备", tone: "info", items: ["核对证件"] }], notesSchema);
  assert.equal(normalized.value[0].tone, "gold");
  assert.match(normalized.warnings[0], /tone“info”.*默认值“gold”/);
  assert.deepEqual(validateCopyValue(normalized.value, notesSchema), []);
});

test("Notes 非法 tone 不再导致整个 Copy target 失败", async () => {
  const notesSchema = { type: "array", minItems: 1, items: { type: "object", required: ["title", "items"], properties: { title: { type: "string" }, tone: { enum: ["gold", "warning"] }, items: { type: "array", items: { type: "string" } } }, additionalProperties: false } };
  const notesTask = { ...task("notes-tone", "notes", "notes"), outputSchema: notesSchema };
  const result = await runCopyWriterSkill({
    tasks: [notesTask],
    requestJson: async () => ({ json: { results: [{ targetId: notesTask.targetId, targetPath: notesTask.targetPath, value: [{ title: "行前准备", tone: "info", items: ["核对证件"] }], warnings: [] }] }, attemptUsages: [{ attempt: 1 }] }),
  });
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].value[0].tone, "gold");
  assert.match(result.results[0].warnings[0], /tone“info”/);
});
