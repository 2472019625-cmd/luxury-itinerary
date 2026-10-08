import { createHash } from 'node:crypto';
import { safeErrorDetails } from '../server/operation-trace.mjs';

// Resource URLs may contain signed credentials. Only opaque IDs and controlled
// resource types leave the browser; diagnostics never affect rendering gates.
export function attachRenderPageDiagnostics(page, trace) {
  const pending = new Map();
  let requestFailures = 0, pageErrors = 0, badResponses = 0;
  const describe = request => ({
    resourceId: createHash('sha256').update(request.url()).digest('hex').slice(0, 16),
    resourceType: request.resourceType(),
  });
  const listeners = {
    request: request => { pending.set(request, describe(request)); },
    requestfinished: request => { pending.delete(request); },
    requestfailed: request => {
      requestFailures++;
      const code = /\b(ERR_[A-Z_]+)\b/.exec(request.failure()?.errorText || '')?.[1] || 'browser_request_failed';
      trace.emit('resource_failed', { ...describe(request), code });
      pending.delete(request);
    },
    response: response => {
      if (response.status() >= 400) { badResponses++; trace.emit('resource_response', { ...describe(response.request()), statusCode: response.status() }); }
    },
    pageerror: error => { pageErrors++; trace.emit('page_error', safeErrorDetails(error)); },
  };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  return {
    snapshot() {
      trace.emit('page_snapshot', { pendingCount: pending.size, requestFailures, pageErrors, badResponses });
      for (const resource of [...pending.values()].slice(0, 20)) trace.emit('pending_resource', resource);
    },
    detach() { for (const [event, listener] of Object.entries(listeners)) page.off(event, listener); },
  };
}

export async function recordRenderDomSnapshot(page, trace, timeoutMs = 1000) {
  let timer;
  try {
    const result = await Promise.race([
      page.evaluate(() => ({
        itineraryPresent: Boolean(document.querySelector('#itinerary')),
        documentComplete: document.readyState === 'complete',
        fontsLoaded: document.fonts.status === 'loaded',
        imageCount: document.images.length,
        pendingImageCount: [...document.images].filter(image => !image.complete).length,
        brokenImageCount: [...document.images].filter(image => image.complete && !image.naturalWidth).length,
      })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    trace.emit('dom_snapshot', result || { snapshotUnavailable: true });
  } catch (error) { trace.emit('dom_snapshot_failed', safeErrorDetails(error)); }
  finally { clearTimeout(timer); }
}
