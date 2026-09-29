const resolutionCodes = new Set(['image_resolution_insufficient', 'resolution_failed', 'upload_resolution_low']);

export function imageActionFailureMessage(kind, error) {
  if (resolutionCodes.has(error?.code)) return `当前位置无法使用这张原图：${error.message}`;
  const prefix = kind === 'search' ? '搜索失败，请重试' : kind === 'upload' ? '上传或保存失败，请重试' : '图片替换失败，请重试';
  return `${prefix}${error?.message ? `：${error.message}` : ''}`;
}

export function candidateResolutionForTarget(candidate, policy = {}) {
  const storedOriginal = candidate?.originalDownloaded === true || candidate?.userProvided === true
    || (candidate?.originalDownloaded !== false && Boolean(candidate?.localUrl));
  const width = Number(storedOriginal ? candidate?.width : candidate?.originalWidth);
  const height = Number(storedOriginal ? candidate?.height : candidate?.originalHeight);
  if (!(width > 0 && height > 0)) return { status: 'pending', label: '原图尺寸待校验' };
  if (width < Number(policy.minWidth || 0) || height < Number(policy.minHeight || 0)) return {
    status: 'insufficient', label: policy.allowManualLowResolution
      ? `原图 ${width}×${height}，建议 ${policy.minWidth}×${policy.minHeight}；清晰度偏低，可确认使用`
      : `原图 ${width}×${height}，当前位置至少需要 ${policy.minWidth}×${policy.minHeight}`,
  };
  return { status: 'sufficient', label: `原图 ${width}×${height} · 尺寸适合当前位置` };
}

export function candidateResolutionAllowsManualChoice(candidate, policy = {}) {
  return policy.allowManualLowResolution === true || candidateResolutionForTarget(candidate, policy).status !== 'insufficient';
}
