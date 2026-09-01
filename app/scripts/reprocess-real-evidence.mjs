import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { normalizeItineraryFacts } from "../src/lib/itineraryRules.js";

const root = path.resolve(import.meta.dirname, "..");
const evidenceDir = path.join(root, "..", "audit", "evidence", "2026-08-28-first-batch-fix");
const source = JSON.parse(fs.readFileSync(path.join(evidenceDir, "generated-data.json"), "utf8"));
const data = normalizeItineraryFacts(source);
const invalidProof = data.hotels.flatMap((hotel) => (hotel.proofPoints || []).map((point) => ({ hotel: hotel.officialName, point, length: [...point].length }))).filter((item) => item.length > 10 || /[的与和及为可更]$/.test(item.point) || /国际品牌管理|服务稳定可靠|帐篷营地体验/.test(item.point));
if (invalidProof.length) throw new Error(`酒店关键点仍不合格：${JSON.stringify(invalidProof)}`);
if (data.hotels.some((hotel) => hotel.proofPoints.length < 2 || hotel.proofPoints.length > 3)) throw new Error("酒店关键点数量不是2至3条");
const dataFile = path.join(evidenceDir, "generated-data-final.json");
fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

const created = await fetch("http://127.0.0.1:4173/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) }).then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "创建渲染任务失败");
  return body;
});
let render = created;
while (!["complete", "failed"].includes(render.status)) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  render = await fetch(`http://127.0.0.1:4173/api/jobs/${render.id}`).then((response) => response.json());
}
if (render.status === "failed") throw new Error(render.error);
fs.writeFileSync(path.join(evidenceDir, "render-result-final.json"), JSON.stringify(render, null, 2));

const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find(fs.existsSync);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((payload) => localStorage.setItem("sheyou-export-data-v1", JSON.stringify(payload)), data);
  await page.goto("http://127.0.0.1:4173/?export=1&width=2000&dataset=workspace", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => Promise.all([...document.images].map((image) => image.decode?.().catch(() => undefined))));
  const broken = await page.evaluate(() => [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.alt));
  if (broken.length) throw new Error(`最终导出预览仍有破图：${broken.join(",")}`);
  const shots = [
    [".cover", "06-final-cover.png"],
    [".hotels-section", "07-final-hotels.png"],
    [".day-section:last-child", "08-final-return-day.png"],
    [".brand-footer-fixed", "09-final-footer.png"],
  ];
  for (const [selector, file] of shots) {
    const element = await page.$(selector);
    if (!element) throw new Error(`缺少截图节点：${selector}`);
    await element.screenshot({ path: path.join(evidenceDir, file), type: "png" });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ dataFile, render, hotels: data.hotels.map((hotel) => ({ name: hotel.shortName || hotel.officialName, proofPoints: hotel.proofPoints, hasImage: Boolean(hotel.images?.[0]?.src) })) }, null, 2));
