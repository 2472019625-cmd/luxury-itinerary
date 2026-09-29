// Shared field semantics from IMG-001/004/005. The isolated repair experiment
// must receive the same contract as the initial Planner, not an abbreviated one.
export const SLOT_VISUAL_CONTRACT = `图片字段契约：先根据本位sourceRefs选择一个真实、有独立展示价值的核心画面，再填写全部字段。
queryCore只含subject/action/identity/subjectEn/actionEn/identityEn。subject是通用可见主体，action只写一个定义画面的必要动作，静态空间action为空；酒店名、地点名放identity，不重复混入subject或action。subjectEn/actionEn与中文必须指向同一个主体和动作。
locationRole只能是scope_only或visual_identity。scope_only时location和identity只用于目录及身份审核，fidelityQuery和alternateQueries不能包含它们；visual_identity仅用于命名实体本体必须入镜的画面。exactIdentityRequired独立判断，酒店代表图必须true并保留预订酒店完整identity。
独立hotel:N若职责是展示酒店代表空间，queryCore.subject写“酒店代表性空间”、subjectEn写“representative hotel space”、action和actionEn为空；外观、套房、泳池、公共空间属于该酒店的既定代表候选类别，不能凭DAY中某个活动推导本酒店专属设施或本次已订房型。只有本酒店来源明确支持且职责确实要求证明具体设施或体验时才使用具体Core。
每位fidelityQuery加1—3条alternateQueries，合计2—4条短搜索词，每条一种语言。同义表达可以不同；所有Query必须是同一Core，不能通过alternateQueries切换动作或主体。酒店scope_only的Query只写代表空间类别，不带酒店名。
不得输出A或B、A/B、or或两个可独立发生的动作；自然共现主体可以同框。原资料列有多项活动时，在本次规划内部选择一个有来源的目标，不能把原文的多选项原样当成一张画面。主视觉、Core和Query一起检查，不能只改其中一处。地点背景和普通交通姿态若仅是表现偏好，不得写成必需主体或必需动作；酒店代表图主视觉直接写完整酒店身份加酒店代表性空间。
可选不等于无价值。同一家酒店、同一时段、同属餐饮或相似气氛，不足以证明两个画面重复；只有缺少来源支持的独立画面或与已保留Core职责确实重复，才说明具体理由省略。省略不改变行程事实、模块选择、费用或履约状态。已在omittedOptionalRoles声明省略的可选位不得再输出空slot，也不能用“无安排、不单独规划图片”充当主视觉。`;

export function buildDayVisualCoverageTasks(factBasis = {}) {
  return (factBasis.days || []).map((day, index) => ({
    dayRole: `day:${index + 1}`,
    sourceRefs: [`days.${index}.experience`, ...(day.spots || []).map((_, spot) => `days.${index}.spots.${spot}`)],
    instruction: "先通读当天全部事实并选定有来源、互不重复的画面集合，再将集合完整写成主图和辅助slot；普通体验日默认2张，丰富日最多4张，转场返程1—2张；事实仅支持1张时在主图visualDuty/differentiation说明事实限制。imageCandidateSlots只列最低覆盖，不是最终数量。不能用活动数量机械补位，也不能因为封面或酒店已有图而省略当天独立体验。",
  }));
}
