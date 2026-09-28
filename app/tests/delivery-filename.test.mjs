import test from "node:test";
import assert from "node:assert/strict";
import { cleanDeliveryFilenameBase, defaultDeliveryFilenameBase, deliveryContentDisposition, deliveryDownloadUrl } from "../src/lib/deliveryFilename.js";

test("customer-facing filename includes a known customer once and no technical suffix", () => {
  assert.equal(defaultDeliveryFilenameBase({ data: { title: "肯尼亚10日经典Safari之旅" }, customerName: "张女士" }), "肯尼亚10日经典Safari之旅_张女士_行程方案");
  assert.equal(defaultDeliveryFilenameBase({ title: "张女士肯尼亚行程", customerName: "张女士" }), "张女士肯尼亚行程_行程方案");
  assert.equal(defaultDeliveryFilenameBase({ title: "肯尼亚行程" }), "肯尼亚行程_行程方案");
  assert.match(defaultDeliveryFilenameBase({ title: "肯尼亚超长行程名称".repeat(8), customerName: "张女士" }), /_张女士_行程方案$/);
});

test("custom names are sanitized and applied to actual download response", () => {
  const base = cleanDeliveryFilenameBase('张女士: 行程/方案.png');
  assert.equal(base, "张女士 行程 方案");
  assert.equal(deliveryDownloadUrl("/api/simple/projects/abc/output", base), "/api/simple/projects/abc/output?downloadName=%E5%BC%A0%E5%A5%B3%E5%A3%AB+%E8%A1%8C%E7%A8%8B+%E6%96%B9%E6%A1%88");
  assert.equal(deliveryContentDisposition(base), `attachment; filename="itinerary.png"; filename*=UTF-8''${encodeURIComponent("张女士 行程 方案.png")}`);
  assert.equal(deliveryDownloadUrl("/api/simple/projects/abc/output", "  "), "");
});
