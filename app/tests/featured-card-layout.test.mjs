import assert from "node:assert/strict";
import test from "node:test";
import { deriveFeaturedCardLayout } from "../src/lib/featuredCardLayout.js";

const ids = (layout) => layout.entries.map((entry) => entry.item.id);

test("even card counts retain their order and existing wide state", () => {
  const cards = [{ id: "a" }, { id: "b", layout: "wide" }, { id: "c" }, { id: "d" }];
  const layout = deriveFeaturedCardLayout(cards, "dining");
  assert.deepEqual(ids(layout), ["a", "b", "c", "d"]);
  assert.deepEqual(layout.entries.map((entry) => entry.isFeatured), [false, true, false, false]);
});

test("odd card counts produce one featured card and an even remainder without mutating data", () => {
  for (const count of [3, 5, 7]) {
    const cards = Array.from({ length: count }, (_, index) => ({ id: `card-${index}`, title: `普通项目${index}`, images: [{ src: `${index}.jpg` }] }));
    const before = structuredClone(cards);
    const layout = deriveFeaturedCardLayout(cards, "dining");
    assert.equal(layout.entries.filter((entry) => entry.isFeatured).length, 1);
    assert.equal((layout.entries.length - 1) % 2, 0);
    assert.deepEqual(cards, before);
  }
});

test("an existing wide card stays authoritative and keeps a balanced position", () => {
  const cards = [
    { id: "a", title: "项目 A", images: [{ src: "a.jpg" }] },
    { id: "b", title: "项目 B", images: [{ src: "b.jpg" }] },
    { id: "featured", title: "项目 C", layout: "wide", images: [{ src: "c.jpg" }] },
    { id: "d", title: "项目 D", images: [{ src: "d.jpg" }] },
    { id: "e", title: "项目 E", images: [{ src: "e.jpg" }] },
  ];
  const layout = deriveFeaturedCardLayout(cards, "dining");
  assert.deepEqual(ids(layout), ["a", "b", "featured", "d", "e"]);
  assert.equal(layout.entries[2].isFeatured, true);
});

test("destination-specific wording has no special ranking meaning", () => {
  const cards = [
    { id: "keyword", category: "草原飞机", images: [{ src: "a.jpg" }] },
    {
      id: "complete",
      category: "常规交通",
      serviceLevel: "专属服务",
      usageLabel: "全程使用",
      editorialCopy: "包含完整且可用于卡片展示的说明文字。",
      images: [{ src: "b.jpg", width: 2400, height: 1600, actualSubject: "vehicle" }],
    },
    { id: "plain", category: "其他交通", images: [{ src: "c.jpg" }] },
  ];
  const layout = deriveFeaturedCardLayout(cards, "transport");
  assert.equal(layout.entries.find((entry) => entry.isFeatured).item.id, "complete");
});

test("featured placement uses the nearest complete row boundary", () => {
  const cards = [
    { id: "a", title: "A", images: [{ src: "a.jpg" }] },
    { id: "b", title: "B", images: [{ src: "b.jpg" }] },
    { id: "c", title: "C", images: [{ src: "c.jpg" }] },
    { id: "featured", title: "D", layout: "wide", images: [{ src: "d.jpg" }] },
    { id: "e", title: "E", images: [{ src: "e.jpg" }] },
  ];
  assert.deepEqual(ids(deriveFeaturedCardLayout(cards, "dining")), ["a", "b", "featured", "c", "e"]);
});

test("generic priority metadata outranks automatic visual scoring", () => {
  const cards = [
    { id: "visual", title: "完整项目", editorialCopy: "信息非常完整。", images: [{ src: "a.jpg", width: 3000, height: 2000 }] },
    { id: "priority", title: "重点项目", priority: "primary", images: [{ src: "b.jpg" }] },
    { id: "plain", title: "普通项目", images: [{ src: "c.jpg" }] },
  ];
  assert.equal(deriveFeaturedCardLayout(cards, "dining").entries.find((entry) => entry.isFeatured).item.id, "priority");
});
