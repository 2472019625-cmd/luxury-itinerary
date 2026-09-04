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
  let normalized = String(value || "").trim().replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  normalized = normalized.replace(/^https:(https?:\/\/)/i, "$1");
  const nestedScheme = normalized.slice(8).search(/https?:\/\//i);
  if (nestedScheme >= 0) normalized = normalized.slice(8 + nestedScheme);
  if (!normalized || /^data:|^blob:/i.test(normalized)) return null;
  try { return new URL(normalized, baseUrl).href; } catch { return null; }
}

function srcsetUrls(value, baseUrl) {
  return String(value || "").split(",").map((part) => {
    const [src, descriptor = ""] = part.trim().split(/\s+/);
    const numeric = Number.parseFloat(descriptor) || 0;
    return { url: absolute(src, baseUrl), numeric };
  }).filter((item) => item.url).sort((a, b) => b.numeric - a.numeric).map((item) => item.url);
}

function imageLike(value) {
  const text = String(value || "");
  if (/\.(?:svg|gif|ico|bmp|tiff?)(?:[?#]|$)/i.test(text)) return false;
  return /\.(?:avif|jpe?g|png|webp)(?:[?#]|$)/i.test(text) || /(?:image|photo|media|gallery|cdn|asset)/i.test(text);
}

export function canonicalImageAssetKey(value) {
  try {
    const parsed = new URL(String(value || ""));
    for (const key of ["w", "width", "imwidth", "wid", "h", "height", "imheight", "hei", "q", "quality", "fm", "format", "fl", "fit", "crop", "dpr"]) parsed.searchParams.delete(key);
    parsed.hash = "";
    return parsed.href;
  } catch { return String(value || "").trim(); }
}

function imageUrlSemanticText(value) {
  try {
    const parsed = new URL(String(value || ""));
    return decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/[_-]+/g, " ");
  } catch { return String(value || "").replace(/[_-]+/g, " "); }
}

function highResolutionVariants(value, baseUrl) {
  const resolved = absolute(value, baseUrl);
  if (!resolved) return [];
  const variants = [];
  const push = (url) => { if (url && !variants.includes(url)) variants.push(url); };
  try {
    const parsed = new URL(resolved);
    const widthKeys = ["w", "width", "imwidth", "wid"];
    const heightKeys = ["h", "height", "imheight", "hei"];
    const wordpressOriginal = parsed.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)$)/i, "");
    if (wordpressOriginal !== parsed.pathname) {
      const original = new URL(parsed.href); original.pathname = wordpressOriginal;
      widthKeys.forEach((key) => { if (original.searchParams.has(key)) original.searchParams.set(key, "2400"); });
      heightKeys.forEach((key) => original.searchParams.delete(key));
      push(original.href);
    }
    if (widthKeys.some((key) => parsed.searchParams.has(key)) || heightKeys.some((key) => parsed.searchParams.has(key))) {
      const large = new URL(parsed.href);
      widthKeys.forEach((key) => { if (large.searchParams.has(key)) large.searchParams.set(key, "2400"); });
      heightKeys.forEach((key) => large.searchParams.delete(key));
      push(large.href);
    }
    if (/res\.cloudinary\.com/i.test(parsed.hostname) && /\/image\/upload\//.test(parsed.pathname)) {
      const original = new URL(parsed.href);
      original.pathname = original.pathname.replace(/(\/image\/upload\/)(?:[^/]+,)*[^/]+\//, "$1");
      push(original.href);
    }
  } catch { /* The resolved URL was already validated by URL(). */ }
  push(resolved);
  return variants;
}

function scriptImageUrls(value) {
  const normalized = String(value || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  return [...normalized.matchAll(/https?:\/\/[^"'<>\s\\]+?\.(?:jpe?g|png|webp)(?:\?[^"'<>\s\\]*)?/gi)].map((match) => match[0]);
}

const semanticAliasGroups = [
  [/(?:walking safari|bush walk|guided walk|徒步游猎|丛林徒步)/i, ["walking safari", "bush walk", "guided walk", "walking", "on foot", "徒步", "步行游猎"]],
  [/(?:night game drive|night safari|夜间游猎|夜游)/i, ["night game drive", "night safari", "night drive", "nocturnal", "after dark", "夜间游猎", "夜游"]],
  [/(?:anti[- ]?poaching|observation post|ranger|conservation|反偷猎|观察站)/i, ["anti-poaching", "anti poaching", "observation post", "ranger", "game scout", "patrol", "conservation", "反偷猎", "观察站", "巡护员"]],
  [/(?:maasai|masai|马赛)/i, ["maasai village", "masai village", "maasai", "masai", "cultural village", "马赛", "部落村落"]],
];
const ignoredSemanticTokens = new Set(["safari", "travel", "photo", "photos", "photography", "official", "gallery", "singita", "grumeti", "serengeti", "tanzania", "activity", "activities", "experience", "visit", "game", "drive"]);
const genericHotelPattern = /\b(?:pool|swimming|room|rooms|bedroom|suite|restaurant|dining|lounge|spa|bathroom|bathtub|terrace)\b|泳池|客房|卧室|餐厅|酒廊|水疗|浴室|浴缸/i;

function compactText(value, maxLength = 1400) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function semanticLexicon(terms = []) {
  const normalized = terms.map((item) => compactText(item, 240)).filter(Boolean);
  const joined = normalized.join(" ");
  const phrases = [...normalized];
  for (const [trigger, aliases] of semanticAliasGroups) if (trigger.test(joined)) phrases.push(...aliases);
  const tokens = new Set(phrases.flatMap((item) => item.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)).filter((token) => token.length >= 3 && !ignoredSemanticTokens.has(token)));
  return { phrases: [...new Set(phrases.map((item) => item.toLowerCase()).filter((item) => item.length >= 4))], tokens: [...tokens] };
}

function semanticAssessment(value, lexicon) {
  const normalized = compactText(value).toLowerCase();
  if (!normalized || (!lexicon.phrases.length && !lexicon.tokens.length)) return { score: 0, matches: [], genericPenalty: 0 };
  const phraseMatches = lexicon.phrases.filter((phrase) => normalized.includes(phrase));
  const tokenMatches = lexicon.tokens.filter((token) => normalized.includes(token));
  const matches = [...new Set([...phraseMatches, ...tokenMatches])];
  const score = Math.min(90, phraseMatches.length * 24 + tokenMatches.length * 7);
  return { score, matches: matches.slice(0, 12), genericPenalty: score === 0 && genericHotelPattern.test(normalized) ? 36 : 0 };
}

function nodeSemanticContext($, element) {
  const node = $(element);
  const values = [];
  const add = (value) => { const text = compactText(value, 520); if (text && !values.includes(text)) values.push(text); };
  for (const attr of ["alt", "title", "aria-label", "data-caption", "data-description", "data-title", "data-alt", "data-gallery-caption"]) add(node.attr(attr));
  add(node.closest("a").attr("title"));
  add(node.closest("a").attr("aria-label"));
  add(node.closest("a").text());
  add(node.closest("figure").find("figcaption").first().text());
  add(node.prevAll("figcaption,h1,h2,h3,h4,h5,h6,p,.caption,.gallery-caption").first().text());
  add(node.nextAll("figcaption,h1,h2,h3,h4,h5,h6,p,.caption,.gallery-caption").first().text());
  let parent = node.parent();
  for (let depth = 0; depth < 4 && parent.length; depth += 1, parent = parent.parent()) {
    add(parent.children("h1,h2,h3,h4,h5,h6,.title,.heading,.caption,.gallery-caption,.description").first().text());
    const tagName = parent.get(0)?.tagName?.toUpperCase();
    const regionText = parent.clone().find("script,style").remove().end().text();
    if (["FIGURE", "ARTICLE", "SECTION", "LI"].includes(tagName) || (tagName === "DIV" && compactText(regionText, 2600).length < 2400)) add(regionText);
  }
  return values.join(" | ");
}

function objectSemanticText(value = {}) {
  return Object.entries(value).filter(([key, item]) => /name|title|headline|description|caption|alt|label|activity|content/i.test(key) && typeof item === "string").map(([, item]) => item).join(" | ");
}

export function extractImageCandidatesFromHtml(html, page, { responseUrl = page.pageUrl, maxImages = 36, semanticTerms = [] } = {}) {
  const $ = cheerio.load(html);
  const candidates = [];
  const lexicon = semanticLexicon(semanticTerms);
  const push = (rawUrl, kind, alt = "", highResHint = false, semanticContext = "") => {
    for (const imageUrl of highResolutionVariants(rawUrl, responseUrl)) {
      const semanticText = compactText([alt, imageUrlSemanticText(imageUrl), semanticContext].filter(Boolean).join(" | "));
      const semantic = semanticAssessment(semanticText, lexicon);
      if (!imageLike(imageUrl) || candidates.some((item) => item.imageUrl === imageUrl)) continue;
      candidates.push({ ...page, imageUrl, kind, alt: String(alt).trim().slice(0, 240), highResHint, semanticText, semanticScore: semantic.score, semanticMatches: semantic.matches, genericActivityPenalty: semantic.genericPenalty });
    }
  };
  [
    ['meta[property="og:image"]', 'content', 'og:image'],
    ['meta[property="og:image:secure_url"]', 'content', 'og:image'],
    ['meta[name="twitter:image"]', 'content', 'twitter:image'],
    ['meta[name="twitter:image:src"]', 'content', 'twitter:image'],
    ['link[rel="image_src"]', 'href', 'image-src'],
    ['link[rel="preload"][as="image"]', 'href', 'image-preload'],
  ].forEach(([selector, attr, kind]) => $(selector).each((_, element) => push($(element).attr(attr), kind, "", true)));
  $('source[srcset], source[data-srcset]').each((_, element) => {
    const node = $(element);
    const context = nodeSemanticContext($, node.closest('picture').get(0) || element);
    for (const src of srcsetUrls(node.attr('srcset') || node.attr('data-srcset'), responseUrl).slice(0, 2)) push(src, 'picture-srcset', node.attr('title') || '', true, context);
  });
  $('img').each((_, element) => {
    const node = $(element);
    const alt = node.attr('alt') || node.attr('title') || '';
    const signature = `${alt} ${node.attr('class') || ''} ${node.attr('id') || ''}`;
    if (/logo|icon|avatar|sprite|favicon|pixel|tracking/i.test(signature)) return;
    const responsive = srcsetUrls(node.attr('srcset') || node.attr('data-srcset') || node.attr('data-lazy-srcset'), responseUrl);
    const context = nodeSemanticContext($, element);
    responsive.slice(0, 2).forEach((src) => push(src, 'image-srcset', alt, true, context));
    for (const attr of ['data-original', 'data-full', 'data-full-src', 'data-zoom-image', 'data-large-file', 'data-orig-file', 'data-src', 'data-lazy-src', 'data-image', 'src']) {
      const value = node.attr(attr);
      if (value) push(value, attr === 'src' ? 'page-image' : `lazy-${attr}`, alt, attr !== 'src', context);
    }
    const anchor = node.closest('a').attr('href');
    if (anchor && /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(anchor)) push(anchor, 'gallery-link', alt, true, context);
  });
  $('[style*="background"], style').each((_, element) => {
    const css = $(element).attr('style') || $(element).text() || '';
    const context = nodeSemanticContext($, element);
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(match[1], 'css-background', $(element).attr('aria-label') || '', true, context);
  });
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (imageLike(href) && /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(href)) push(href, 'media-link', $(element).attr('title') || $(element).text(), true, nodeSemanticContext($, element));
  });
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const visit = (value, inheritedContext = "") => {
        if (Array.isArray(value)) value.forEach((item) => visit(item, inheritedContext));
        else if (value && typeof value === 'object') {
          const localContext = compactText(`${inheritedContext} ${objectSemanticText(value)}`);
          Object.entries(value).forEach(([key, item]) => { if (/image|photo|contenturl|thumbnail/i.test(key)) visit(item, localContext); else if (item && typeof item === 'object') visit(item, localContext); });
        } else if (typeof value === 'string' && (imageLike(value) || /^https?:\/\//i.test(value))) push(value, 'json-ld', '', true, inheritedContext);
      };
      visit(JSON.parse($(element).text()));
    } catch { /* Ignore malformed publisher metadata. */ }
  });
  $('script:not([type="application/ld+json"])').each((_, element) => {
    const scriptText = $(element).text().replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
    for (const url of scriptImageUrls(scriptText)) {
      const offset = scriptText.indexOf(url);
      push(url, 'embedded-media', '', true, scriptText.slice(Math.max(0, offset - 700), Math.max(0, offset) + url.length + 700));
    }
  });
  $('*').each((_, element) => {
    const attributes = element.attribs || {};
    const context = nodeSemanticContext($, element);
    for (const [name, value] of Object.entries(attributes)) if (/^data-/i.test(name) && imageLike(value)) scriptImageUrls(value).forEach((url) => push(url, `gallery-${name}`, '', true, `${context} ${objectSemanticText(attributes)}`));
  });
  const seenAssets = new Set();
  return candidates
    .sort((a, b) => (b.semanticScore - b.genericActivityPenalty) - (a.semanticScore - a.genericActivityPenalty))
    .filter((candidate) => {
      const key = canonicalImageAssetKey(candidate.imageUrl);
      if (!key || seenAssets.has(key)) return false;
      seenAssets.add(key);
      return true;
    })
    .slice(0, maxImages);
}

export async function extractPageImages(page, { signal, maxImages = 36, semanticTerms = [] } = {}) {
  const safeUrl = await assertPublicUrl(page.pageUrl);
  const response = await fetchPublicUrl(safeUrl, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 LuxuryTravelImageResearch/1.1", accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg" },
    signal,
    timeoutMs: 20_000,
  });
  const type = response.headers.get("content-type") || "";
  if (type.startsWith("image/") && response.ok) return [{ ...page, imageUrl: response.url, kind: "direct-search-result", alt: page.title || "", highResHint: true }];
  if (!type.includes("text/html")) return [];
  const requestedUrl = new URL(page.pageUrl);
  const finalUrl = new URL(response.url);
  if (requestedUrl.hostname === finalUrl.hostname && requestedUrl.pathname !== finalUrl.pathname) {
    const ignored = new Set(["activity", "activities", "experience", "experiences", "the", "at", "in", "and", "visit"]);
    const tokens = (pathname) => pathname.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token));
    const requestedTokens = tokens(requestedUrl.pathname);
    const finalTokens = new Set(tokens(finalUrl.pathname));
    if (requestedTokens.length && !requestedTokens.some((token) => finalTokens.has(token))) {
      const error = new Error(`来源页跳转到无关页面：${finalUrl.href}`); error.code = "page_redirect_mismatch"; throw error;
    }
  }
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error("网页正文超过提图安全上限");
  if (!response.ok && !html) throw new Error(`网页提取失败（${response.status}）`);
  if ([401, 403, 429].includes(response.status) && /Just a moment|cf-chl-|captcha|Access Denied/i.test(html.slice(0, 20_000))) {
    const error = new Error(`网页访问被站点拦截（${response.status}）`); error.code = "page_access_blocked"; throw error;
  }
  return extractImageCandidatesFromHtml(html, { ...page, requestedPageUrl: page.pageUrl, pageUrl: response.url }, { responseUrl: response.url, maxImages, semanticTerms });
}
