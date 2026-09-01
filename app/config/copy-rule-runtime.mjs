export const COPY_RULE_VERSION = '2026-09-01.v1';

const card = (id, fields, must, forbid, evidence, pass, failure, deterministicChecks, complexity = 'simple') => Object.freeze({
  id, version: COPY_RULE_VERSION, fields, must, forbid, evidence, pass, failure, complexity,
  stage: 'copy+brand_review+target_recheck', promptSections: [id], deterministicChecks,
  aiReview: 'prompts/customer-itinerary-brand-reviewer-v1.md', merge: 'server/itinerary-refinement.mjs#applyTargetedRevisions',
  tests: ['tests/content-quality.test.mjs','tests/itinerary-refinement.test.mjs','tests/copy-rule-runtime.test.mjs','tests/copy-repair.test.mjs'],
});

export const COPY_RULE_RUNTIME = Object.freeze([
  card('COPY-001',['customer'],['先场景向往，再稀缺价值与具体安排，最后服务型边界；热情、从容、专业、有画面'],['流水账、百科腔、供应商口吻、廉价促销、冷硬免责、空泛形容词堆叠'],['只使用已确认事实'],['客户理解体验价值与安排且边界清楚'],['只修命中字段；仍失败进入待文案修订'],['brand_voice','brand_sequence','anti_supplier','anti_encyclopedia','anti_discount'],'complex'),
  card('COPY-002',['modules'],['模块顺序和职责唯一，必需模块存在'],['跨模块复读、用尾部边界压过销售内容'],['当前数据与模块可见性'],['必需模块齐全且顺序正确'],['程序阻止完成'],['required_modules','module_responsibility'],'deterministic'),
  card('COPY-003',['title'],['目的地+X天X晚+产品形态，单行且不超过24字'],['具体人数、定制团、私家团'],['确定性目的地与天数晚数'],['格式、事实和长度全部正确'],['程序确定性回退；溢出阻止'],['title_format','title_product_form','title_group_language'],'deterministic'),
  card('COPY-004',['subtitle'],['用一条有路线推进的完整叙事句说明路线气质、核心体验和定制价值；长行程至少承接两个已确认路线/体验/交通锚点，并形成“起点/节奏—串联/深入—客户旅程结果”的叙事关系；封面2—3行，不超过76字'],['逗号罗列交通/酒店/卖点、换词后继续列卖点、酒店清单、照抄、顶级尊享等空泛堆叠'],['路线与核心体验事实'],['具体、有画面、有旅程意义且无额外承诺'],['低推理单字段修复，失败升级一次高推理'],['subtitle_specific','subtitle_grounding','subtitle_narrative_arc','subtitle_hotel_list','subtitle_selling_point_list','subtitle_too_long']),
  card('COPY-005',['highlights'],['2—8字短标题：客户具体价值；六天以上内容丰富行程5—6条；服务价值1—2条，其余为路线独有价值；保留源强卖点'],['裸标签、口号、换词重复、虚构卖点、特惠超值等促销词'],['sourcePosterHighlights与路线事实'],['两类价值存在且路线差异占多数'],['单项或模块小范围高推理；仍失败待修订'],['highlight_format','highlight_value','highlight_mix','highlight_route_primary','highlight_complete','highlight_duplicate'],'complex'),
  card('COPY-006',['days.*.theme','days.*.routeNodes'],['主题表达当天旅行意义、高潮或节奏变化；总览只留DAY、主题、路线和必要交通'],['全天游猎、抵达、返程、自由活动、前往某地、酒店名直接作主题；餐食酒店堆叠'],['当天事实与整程DAY角色'],['一眼看懂路线且每个主题有独立意义'],['单DAY高推理修复；路线缺失程序阻止'],['overview_route','overview_theme','overview_theme_not_action','overview_theme_not_hotel','overview_no_meal_hotel_dump'],'complex'),
  card('COPY-007',['hotels.*.editorialCopy','hotels.*.proofPoints'],['说明位置如何服务路线、客户感受和一两个记忆场景；2—3条短锚点'],['设施清单、翻译腔、供应商宣传、无依据奢华形容'],['酒店确定性或官方逐句事实'],['路线价值、场景和短锚点均有依据'],['单酒店高推理修复；证据不足阻止'],['hotel_value','hotel_scene','hotel_route_value','hotel_no_facility_dump','hotel_proof_points','sentence_fact_evidence'],'complex'),
  card('COPY-008',['diningExperiences.*.editorialCopy'],['只写真实特色餐饮的场景、氛围和体验价值'],['普通三餐包装、虚构菜名或烹饪方式'],['餐饮事实、官方资料'],['每张卡对应明确餐饮形态'],['过滤无事实项目；证据错误阻止'],['dining_evidence','dining_scene','dining_no_menu_invention']),
  card('COPY-009',['transportSummary.*.usageLabel','transportSummary.*.editorialCopy'],['客户卡片只显示简短适用场景、类别/等级、已确认承载事实和舒适衔接价值'],['客户卡片显示DAY编号与完整A→B→C路线、无保证车型承诺、逐卡重复免责声明'],['确定性交通与modelGuaranteed；完整逐日交通仅作内部映射依据'],['汇总与每日交通对应、承诺一致且卡片层级简洁'],['单项修复；事实/源覆盖问题阻止'],['transport_usage_label','transport_value','transport_guarantee','transport_no_repeated_disclaimer'],'complex'),
  card('COPY-010',['days.*.description','days.*.spots.*.description'],['写客户做/看什么、现场如何展开、为何值得、如何承接整程；普通体验日46—220字，转场/返程日24—130字；相邻DAY重点不同'],['前往—参观—返回流水账、无依据时段/资质/动物/活动、细节堆砌、跨日同义重复、空泛套话'],['当前DAY原始事实、前后DAY摘要、整程DAY角色'],['动作、画面、价值和前后推进均基于事实，信息密度适合长图阅读'],['每次只修一个DAY，复杂问题直接高推理；仍失败待修订'],['day_progression','day_action_scene','day_value','day_length','day_fact_dump','day_near_duplicate','day_no_supplier_log','sentence_fact_evidence'],'complex'),
  card('COPY-011',['days.*.spots.*','expenses'],['已含、自费、预约、待确认状态在正文、费用、图片和编辑后同步'],['把未含或未确认写成已含/已确认'],['确定性状态与费用边界'],['客户不会误解履约状态'],['程序阻止，不能文案掩盖'],['experience_status','fee_boundary_sync'],'deterministic'),
  card('COPY-012',['days.*.dayNotices'],['每天最多一条且有实际准备价值'],['全局安全运营边界、空泛提醒、警告堆叠'],['当天准备事实'],['可执行且与当天相关'],['程序限量；单条低推理修复'],['tip_count','tip_preparation_value','no_day_warning_stack']),
  card('COPY-013',['notes','notes.*'],['分类标题+条目数组；温和具体可执行；按相关性覆盖运营、健康、安全、自然、行李和特殊人群'],['字符串数组、空格拼段、冷硬免责、无来源具体时效结论'],['目的地事实；时效信息须有权威来源和核验日期'],['Schema合法、逐条展示、类别与语气合格'],['非法结构程序拒绝并阻止；合法单组可低推理修复'],['notes_schema','notes_tone','notes_actionable','notes_categories','time_sensitive_authority_and_date'],'deterministic'),
  card('COPY-014',['includedCustomer','excludedCustomer','cancellationCustomer'],['与源费用逐项逐数量对应，只改变客户表达'],['合并掉边界、新增包含、删除不含、内部测算和供应商成本口吻'],['确定性费用与源覆盖台账'],['数量、索引、边界和客户表达均正确'],['数量/边界冲突程序阻止；仅措辞低推理'],['fee_source_coverage','fee_count_consistency','fee_conflict','fee_supplier_language','internal_cost_isolation'],'deterministic'),
  card('COPY-015',['customer'],['感染力建立在事实之上；可核验陈述逐句有来源；自然期待带温和边界'],['无依据唯一最大奖项、设施位置、动物出现、车型房型菜单、具体时效金额或保证'],['原始/官方事实摘录；时效来源URL与核验日期'],['所有可核验事实有充分依据'],['无依据具体陈述程序阻止；主观语气局部修复'],['unsupported_promise','cold_disclaimer','sentence_fact_evidence','time_sensitive_authority_and_date'],'deterministic'),
  card('COPY-016',['consultant'],['只显示真实配置；无资料使用明确非真人默认位'],['虚构真人、年限、订单、好评、联系方式'],['用户配置'],['无虚假个人业绩且空指标收缩'],['程序删除未验证字段并阻止泄漏'],['advisor_authenticity'],'deterministic'),
  card('COPY-017',['customer'],['客户预览、JSON、PNG仅保留白名单客户信息'],['审核分数、候选状态、提示词、模型理由、内部路径、来源账本、成本利润和供应商沟通'],['客户字段白名单'],['三种客户输出均无内部信息'],['检出即阻止正式完成/导出'],['internal_leak','customer_render_isolation'],'deterministic'),
]);

export const COPY_RULE_IDS = COPY_RULE_RUNTIME.map((item) => item.id);
export const COPY_RULE_BY_ID = new Map(COPY_RULE_RUNTIME.map((item) => [item.id, item]));

export function copyRuleCardsFor(ruleIds = []) {
  const ids = new Set(ruleIds.flatMap((item) => Array.isArray(item) ? item : [item]).filter(Boolean));
  return COPY_RULE_RUNTIME.filter((item) => ids.has(item.id));
}
