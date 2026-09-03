export const SHEYOU_PRODUCT_VALUES_VERSION = "sheyou-product-values-2026-09-03";

// 这里只收录已经在正式规则或现有产品配置中出现的服务价值，供 Planner 选择；
// 不是默认写入每份行程的宣传承诺，也不允许 Planner 扩写为未确认的履约内容。
export const SHEYOU_PRODUCT_VALUES = Object.freeze([
  Object.freeze({
    id: "one-party-one-itinerary",
    sourceText: "一家一团：路线节奏由同行人决定",
    customerValue: "同一行程只围绕本组同行者安排节奏，不与陌生客人拼团。",
    sourceRefs: Object.freeze(["rules/03-品牌文案与模块内容.md#COPY-005"]),
  }),
  Object.freeze({
    id: "one-to-one-customization",
    sourceText: "1V1专属定制：从路线节奏、酒店房型到在地体验持续跟进",
    customerValue: "由专属定制师围绕真实需求持续沟通和优化方案。",
    sourceRefs: Object.freeze(["app/src/App.jsx#DEFAULT_DESIGNER"]),
  }),
  Object.freeze({
    id: "dedicated-service-group",
    sourceText: "专属服务群：从确认到出行保持服务沟通",
    customerValue: "下单确认后通过专属服务群持续衔接出行事项。",
    sourceRefs: Object.freeze(["app/src/App.jsx#RESERVATION_STEPS"]),
  }),
]);

export function publicSheyouProductValues() {
  return SHEYOU_PRODUCT_VALUES.map((item) => ({
    id: item.id,
    sourceText: item.sourceText,
    customerValue: item.customerValue,
    sourceRefs: [...item.sourceRefs],
  }));
}
