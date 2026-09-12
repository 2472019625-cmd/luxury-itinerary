import test from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationActionItems, matchingPriceOffers } from "../src/lib/confirmationActionItems.js";

function projectWith(overrides = {}) {
  const data = {
    destination: "肯尼亚",
    title: "肯尼亚8日顶奢",
    startDate: null,
    endDate: null,
    adults: null,
    children: 0,
    days: Array.from({ length: 8 }, (_, index) => ({ day: index + 1 })),
    sourceImportCoverage: {
      priceOffers: [
        { amount: 98880, period: "2026.08.01-2026.10.14" },
        { amount: 83880, period: "2026.10.15-2026.10.30" },
      ],
    },
    ...overrides,
  };
  return {
    title: data.title,
    customerName: "陈女士",
    data,
    confirmationSelections: { childrenConfirmed: true },
    recognition: {
      warnings: ["原文件存在 2 个不同档期价格；现有 totalPrice 仅展示起售价，当前 schema 无法完整承载多档价格。"],
    },
  };
}

test("缺失日期、成人和儿童数会成为当前待确认项", () => {
  const project = projectWith({ children: null });
  const items = buildConfirmationActionItems({ project, validation: { issues: [] } });
  assert.deepEqual(items.map((item) => item.id), [
    "field:startDate",
    "field:endDate",
    "field:adults",
    "field:children",
    "source:multiPricePeriod",
  ]);
  assert.match(items.map((item) => item.title).join(" "), /儿童/);
  assert.equal(items.at(-1).title, "价格档期");
  assert.match(items.at(-1).description, /原报价包含 2 个价格档期/);
  assert.doesNotMatch(items.at(-1).description, /totalPrice|schema|原始价格证据/i);
});

test("填写表单后仍需明确保存本次采用的价格档期", () => {
  const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2 });
  const items = buildConfirmationActionItems({ project, validation: { issues: [] } });
  assert.deepEqual(items.map((item) => item.id), ["source:multiPricePeriod"]);
});

test("无年份的月日档期也能按出发日期唯一匹配", () => {
  const offers = [{ amount: 53880, period: "08.01-09.30" }, { amount: 48880, period: "10.01-10.31" }];
  assert.equal(matchingPriceOffers("2026-10-05", offers).length, 1);
  assert.equal(matchingPriceOffers("2026-10-05", offers)[0].amount, 48880);
});

test("客户称呼为空时必须确认，儿童为0仍是合法值", () => {
  const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2 });
  project.customerName = "";
  project.confirmationSelections.priceOffer = { mode: "source", sourceKey: "2026.08.01-2026.10.14|98880", period: "2026.08.01-2026.10.14", amount: 98880, unit: "元 / 人" };
  assert.deepEqual(buildConfirmationActionItems({ project, validation: { issues: [] } }).map((item) => item.id), ["field:customerName"]);
});

test("儿童空值和明确的0严格区分", () => {
  const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2, children: 0 });
  project.confirmationSelections = { priceOffer: { mode: "source", sourceKey: "2026.08.01-2026.10.14|98880", period: "2026.08.01-2026.10.14", amount: 98880, unit: "元 / 人" } };
  assert.deepEqual(buildConfirmationActionItems({ project, validation: { issues: [] } }).map((item) => item.id), ["field:children"]);
  project.confirmationSelections.childrenConfirmed = true;
  assert.deepEqual(buildConfirmationActionItems({ project, validation: { issues: [] } }), []);
});

test("选择原报价、调整金额或填写自定义报价后可解除价格确认", () => {
  for (const priceOffer of [
    { mode: "source", sourceKey: "2026.08.01-2026.10.14|98880", period: "2026.08.01-2026.10.14", amount: 98880, unit: "元 / 人" },
    { mode: "adjusted", sourceKey: "2026.08.01-2026.10.14|98880", period: "2026.08.01-2026.10.14", amount: 92880, unit: "元 / 人" },
    { mode: "custom", sourceKey: null, amount: 86880, unit: "元 / 人" },
  ]) {
    const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2 });
    project.confirmationSelections.priceOffer = priceOffer;
    assert.deepEqual(buildConfirmationActionItems({ project, validation: { issues: [] } }), []);
  }
});

test("无法唯一匹配价格档期时保留用户可读提示", () => {
  const project = projectWith({ startDate: "2026-11-01", endDate: "2026-11-08", adults: 2 });
  const items = buildConfirmationActionItems({ project, validation: { issues: [] } });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "source:multiPricePeriod");
  assert.match(items[0].description, /未能唯一对应原报价/);
});

test("自定义报价只要求合法金额和计价单位，并返回具体缺失提示", () => {
  const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2 });
  project.confirmationSelections.priceOffer = { mode: "custom", sourceKey: null, amount: "", unit: "元 / 人起" };
  let items = buildConfirmationActionItems({ project, validation: { issues: [] } });
  assert.equal(items[0].title, "本次采用金额");
  assert.equal(items[0].description, "请填写本次采用金额。");
  project.confirmationSelections.priceOffer = { mode: "custom", sourceKey: null, amount: 11111, unit: "" };
  items = buildConfirmationActionItems({ project, validation: { issues: [] } });
  assert.equal(items[0].title, "计价单位");
  project.confirmationSelections.priceOffer.unit = "元 / 人起";
  assert.deepEqual(buildConfirmationActionItems({ project, validation: { issues: [] } }), []);
});

test("后端确认项与已选决定复用同一待确认列表", () => {
  const project = projectWith({ startDate: "2026-09-29", endDate: "2026-10-06", adults: 2 });
  project.confirmationSelections.priceOffer = { mode: "source", sourceKey: "2026.08.01-2026.10.14|98880", period: "2026.08.01-2026.10.14", amount: 98880, unit: "元 / 人" };
  const confirmation = { confirmationId: "confirm-1", status: "pending", question: "请确认酒店房型", reason: "原报价未明确" };
  assert.equal(buildConfirmationActionItems({ project, validation: { issues: [] }, confirmations: [confirmation] }).length, 1);
  assert.equal(buildConfirmationActionItems({ project, validation: { issues: [] }, confirmations: [confirmation], decisions: { "confirm-1": "choice-1" } }).length, 0);
});
