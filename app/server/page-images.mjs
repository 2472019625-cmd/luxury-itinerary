import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const blockedHosts = new Set(["localhost", "0.0.0.0", "::", "::1"]);

function isPrivateIp(address) {
  if (!net.isIP(address)) return false;
  if (address.includes(":")) return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("不支持的图片地址协议");
  if (blockedHosts.has(url.hostname.toLowerCase())) throw new Error("已阻止本地网络地址");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((item) => isPrivateIp(item.address))) throw new Error("已阻止私有网络地址");
  return url;
}

export async function fetchPublicUrl(value, { signal, headers = {}, timeoutMs = 20_000, maxRedirects = 5, fetchImpl = fetch } = {}) {
  let current = (await assertPublicUrl(value)).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      await assertPublicUrl(current);
      const response = await fetchImpl(current, { redirect: 'manual', headers, signal: combinedSignal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向响应缺少地址');
      current = new URL(location, current).href;
    }
    throw new Error('重定向次数过多');
  } finally { clearTimeout(timer); }
}

function absolute(value, baseUrl) {
  if (!value || /^data:/i.test(value)) return null;
  try { return new URL(value, baseUrl).href; } catch { return null; }
}

function bestSrcset(value, baseUrl) {
  const choices = String(value || "").split(",").map((part) => part.trim().split(/\s+/)).filter(([src]) => src);
  choices.sort((a, b) => parseInt(b[1], 10) - parseInt(a[1], 10));
  return absolute(choices[0]?.[0], baseUrl);
}

export async function extractPageImages(page, { signal, maxImages = 36 } = {}) {
  const safeUrl = await assertPublicUrl(page.pageUrl);
  const response = await fetchPublicUrl(safeUrl, {
    headers: { "user-agent": "Mozilla/5.0 LuxuryTravelImageResearch/1.0", accept: "text/html,application/xhtml+xml" },
    signal,
    timeoutMs: 20_000,
  });
  const type = response.headers.get("content-type") || "";
  if (!response.ok) return [];
  if (type.startsWith("image/")) return [{ ...page, imageUrl: response.url, kind: "direct-search-result", alt: page.title || "" }];
  if (!type.includes("text/html")) return [];
  const html = await response.text();
  if (html.length > 5_000_000) return [];
  const $ = cheerio.load(html);
  const candidates = [];
  const push = (imageUrl, kind, alt = "") => {
    if (!imageUrl || candidates.some((item) => item.imageUrl === imageUrl)) return;
    candidates.push({ ...page, imageUrl, kind, alt: String(alt).trim().slice(0, 240) });
  };
  [
    ['meta[property="og:image"]', 'content', 'og:image'],
    ['meta[property="og:image:secure_url"]', 'content', 'og:image'],
    ['meta[name="twitter:image"]', 'content', 'twitter:image'],
  ].forEach(([selector, attr, kind]) => $(selector).each((_, element) => push(absolute($(element).attr(attr), response.url), kind)));
  $('img').each((_, element) => {
    const node = $(element);
    const src = bestSrcset(node.attr('srcset') || node.attr('data-srcset'), response.url) || absolute(node.attr('data-src') || node.attr('data-lazy-src') || node.attr('src'), response.url);
    const alt = node.attr('alt') || node.attr('title') || '';
    if (!/logo|icon|avatar|sprite|favicon|pixel|tracking/i.test(`${src} ${alt} ${node.attr('class') || ''}`)) push(src, 'page-image', alt);
  });
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const visit = (value) => {
        if (typeof value === 'string' && /^https?:\/\//i.test(value) && /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(value)) push(value, 'json-ld');
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { if (/image|photo|contenturl|thumbnail/i.test(key)) visit(item); });
      };
      visit(JSON.parse($(element).text()));
    } catch { /* Ignore malformed publisher metadata. */ }
  });
  return candidates.slice(0, maxImages);
}
