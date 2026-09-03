import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { APPROVED_PAYMENT, APPROVED_PAYMENT_QR_SHA256, SIMPLE_PIPELINE_DEFAULT_ORIGIN, applyApprovedFixedModules, validateApprovedPayment } from "../server/simple-fixed-modules.mjs";
import { reviewFixedModuleLayout, runSimpleRenderer } from "../server/simple-renderer.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const sample = JSON.parse(await readFile(path.join(appRoot, "data", "sample-itinerary.json"), "utf8"));

test("缺少指定收款账户板块时 Simple Renderer 必须阻断", async () => {
  const data = structuredClone(sample);
  delete data.payment;
  const result = await runSimpleRenderer({ data, projectId: "missing-payment", root: appRoot });
  assert.equal(result.status, "blocked");
  assert.equal(result.rendererCalls, 0);
  assert.ok(result.qa.issues.some((item) => item.module === "指定收款账户/二维码板块"));
});

test("没有 notes 时 Simple Renderer 必须阻断且不能调用实际渲染", async () => {
  const data = structuredClone(sample);
  data.notes = [];
  const result = await runSimpleRenderer({ data, projectId: "missing-notes", root: appRoot });
  assert.equal(result.status, "blocked");
  assert.equal(result.rendererCalls, 0);
  assert.ok(result.qa.issues.some((item) => item.code === "fixed_notes_missing" && item.module === "旅行准备与注意事项"));
});

test("批准收款数据和本机二维码资产完整，且伪造字段不能通过", () => {
  const approved = validateApprovedPayment(APPROVED_PAYMENT, { root: appRoot });
  assert.equal(approved.passed, true);
  assert.equal(approved.assetStatus, "approved");
  assert.equal(approved.actualAssetHash, APPROVED_PAYMENT_QR_SHA256);

  const injected = applyApprovedFixedModules({ payment: { bankAccount: "000000000000000" } });
  assert.deepEqual(injected.payment, APPROVED_PAYMENT);
  const fake = validateApprovedPayment({ ...APPROVED_PAYMENT, bankAccount: "000000000000000" }, { root: appRoot });
  assert.equal(fake.passed, false);
  assert.deepEqual(fake.mismatchedFields, ["bankAccount"]);
});

test("固定模块布局检查会返回明确模块名", () => {
  const complete = { present: true, complete: true, missingParts: [] };
  const issues = reviewFixedModuleLayout(
    { booking: true, security: true, payment: true, notes: true, footer: true },
    { fixedModules: { booking: complete, security: complete, payment: { present: false, complete: false, missingParts: ["收款账户板块"] }, notes: complete, footer: complete } },
  );
  assert.deepEqual(issues.map((item) => item.module), ["指定收款账户/二维码板块"]);
  assert.equal(issues[0].code, "fixed_module_missing");
});

test("Simple Pipeline 默认入口固定为新智能体4174", () => {
  assert.equal(SIMPLE_PIPELINE_DEFAULT_ORIGIN, "http://127.0.0.1:4174");
  assert.equal(SIMPLE_PIPELINE_DEFAULT_ORIGIN.includes("4173"), false);
});
