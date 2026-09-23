export async function assertSimpleRendererOrigin(origin, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let url;
  try {
    url = new URL('/', origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw Object.assign(new Error('本地成品渲染入口无效'), { code: 'renderer_origin_invalid' });
  }
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !String(response.headers.get('content-type') || '').includes('text/html')) {
      throw Object.assign(new Error('本地页面尚未构建或渲染入口不可用，请先构建页面并检查服务'), { code: 'renderer_origin_unavailable' });
    }
    await response.body?.cancel();
    return { ready: true, origin: url.origin };
  } catch (error) {
    if (error.code === 'renderer_origin_unavailable') throw error;
    throw Object.assign(new Error('本地成品渲染入口无法连接，请检查当前服务'), { code: 'renderer_origin_unavailable', cause: error });
  }
}
