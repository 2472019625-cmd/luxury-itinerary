import test from "node:test";
import assert from "node:assert/strict";
import { canonicalImageAssetKey, extractImageCandidatesFromHtml } from "../server/page-images.mjs";

test("网页提图覆盖 og、srcset、lazy、CSS、gallery、JSON-LD 并恢复高清 URL", () => {
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="/media/hero-600x400.jpg?w=600&h=400">
    <meta name="twitter:image" content="https:https://cdn.example.com/twitter-1600.jpg">
    <script type="application/ld+json">{"image":{"contentUrl":"https://cdn.example.com/official/media.jpg?width=800&height=500"}}</script>
  </head><body>
    <picture><source srcset="/media/walk-900.webp 900w, /media/walk-2400.webp 2400w"></picture>
    <a href="/gallery/maasai-full.jpg"><img src="/thumb/maasai-300x200.jpg" data-src="/gallery/maasai-1600.jpg" alt="Maasai village"></a>
    <div style="background-image:url('/media/anti-poaching-2000.jpg')"></div>
  </body></html>`;
  const results = extractImageCandidatesFromHtml(html, { pageUrl: "https://travel.example.com/story", title: "Story" }, { responseUrl: "https://travel.example.com/story", maxImages: 40 });
  const urls = results.map((item) => item.imageUrl);
  assert.ok(urls.some((url) => url.includes("hero.jpg?w=2400")));
  assert.ok(urls.includes("https://travel.example.com/media/walk-2400.webp"));
  assert.ok(urls.includes("https://travel.example.com/gallery/maasai-full.jpg"));
  assert.ok(urls.includes("https://travel.example.com/media/anti-poaching-2000.jpg"));
  assert.ok(urls.some((url) => url.includes("official/media.jpg?width=2400")));
  assert.ok(urls.includes("https://cdn.example.com/twitter-1600.jpg"));
  assert.ok(urls.every((url) => !url.includes("/https://")));
  assert.ok(results.some((item) => item.kind === "gallery-link"));
  assert.ok(results.some((item) => item.kind === "css-background"));
});

test("活动文本区域邻近图片获得语义分，通用酒店图片在活动slot降权", () => {
  const html = `<!doctype html><html><body>
    <section><h2>Pool and suites</h2><figure><img src="/pool-2400.jpg" alt="Luxury lodge swimming pool"><figcaption>Relax beside the pool and lounge</figcaption></figure></section>
    <section><h2>Guided bush walks</h2><p>Explore Grumeti on foot with an expert guide during a walking safari.</p><picture><source srcset="/walking-1200.jpg 1200w, /walking-2400.jpg 2400w"><img src="/walking-1200.jpg" aria-label="Guided walking safari"></picture></section>
    <script type="application/ld+json">{"name":"Anti-poaching observation post","description":"Meet Grumeti rangers and learn about conservation patrols","image":{"contentUrl":"https://cdn.example.com/ranger-post-2000.jpg"}}</script>
  </body></html>`;
  const results = extractImageCandidatesFromHtml(html, { pageUrl: "https://example.com/activities" }, {
    responseUrl: "https://example.com/activities",
    maxImages: 30,
    semanticTerms: ["walking safari", "anti-poaching observation post"],
  });
  const walking = results.find((item) => item.imageUrl.endsWith("walking-2400.jpg"));
  const ranger = results.find((item) => item.imageUrl.includes("ranger-post-2000.jpg"));
  const pool = results.find((item) => item.imageUrl.endsWith("pool-2400.jpg"));
  assert.ok(walking.semanticScore > 0);
  assert.ok(ranger.semanticScore > 0);
  assert.equal(pool.semanticScore, 0);
  assert.ok(pool.genericActivityPenalty > 0);
  assert.ok(results.indexOf(walking) < results.indexOf(pool));
  assert.ok(results.indexOf(ranger) < results.indexOf(pool));
});

test("Contentful 同一原图的尺寸和格式变体只占一个候选名额", () => {
  const html = `<!doctype html><html><body>
    <img src="https://images.ctfassets.net/demo/sabora-suite.jpg?w=600&fm=webp" alt="Sabora tented suite">
    <img src="https://images.ctfassets.net/demo/sabora-suite.jpg?w=2400&fm=jpg" alt="Sabora tented suite">
    <img src="https://images.ctfassets.net/demo/sabora-lounge.jpg?w=2400&fm=jpg" alt="Sabora lounge">
  </body></html>`;
  const results = extractImageCandidatesFromHtml(html, { pageUrl:"https://singita.com/lodge/singita-sabora-tented-camp/", officialHint:true }, { maxImages:10, semanticTerms:["Singita Sabora Tented Camp", "tented suite lounge"] });
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((item) => canonicalImageAssetKey(item.imageUrl))).size, 2);
  assert.ok(results.some((item) => item.imageUrl.includes("sabora-suite.jpg")));
  assert.ok(results.some((item) => item.imageUrl.includes("sabora-lounge.jpg")));
});
