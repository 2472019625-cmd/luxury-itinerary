import test from "node:test";
import assert from "node:assert/strict";
import { canonicalImageAssetKey, extractImageCandidatesFromHtml, extractPageImages } from "../server/page-images.mjs";
import { prepareWebCandidates } from "../server/web-image-candidates.mjs";

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

test("File说明页即使以jpg结尾也不作为图片，保留同页真实图片", () => {
  const filePage = 'https://en.wikipedia.org/wiki/File:Example_aircraft.jpg';
  const html = `<meta property="og:image" content="${filePage}">
    <a href="${filePage}"><img src="https://upload.wikimedia.org/wikipedia/commons/8/88/Example_aircraft.jpg" alt="Aircraft on runway"></a>
    <a href="https://commons.wikimedia.org/w/index.php?title=File:Example_aircraft.jpg">File description</a>
    <script type="application/ld+json">{"image":"${filePage}"}</script>
    <img src="/gallery/photo-description.html?image=photo.jpg"><img src="/gallery/unknown-photo-resource">`;
  const candidates = extractImageCandidatesFromHtml(html, { pageUrl: 'https://en.wikipedia.org/wiki/Aircraft' });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some(candidate => candidate.imageUrl.endsWith('/Example_aircraft.jpg')));
  assert.ok(candidates.some(candidate => candidate.imageUrl.endsWith('/unknown-photo-resource')));
  assert.ok(candidates.every(candidate => !candidate.imageUrl.includes('File:') && !candidate.imageUrl.includes('photo-description.html')));
});

test("Wikimedia缩略图按已知路径归一到原图并保留原发布URL回退", () => {
  const thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/KQ_B707_in_NBO_77.jpg/500px-KQ_B707_in_NBO_77.jpg?utm_source=en.wikipedia.org&utm_campaign=parser&utm_content=thumbnail';
  const larger = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/KQ_B707_in_NBO_77.jpg/1280px-KQ_B707_in_NBO_77.jpg';
  const original = 'https://upload.wikimedia.org/wikipedia/commons/8/88/KQ_B707_in_NBO_77.jpg';
  const candidates = extractImageCandidatesFromHtml(`<img src="${thumb}"><img src="${larger}"><a href="${original}">Original photograph</a>`, { pageUrl: 'https://en.wikipedia.org/wiki/Aircraft' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].imageUrl, original);
  assert.deepEqual(candidates[0].imageVariants, [original, thumb, larger]);
  assert.equal(canonicalImageAssetKey(thumb), canonicalImageAssetKey(original));
});

test("直接图片响应也归一已知Wikimedia缩略图，保留来源及发布URL", async () => {
  const thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Aircraft.jpg/500px-Aircraft.jpg';
  const original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Aircraft.jpg';
  const candidates = await extractPageImages({ pageUrl: thumb, title: 'Aircraft' }, {
    loadPage: async () => ({ responseUrl: thumb, directImage: true, acquisitionMethod: 'http' }),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].imageUrl, original);
  assert.equal(candidates[0].pageUrl, thumb);
  assert.equal(candidates[0].kind, 'direct-search-result');
  assert.deepEqual(candidates[0].imageVariants, [original, thumb]);
});

test("未知、伪造及非位图的缩略图路径不猜造Wikimedia原图", () => {
  const unknown = [
    'https://thumb.wikimedia.org.evil.test/wikipedia/commons/thumb/a/ab/photo.jpg/500px-photo.jpg',
    'https://user@thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/photo.jpg/500px-photo.jpg',
    'https://thumb.wikimedia.org:8080/wikipedia/commons/thumb/a/ab/photo.jpg/500px-photo.jpg',
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/document.pdf/page1-500px-document.pdf.jpg',
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/photo.jpg/500px-other.jpg',
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/path%2Fphoto.jpg/500px-path%2Fphoto.jpg',
  ];
  for (const url of unknown) {
    const candidates = extractImageCandidatesFromHtml(`<img src="${url}">`, { pageUrl: 'https://example.com/gallery' });
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].imageVariants, [url]);
    assert.equal(canonicalImageAssetKey(url), url);
  }
});

test("明确装饰分隔线在下载前过滤，未知图片和排队主体照片不因line词误拒", () => {
  const html = `<meta property="og:image" content="/assets/ornament.png">
    <img src="/assets/ornament.png" class="section-divider">
    <img src="/assets/horizontal-line.png"><img src="/assets/line.png" width="900" height="2">
    <img src="/photos/line-of-elephants.jpg" alt="A line of elephants walking">
    <img src="/photos/room-divider.jpg" alt="Room divider beside a bed">
    <img src="/photos/line.jpg" width="1400" height="900"><img src="/photos/unknown.jpg">
    <script>window.gallery={image:"https://example.com/assets/decorative-line.webp"}</script>`;
  const extracted = extractImageCandidatesFromHtml(html, { pageUrl: 'https://example.com/gallery' });
  const prepared = prepareWebCandidates(extracted);
  assert.deepEqual(prepared.candidates.map(candidate => new URL(candidate.imageUrl).pathname).sort(), ['/photos/line-of-elephants.jpg', '/photos/line.jpg', '/photos/room-divider.jpg', '/photos/unknown.jpg']);
  assert.equal(prepared.filtered.length, 4);
  assert.ok(prepared.filtered.every(candidate => candidate.reason === 'ui_resource'));
});
