const IMAGE_CLARITY_CODES = new Set([
  "image_upscale_excessive",
  "image_resolution_insufficient",
  "image_low_resolution",
  "low_resolution_image",
  "image_pixel_density_low",
  "image_clarity_warning",
]);

function issueText(issue = {}) {
  return [issue.code, issue.message, issue.reason].filter(Boolean).join(" ");
}

export function isNonBlockingImageClarityIssue(issue = {}) {
  const code = String(issue.code || "").toLowerCase();
  if (IMAGE_CLARITY_CODES.has(code)) return true;
  const text = issueText(issue);
  if (/破图|无法(?:加载|解码|渲染)|损坏|空白图片|图片缺失/.test(text)) return false;
  return /(?:图片)?(?:清晰度|分辨率|像素密度|低像素|低清|放大倍数|过度放大)|image[_ -]?(?:upscale|resolution|clarity|pixel density)|low[_ -]?resolution/i.test(text);
}

export function normalizeRenderIssues(issues = []) {
  return (Array.isArray(issues) ? issues : []).map((value) => {
    const issue = typeof value === "string" ? { code: "renderer_issue", message: value } : value || {};
    return isNonBlockingImageClarityIssue(issue)
      ? { ...issue, severity: "warning", blocking: false, policy: "image_clarity_non_blocking" }
      : { ...issue, severity: issue.severity || "blocker" };
  });
}

function uniqueIssues(issues = []) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.code || "unknown"}:${issue.path || issue.selector || ""}:${issue.message || issue.reason || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rendererQaIssues(renderResult = {}) {
  return uniqueIssues(normalizeRenderIssues([
    ...(renderResult.qa?.issues || []),
    ...(renderResult.finalAttempt?.qa?.issues || []),
  ]));
}

export function rendererBlockingMessages(renderResult = {}) {
  return rendererQaIssues(renderResult)
    .filter((issue) => issue.severity === "blocker")
    .map((issue) => issue.message || issue.reason || issue.code)
    .filter(Boolean);
}

export function buildRendererUnresolvedItem(renderResult = {}, fallbackMessage = "正式成品版面检查未通过") {
  const details = rendererBlockingMessages(renderResult);
  const fallbackError = renderResult.error || {};
  const message = details.length
    ? `成品检查未通过：${details.join("；")}`
    : fallbackError.message || fallbackMessage;
  return {
    kind: "renderer",
    id: "renderer:2000",
    status: renderResult.status || "failed",
    required: true,
    error: { code: fallbackError.code || "renderer_failed", message, details },
    qa: { ...(renderResult.qa || {}), issues: rendererQaIssues(renderResult) },
  };
}
