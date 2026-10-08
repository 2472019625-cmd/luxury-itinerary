// Shared field semantics from IMG-001/004/005. The isolated repair experiment
// must receive the same contract as the initial Planner, not an abbreviated one.
export const SLOT_VISUAL_CONTRACT = `图片字段契约：先根据本位sourceRefs选择一个真实、有独立展示价值的核心画面，再填写全部字段。
queryCore只含subject/action/identity/subjectEn/actionEn/identityEn。subject是通用可见主体，action只写一个定义画面的必要动作，静态空间action为空；酒店名、地点名放identity，不重复混入subject或action。subjectEn/actionEn与中文必须指向同一个主体和动作。
locationRole只能是scope_only或visual_identity。scope_only时location和identity只用于目录及身份审核，fidelityQuery和alternateQueries不能包含它们；visual_identity仅用于命名实体本体必须入镜的画面。exactIdentityRequired独立判断，酒店代表图必须true并保留预订酒店完整identity。
独立hotel:N若职责是展示酒店代表空间，queryCore.subject写“酒店代表性空间”、subjectEn写“representative hotel space”、action和actionEn为空；外观、套房、泳池、公共空间属于该酒店的既定代表候选类别，不能凭DAY中某个活动推导本酒店专属设施或本次已订房型。只有本酒店来源明确支持且职责确实要求证明具体设施或体验时才使用具体Core。
每位fidelityQuery加1—3条alternateQueries，合计2—4条短搜索词，每条一种语言。同义表达可以不同；所有Query必须是同一Core，不能通过alternateQueries切换动作或主体。酒店scope_only的Query只写代表空间类别，不带酒店名。
不得输出A或B、A/B、or或两个可独立发生的动作；自然共现主体可以同框。原资料列有多项活动时，在本次规划内部选择一个有来源的目标，不能把原文的多选项原样当成一张画面。主视觉、Core和Query一起检查，不能只改其中一处。地点背景和普通交通姿态若仅是表现偏好，不得写成必需主体或必需动作；酒店代表图主视觉直接写完整酒店身份加酒店代表性空间。
可选不等于无价值。同一家酒店、同一时段、同属餐饮或相似气氛，不足以证明两个画面重复；只有缺少来源支持的独立画面或与已保留Core职责确实重复，才说明具体理由省略。省略不改变行程事实、模块选择、费用或履约状态。已在omittedOptionalRoles声明省略的可选位不得再输出空slot，也不能用“无安排、不单独规划图片”充当主视觉。`;

// Keep the legacy contract intact for its existing consumers. Simple planning
// uses the confirmed Core/preference boundary consistently in every prompt.
export const SIMPLE_SLOT_VISUAL_CONTRACT = SLOT_VISUAL_CONTRACT.replace(
  '不得输出A或B、A/B、or或两个可独立发生的动作；自然共现主体可以同框。',
  '不得在核心主体、必要动作或不可替代身份中输出A或B、A/B、or，也不能合并两个可独立发生的必要动作；自然共现主体可以同框。Core已选定时，明确标注的普通背景、附属示例、交通表现姿态及同店代表空间选择可作表现偏好，不能改变Core或承诺事实；来源、身份或语义不明时保留待处理。',
);

export function buildDayVisualCoverageTasks(factBasis = {}) {
  return (factBasis.days || []).map((day, index) => ({
    dayRole: `day:${index + 1}`,
    sourceRefs: [`days.${index}.experience`, ...(day.spots || []).map((_, spot) => `days.${index}.spots.${spot}`)],
    experience: day.experience || '',
    experiences: (day.spots || []).map((spot, spotIndex) => ({ sourceRef: `days.${index}.spots.${spotIndex}`, name: spot.name, description: spot.description, status: spot.status })),
    instruction: "先通读当天全部事实并选定有来源、互不重复的画面集合，再将集合完整写成主图和辅助slot；普通体验日默认2张，丰富日最多4张，转场返程1—2张；事实仅支持1张时在主图visualDuty/differentiation说明事实限制。imageCandidateSlots只列最低覆盖，不是最终数量。不能用活动数量机械补位，也不能因为封面或酒店已有图而省略当天独立体验。",
  }));
}

