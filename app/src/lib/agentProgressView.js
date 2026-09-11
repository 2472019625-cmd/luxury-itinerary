export const SIMPLE_DESIGNER_STAGES = [
  { key: "parser", sourceKeys: ["parser"], label: "整理你上传的行程资料", shortLabel: "资料", routePosition: 0 },
  { key: "planner", sourceKeys: ["planner"], label: "梳理路线与体验重点", shortLabel: "规划", routePosition: 22 },
  { key: "content_creation", sourceKeys: ["copy_skill", "image_skill"], label: "完善客户文案与视觉素材", shortLabel: "内容制作", routePosition: 44 },
  { key: "program_writeback", sourceKeys: ["program_writeback"], label: "核对客户行程重要信息", shortLabel: "检查", routePosition: 78 },
  { key: "renderer", sourceKeys: ["renderer"], label: "排版并检查客户版长图", shortLabel: "长图", routePosition: 92 },
];

export const AGENT_DESIGNER_STAGES = [
  { key: "planning", label: "梳理整程节奏与亮点", shortLabel: "整理" },
  { key: "verification", label: "核对重要行程事实", shortLabel: "核对" },
  { key: "copy", label: "完善客户版行程文案", shortLabel: "文案" },
  { key: "brand_review", label: "检查客户表达与重要信息", shortLabel: "检查" },
  { key: "images", label: "匹配酒店、体验与交通图片", shortLabel: "图片" },
  { key: "render", label: "生成行程长图", shortLabel: "长图" },
  { key: "final_checks", label: "检查最终交付内容", shortLabel: "完成" },
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstUsefulTitle(values) {
  return values.map(cleanText).find((value) => value && !/^未命名/.test(value));
}

export function getDesignerTripTitle(snapshot, localProject) {
  const factBasis = snapshot?.project?.factBasis || snapshot?.plan?.preparedData || {};
  const destination = cleanText(factBasis.destination || localProject?.data?.destination);
  const dayCount = Number(factBasis.dayCount || factBasis.days?.length || localProject?.data?.days?.length || 0);
  return firstUsefulTitle([
    snapshot?.result?.data?.title,
    snapshot?.plan?.preparedData?.title,
    localProject?.data?.title,
    localProject?.title,
    destination && dayCount ? `${destination}${dayCount}日定制行程` : destination ? `${destination}定制行程` : "本次定制行程",
  ]) || "本次定制行程";
}

function highlightLabel(value) {
  const text = cleanText(value).replace(/^特别体验[:：]\s*/, "");
  if (!text) return "";
  const [lead, detail] = text.split(/[|｜]/).map(cleanText);
  if (lead && lead.length <= 12) return lead;
  if (detail && detail.length <= 12) return detail;
  return text.split(/[，。；—–-]/)[0].slice(0, 12);
}

export function getDesignerHighlights(snapshot, localProject, limit = 4) {
  const factBasis = snapshot?.project?.factBasis || {};
  const sources = [
    snapshot?.result?.data?.highlights,
    snapshot?.plan?.preparedData?.sourcePosterHighlights,
    factBasis.sourcePosterHighlights,
    factBasis.coreExperiences,
    localProject?.data?.highlights,
  ];
  const seen = new Set();
  const labels = [];
  for (const source of sources) {
    for (const value of Array.isArray(source) ? source : []) {
      for (const part of String(value || "").split(/\r?\n/)) {
        const label = highlightLabel(part);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
        if (labels.length >= limit) return labels;
      }
    }
  }
  return labels;
}

function activeStage(snapshot) {
  const jobStages = snapshot?.activeJob?.stages || [];
  const running = jobStages.find((stage) => stage.status === "running");
  if (running?.id) return running.id;
  const latest = snapshot?.activeJob?.latestEvent || snapshot?.executionRun?.events?.at?.(-1) || {};
  if (latest.stage === "capability") {
    if (["copy_writer", "copy_facts_research"].includes(latest.capabilityId)) return "copy_skill";
    return "image_skill";
  }
  return latest.stage || snapshot?.project?.currentStage || "";
}

function targetText(snapshot) {
  const latest = snapshot?.activeJob?.latestEvent || snapshot?.executionRun?.events?.at?.(-1) || {};
  return cleanText([latest.target, latest.taskId, latest.detail?.currentAction, latest.detail?.message, snapshot?.activeJob?.currentAction].filter(Boolean).join(" "));
}

function findDayNumber(value) {
  const match = String(value || "").match(/(?:image|copy)?[:_-]?day[:_\s-]?(\d{1,2})|第\s*(\d{1,2})\s*天/i);
  return Number(match?.[1] || match?.[2] || 0);
}

export function getDesignerCurrentAction(snapshot) {
  const status = snapshot?.project?.status || snapshot?.activeJob?.status || "";
  if (["complete", "ready_for_editor"].includes(status)) return "客户版行程已制作完成，可以继续调整文案、图片和版式";
  if (status === "partial") return "可编辑草稿已生成，未完成内容可在编辑页继续处理";
  if (status === "awaiting_confirmation") return "正在等待你确认影响行程安排的重要信息";
  if (status === "awaiting_user_action") return "部分内容需要你在编辑页确认或补充";
  if (["cancelled"].includes(status)) return "本次制作已取消，已确认资料仍然保留";
  if (["failed", "planning_failed", "execution_failed"].includes(status)) return "本次制作暂时中断，已完成内容和资料仍然保留";

  const stage = activeStage(snapshot);
  const target = targetText(snapshot);
  const day = findDayNumber(target);
  if (["parser", "preparing"].includes(stage)) return "正在读取并整理你上传的行程资料";
  if (["planner", "planning"].includes(stage)) return "正在梳理整程节奏、产品亮点与客户表达重点";
  if (["copy_skill", "copy", "brand_review", "verification"].includes(stage)) {
    if (day) return `正在完善第 ${day} 天的客户版行程介绍`;
    if (/hotel|酒店/i.test(target)) return "正在完善酒店介绍与入住价值";
    if (/transport|交通|vehicle/i.test(target)) return "正在完善本次交通安排的客户表达";
    return stage === "verification" ? "正在检查酒店、晚数与原始资料是否一致" : "正在完善客户版行程文案";
  }
  if (["image_skill", "images"].includes(stage)) {
    if (day) return `正在为第 ${day} 天的核心体验匹配合适图片`;
    if (/transport|交通|vehicle/i.test(target)) return "正在为本次游猎与接驳交通匹配合适图片";
    if (/hotel|酒店/i.test(target)) return "正在为行程酒店匹配合适图片";
    if (/cover|封面/i.test(target)) return "正在为整趟旅程选择封面主视觉";
    if (/dining|餐饮|meal/i.test(target)) return "正在为特色餐饮匹配合适图片";
    return "正在匹配酒店、体验与交通图片";
  }
  if (["program_writeback", "final_checks"].includes(stage)) return "正在检查酒店、晚数、路线、费用与原始资料是否一致";
  if (["renderer", "render"].includes(stage)) return "正在生成并检查客户版行程长图";
  return "正在按你确认的资料继续制作客户版行程";
}

export function getDesignerSummary(snapshot) {
  const status = snapshot?.project?.status || snapshot?.activeJob?.status || "";
  if (["complete", "ready_for_editor"].includes(status)) return "客户版行程已经制作完成。日期、酒店、路线和费用仍按你确认的资料保留，现在可以继续调整文案、图片和版式。";
  if (["partial", "awaiting_user_action"].includes(status)) return "已按你确认的资料生成可编辑草稿。日期、酒店、路线和费用保持不变，未完成内容可在编辑页继续补充。";
  if (["failed", "planning_failed", "execution_failed"].includes(status)) return "已确认的日期、酒店、路线和费用信息仍然保留；当前制作暂时中断，可查看管理员详情定位原因。";
  return "已保留你确认的日期、酒店、路线和费用信息，正在完善客户版文案与配图。";
}
