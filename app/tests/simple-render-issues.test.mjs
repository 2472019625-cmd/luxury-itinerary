import assert from "node:assert/strict";
import test from "node:test";
import { buildRendererUnresolvedItem, isNonBlockingImageClarityIssue, normalizeRenderIssues } from "../server/simple-render-issues.mjs";
import { layoutOverflowIssue } from "../server/simple-renderer.mjs";
import { readFileSync } from "node:fs";

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

test("截屏程序失败与版面不通过分开，技术堆栈不进入待处理", () => {
  const item = buildRendererUnresolvedItem({ status: "failed", error: { code: "render_capture_failed", message: "Error: Export tile dimensions differ at 6000", diagnostic: "at captureLongElement (file:///D:/private/render.mjs:24:77)" } });
  assert.equal(item.error.code, "render_capture_failed");
  assert.match(item.error.message, /长图截取失败/);
  assert.doesNotMatch(JSON.stringify(item), /file:\/\/\/|private|版面检查未通过/);
});

test("版面溢出携带可定位路径，裁切视窗不参与溢出扫描", () => {
  const issue = layoutOverflowIssue({ editPath: "days.3", selector: "p.day-description" });
  assert.equal(issue.targetPath, "days.3");
  assert.match(issue.message, /DAY 04/);
  assert.doesNotMatch(issue.message, /p\.day-description/);
  const renderer = readFileSync(new URL("../renderer/render.mjs", import.meta.url), "utf8");
  assert.match(renderer, /!element\.classList\.contains\('crop-slot-viewport'\)/);
  assert.match(renderer, /element\.closest\('\[data-edit-path\]'\)/);
});
