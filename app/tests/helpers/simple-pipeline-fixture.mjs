import path from "node:path";
import * as XLSX from "xlsx";

export function createWorkbookFile() {
  const rows = [
    ["肯尼亚3日私享旅程"],
    ["海报下方亮点"],
    ["私家游猎｜以专属节奏深入草原"],
    ["天数", "日期", "路线", "行程内容", "早餐", "午餐", "晚餐", "住宿", "交通"],
    ["D1", "2026-10-15", "内罗毕→安博塞利", "抵达后乘草原飞机前往安博塞利，傍晚在营地周边游猎", "酒店早餐", "机上午餐", "营地晚餐", "Angama Amboseli", "草原飞机"],
    ["D2", "2026-10-16", "安博塞利", "在安博塞利进行全天私人游猎", "营地早餐", "营地午餐", "营地晚餐", "Angama Amboseli", "4x4游猎车"],
    ["D3", "2026-10-17", "安博塞利→内罗毕", "晨间短途游猎后乘草原飞机返回内罗毕", "营地早餐", "简餐", "自理", "飞机", "草原飞机"],
    ["报价包含", "住宿、行程所列交通与游猎活动"],
    ["报价不包含", "国际机票与个人消费"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "行程");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  return { name: "simple-pipeline-integration.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

export function plannerRequestJson({ delayMs = 5 } = {}) {
  return async ({ messages }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const shared = JSON.parse(messages.at(-1).content);
    const facts = shared.factBasis;
    const modules = [
      ["global", "封面、亮点与行程总览", true],
      ["hotels", "臻选下榻", facts.hotels.length > 0],
      ["dining", "特色餐饮", facts.diningExperiences.length > 0],
      ["transport", "全程交通", facts.transport.length > 0],
      ["days", "每日行程", true],
      ["notes", "旅行准备与注意事项", true],
      ["expenses", "费用与退改", true],
    ].map(([moduleId, label, show]) => ({ moduleId, label, decision: show ? "show" : "hide", contentAction: show ? "optimize" : "hide", reason: show ? "当前结构化事实需要展示" : "当前资料没有适用事实" }));
    const imageSlots = [
      { slotId: "legacy-cover", role: "cover", label: "封面", required: true, visualDuty: "目的地主视觉", differentiation: "整程总览", searchIntent: facts.destination, removable: false },
      ...facts.hotels.map((hotel, index) => ({ slotId: `legacy-hotel-${index + 1}`, role: `hotel:${index + 1}`, label: hotel.name, required: true, visualDuty: "酒店真实空间", differentiation: "住宿品质", searchIntent: hotel.name, removable: false })),
      ...facts.days.map((day, index) => ({ slotId: `legacy-day-${index + 1}`, role: `day:${index + 1}`, label: `DAY ${index + 1}`, required: true, visualDuty: "当日核心体验", differentiation: `第${index + 1}日地点与角色`, searchIntent: `${day.route || ""} ${day.experience || ""}`, removable: false })),
    ];
    return {
      json: {
        summary: { contentTheme: "以草原深入程度推进旅程", visualTheme: "从抵达到深入再到收束", planningRationale: "按真实地点、移动和每日角色形成差异" },
        selectedHighlights: [
          ...facts.sourcePosterHighlights.map((sourceText) => ({ sourceText, sourceType: "source_designated", sourceRefs: ["sourcePosterHighlights"], selectionReason: "原始报价单明确指定" })),
          ...facts.officialProductValues.slice(0, Math.max(0, 5 - facts.sourcePosterHighlights.length)).map((item) => ({ sourceText: item.sourceText, sourceType: "official_product", sourceRefs: item.sourceRefs, selectionReason: "已确认奢游产品价值" })),
        ],
        modules,
        dayRoles: facts.days.map((day, index) => ({ index, role: index === 0 ? "抵达与进入草原" : index === facts.days.length - 1 ? "晨间体验与返程收束" : "核心区域深度游猎", differenceFromAdjacent: `使用DAY ${index + 1}真实地点、移动与活动区分`, contentAction: "optimize", sourceRefs: [`days.${index}`] })),
        contentPlacement: [],
        webVerification: [],
        imagePlan: { visualStory: "以目的地环境、酒店空间和每日行动形成递进", slots: imageSlots },
        confirmations: [],
        adjustments: [],
      },
      model: "planner-fixture",
      usage: { input_tokens: 100, output_tokens: 100 },
      attemptUsages: [{}],
    };
  };
}

export function copyRequestJson({ failTargetId = null, delayMs = 60 } = {}) {
  return async ({ messages }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const payload = JSON.parse(messages.at(-1).content);
    const results = payload.tasks.filter((task) => task.targetId !== failTargetId).map((task) => {
      let value = `已按${task.moduleType}真实事实完成的客户文案`;
      if (task.moduleType === "cover") value = "肯尼亚草原私享之旅";
      if (task.moduleType === "cover_subtitle") value = "从草原飞机进入安博塞利，以私家游猎展开完整自然旅程";
      if (task.moduleType === "product_highlight") value = `${task.facts.selectedByPlanner}｜解释这项已确认配置对客户的具体价值。`;
      if (task.moduleType === "hotel") value = "坐落于安博塞利核心景观区域，以真实开阔视野与完整营地空间构成值得期待的住宿体验。";
      if (task.moduleType === "hotel_proof_points") value = ["开阔景观中的居停空间", "贴近自然环境的住宿体验"];
      if (task.moduleType === "dining") value = "在真实行程所列的用餐场景中品尝当地风味，让餐食本身成为旅途体验的一部分。";
      if (task.moduleType === "transport_usage") value = "城市与机场接送 · 保护区游猎移动";
      if (task.moduleType === "transport") value = "草原飞机与专属游猎车承担主要移动，在真实交通类别范围内兼顾跨区效率与游猎舒适度。";
      if (task.moduleType === "transport_features") value = ["跨区域衔接更高效", "游猎移动更从容"];
      if (task.moduleType === "day_theme") value = `DAY ${Number(task.layoutHints?.dayIndex || 0) + 1} 的独立旅行主题`;
      if (task.moduleType === "day") value = `当天沿既定路线展开真实活动，在明确的交通、用餐与住宿安排中形成独立体验重点。`;
      if (task.moduleType === "day_notice") value = "当天移动与体验较为集中，建议提前整理随身用品，轻装参与。";
      if (task.moduleType === "day_spot") value = "围绕这一项真实活动说明体验方式与客户价值。";
      if (task.moduleType === "notes") value = [
        { title: "行前准备", icon: "calendar", tone: "gold", items: ["请根据本次目的地与活动安排准备合适衣物和随身用品，具体清单由定制师在出发前协助复核。"] },
        { title: "活动与安全", icon: "security", tone: "gold", items: ["参加游猎与营地活动时请遵循现场人员指引，相关时效要求以出发前正式通知为准。"] },
      ];
      return { targetId: task.targetId, targetPath: task.targetPath, value, warnings: [] };
    });
    return { json: { results }, model: "copy-fixture", usage: { input_tokens: 100, output_tokens: 200 }, attemptUsages: [{}] };
  };
}

export async function copyResearchFacts({ researchRequest }) {
  return {
    researchType: researchRequest.researchType,
    entityName: researchRequest.entityName,
    status: "success",
    verifiedFacts: [{ category: researchRequest.categories[0], fact: "官方页面确认该住宿以自然环境与空间体验为核心。", sourceUrl: "https://official.example.test/hotel", sourceExcerpt: "nature and space", checkedAt: "2026-09-04T00:00:00.000Z" }],
  };
}

export function imageAdapters({ appRoot, failMatcher = () => false, delayMs = 80 } = {}) {
  const assets = Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return { filePath: path.join(appRoot, "public", "assets", "placeholders", `destination-${number}.png`), publicUrl: `/assets/placeholders/destination-${number}.png` };
  });
  let cursor = 0;
  const pageAssets = new Map();
  return {
    searchWebBatch: async ({ queries }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failMatcher(queries.join(" "))) return [];
      const asset = assets[cursor++ % assets.length];
      const pageUrl = `https://images.example.test/page-${cursor}`;
      pageAssets.set(pageUrl, asset);
      return [{ pageUrl, title: queries[0], summary: queries.join(" "), officialHint: true, searchRank: 0 }];
    },
    searchCommonsImages: async () => [],
    extractPageImages: async (page) => {
      const asset = pageAssets.get(page.pageUrl);
      return [{ ...page, imageUrl: `${page.pageUrl}/image.jpg`, width: 1800, height: 1100, fixtureAsset: asset }];
    },
    downloadCandidate: async (candidate) => ({ ...candidate, filePath: candidate.fixtureAsset.filePath, publicUrl: candidate.fixtureAsset.publicUrl, sha256: `fixture-${candidate.fixtureAsset.publicUrl}` }),
    judgeCandidatesBatch: async ({ slot, candidates }) => candidates.map((candidate, index) => ({ candidateId: candidate.candidateId, score: 90 - index, locationMatch: true, hotelIdentityMatch: true, activityMatch: true, subjectMatch: true, watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true, eligible: true, actualSubject: slot.label || slot.subject || slot.slotId, reason: "结构化事实、主体、地点和来源均匹配", hardRejectCode: "none" })),
  };
}
