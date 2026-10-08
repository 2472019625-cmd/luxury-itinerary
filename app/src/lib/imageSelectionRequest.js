async function json(response) {
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || '图片保存失败'), { code: value.code });
  return value;
}

let fallbackSequence = 0;
function imageSelectionRequestId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Only correlates a save and its recovery GET; never used for authorization.
  return `image-${Date.now().toString(36)}-${++fallbackSequence}-${Math.random().toString(36).slice(2)}`;
}

export async function selectImageWithRecovery({ projectId, slotId, body, fetchImpl = fetch, requestId = imageSelectionRequestId() }) {
  const base = `/api/simple/projects/${projectId}/manual-images`;
  const slotBase = `${base}/${encodeURIComponent(slotId)}`;
  try {
    return await json(await fetchImpl(`${slotBase}/select`, { ...body,
      headers: { ...body.headers, 'x-request-id': requestId, 'x-image-response': 'compact' }, signal: AbortSignal.timeout(60000) }));
  } catch (error) {
    if (!['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) throw error;
    // A lost response is an unknown result, never permission to submit again.
    let state;
    try { state = await json(await fetchImpl(`${slotBase}/selection-state?requestId=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(10000) })); }
    catch { /* retain unknown status */ }
    if (!state?.saved) throw Object.assign(new Error('保存结果尚未确认，请稍后刷新核对，避免重复替换。'), { code: 'image_save_unconfirmed' });
    try {
      const payload = await json(await fetchImpl(base, { signal: AbortSignal.timeout(15000) }));
      return { ...payload, imageSaveMessage: state.renderFailed ? '图片已保存，但成品检查未通过，请查看对应提示。' : '图片已保存，正在更新成品检查状态。' };
    } catch {
      throw Object.assign(new Error('图片已保存，但页面状态未能更新，请刷新查看。'), { code: 'image_saved_refresh_failed' });
    }
  }
}