export const DAY_VISUAL_COVERAGE_CONTRACT = `逐日覆盖契约：在同一次规划调用内，为每个dayRoles对象增加visualCoverage数组。先通读完整experience和每个Spot，逐个识别有来源的独立场景，不能只看Spot名称或只满足每天一张。每项格式为{"sourceRef":"days.N.spots.M或days.N.experience","sourceQuote":"该来源中的逐字短摘录","decision":"planned|covered_elsewhere|omitted","slotRoles":["实际输出的图片role"],"reason":"选用或省略的具体理由"}。一份experience可有多项对应不同独立场景。每个非空Spot都要有去向，但Spot不等于图片数：同一场景可以共用一个slot。
planned引用本日图片role，图片sourceRefs须包含对应来源；covered_elsewhere只用于与实际输出的cover/hotel/dining/transport画面职责确实重复，必须指明该role及相同主体/动作为何已覆盖，不以同一家酒店、都是游猎或都是餐饮为理由省略另一项独立体验。omitted的slotRoles为空，必须给出无独立画面价值、真实重复或达到4张上限后的具体优先级取舍，不能用“可选”“找图难”“时间不足”“主图已有”作为理由。费用和履约状态不改变。普通核心体验日默认2张，只有一个合理场景或跨模块已有等价覆盖时可1张；单图日须在主图differentiation说明本日事实限制及其余体验去向。不把两个独立体验硬合并成一个slot。优先补齐遗漏的真实高价值场景；保持1—4张和一次Planner调用，不生成无来源体验。输出前检查visualCoverage引用的role都在imagePlan.slots中，不能把未创建的辅助位写成已规划。`;

// Check references and explicit decisions, not semantic quality or a numeric
// minimum. Keep usable selected images even when the explanation is incomplete.
export function auditDayVisualCoverage(plan = {}, factBasis = {}, { required = false } = {}) {
  const slots = plan.imagePlan?.slots || [];
  const byRole = new Map(slots.map(slot => [slot.role, slot]));
  const text = value => String(value || '').trim();
  const normalized = value => text(value).replace(/\s+/g, '');
  return (factBasis.days || []).map((day, dayIndex) => {
    const prefix = `days.${dayIndex}`;
    const dayRole = `day:${dayIndex + 1}`;
    const role = (plan.dayRoles || []).find(item => item.index === dayIndex);
    const entries = Array.isArray(role?.visualCoverage) ? role.visualCoverage : [];
    const expected = (day.spots || []).flatMap((spot, i) => text(spot.name || spot.description) ? [`${prefix}.spots.${i}`] : []);
    if (!expected.length && text(day.experience)) expected.push(`${prefix}.experience`);
    const issues = [];
    const validRefs = new Set();
    const add = (code, sourceRef) => issues.push({ code, dayIndex, sourceRef });
    const bound = (slot, ref, quote) => (slot.sourceRefs || []).some(sourceRef => sourceRef === ref
      || sourceRef === `${prefix}.experience` && normalized(day.experience).includes(normalized(quote)));
    for (const entry of entries) {
      const ref = text(entry?.sourceRef);
      const spot = new RegExp(`^days\\.${dayIndex}\\.spots\\.(\\d+)$`).exec(ref);
      const source = ref === `${prefix}.experience` ? day.experience
        : spot && day.spots?.[Number(spot[1])] ? [day.spots[Number(spot[1])].name, day.spots[Number(spot[1])].description].filter(Boolean).join(' ') : '';
      if (!text(source) || !text(entry.sourceQuote) || !normalized(source).includes(normalized(entry.sourceQuote))) { add('coverage_source_unbound', ref); continue; }
      if (!['planned', 'covered_elsewhere', 'omitted'].includes(entry.decision) || !text(entry.reason)) { add('coverage_decision_missing', ref); continue; }
      const targets = Array.isArray(entry.slotRoles) ? entry.slotRoles : [];
      if (entry.decision === 'omitted') {
        if (targets.length) { add('coverage_omission_conflict', ref); continue; }
      } else {
        if (!targets.length || targets.some(target => !byRole.has(target))) { add('coverage_slot_missing', ref); continue; }
        if (entry.decision === 'planned' && targets.some(target => !(target === dayRole || target.startsWith(`${dayRole}:supporting:`))
          || !bound(byRole.get(target), ref, entry.sourceQuote))) { add('coverage_day_binding_invalid', ref); continue; }
        if (entry.decision === 'covered_elsewhere' && targets.some(target => !/^(cover|hotel:\d+|dining:\d+|transport:\d+)$/.test(target))) { add('coverage_other_module_invalid', ref); continue; }
      }
      validRefs.add(ref);
    }
    if (required || entries.length) for (const ref of expected) if (!validRefs.has(ref)) add('coverage_experience_unaccounted', ref);
    const selected = slots.filter(slot => slot.role === dayRole || slot.role?.startsWith(`${dayRole}:supporting:`));
    if ((required || entries.length) && selected.length === 1 && !text(selected[0].differentiation)) add('coverage_single_image_reason_missing', `${prefix}.experience`);
    return { dayIndex, plannedCount: selected.length, status: !entries.length && !required ? 'legacy_unknown' : issues.length ? 'incomplete' : 'accounted', entries, issues };
  });
}
