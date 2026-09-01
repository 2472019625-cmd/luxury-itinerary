export async function searchCommonsImages(query, { signal, count = 12 } = {}) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: String(query).replace(/official photos?/gi, "").slice(0, 120),
    gsrnamespace: "6",
    gsrlimit: String(count),
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: "1800",
    format: "json",
    origin: "*",
  });
  const response = await fetch(url, { headers: { "user-agent": "LuxuryTravelImageResearch/1.0" }, signal });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return Object.values(payload?.query?.pages || {}).map((page, index) => {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata || {};
    return {
      title: page.title || "Wikimedia Commons",
      pageUrl: info?.descriptionurl || `https://commons.wikimedia.org/?curid=${page.pageid}`,
      imageUrl: info?.thumburl || info?.url,
      summary: meta.ImageDescription?.value || "",
      media: "Wikimedia Commons",
      searchRank: index + 1,
      officialHint: false,
      kind: "commons",
      alt: page.title || "",
      license: meta.LicenseShortName?.value || meta.UsageTerms?.value || "",
      creator: String(meta.Artist?.value || "").replace(/<[^>]+>/g, "").trim(),
    };
  }).filter((item) => item.imageUrl);
}
