import assert from "node:assert/strict";
import test from "node:test";
import { buildRendererUnresolvedItem, isNonBlockingImageClarityIssue, normalizeRenderIssues } from "../server/simple-render-issues.mjs";

test("图片分辨率和放大倍数只形成质量提醒，不阻断成品", () => {
  const issues = normalizeRenderIssues([
    { severity: "blocker", code: "image_upscale_excessive", message: "图片放大 1.61 倍，建议换更清晰图片", path: "days.3.spots.0" },
    { severity: "blocker", code: "text_overflow", message: "文字溢出", path: "days.3.description" },
  ]);
  assert.equal(issues[0].severity, "warning");
  assert.equal(issues[0].blocking, false);
  assert.equal(issues[1].severity, "blocker");
  assert.equal(isNonBlockingImageClarityIssue({ message: "图片无法解码，清晰度未知" }), false);
});

test("Renderer 阻断事项保存并展示真正的版面失败原因", () => {
  const item = buildRendererUnresolvedItem({
    status: "blocked",
    qa: { issues: [
      { severity: "blocker", code: "image_upscale_excessive", message: "图片放大过多" },
      { severity: "blocker", code: "text_overflow", message: "DAY 4 正文溢出" },
      { severity: "blocker", code: "footer_missing", message: "固定品牌页脚缺失" },
    ] },
  });
  assert.deepEqual(item.error.details, ["DAY 4 正文溢出", "固定品牌页脚缺失"]);
  assert.match(item.error.message, /DAY 4 正文溢出/);
  assert.doesNotMatch(item.error.message, /图片放大过多/);
  assert.equal(item.qa.issues.find((issue) => issue.code === "image_upscale_excessive").severity, "warning");
});
