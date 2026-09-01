import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const workbook = process.env.REAL_TEST_XLSX;
if (!workbook || !fs.existsSync(workbook)) throw new Error("REAL_TEST_XLSX 未指向可用的真实 Excel");

const evidenceDir = path.join(root, "..", "audit", "evidence", "2026-08-28-first-batch-fix");
fs.mkdirSync(evidenceDir, { recursive: true });
const executablePath = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find(fs.existsSync);
if (!executablePath) throw new Error("未找到 Edge/Chrome");

const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

async function clickText(text) {
  const handle = await page.waitForFunction((wanted) => {
    const nodes = [...document.querySelectorAll("button,a")];
    return nodes.find((node) => node.textContent.trim().includes(wanted) && !node.disabled) || null;
  }, { timeout: 120000 }, text);
  await handle.asElement().click();
}

async function setLabel(labelText, value) {
  await page.evaluate((wanted, nextValue) => {
    const label = [...document.querySelectorAll("label")].find((node) => node.childNodes[0]?.textContent?.trim() === wanted || node.textContent.trim().startsWith(wanted));
    const input = label?.querySelector("input,textarea");
    if (!input) throw new Error(`未找到字段：${wanted}`);
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, labelText, value);
}

try {
  console.log("stage=open-clean-workspace");
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle0", timeout: 120000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await clickText("首次使用");
  await setLabel("公司邀请码", "SHEYOU2026");
  await setLabel("姓名", "真实回归测试");
  await setLabel("登录账号", `realtest-${Date.now()}`);
  await setLabel("6位PIN", "246810");
  await clickText("创建并进入");
  await page.waitForSelector(".projects-page", { timeout: 120000 });
  const initialText = await page.$eval(".projects-page", (node) => node.innerText);
  if (/肯尼亚|安博塞利|马赛马拉/.test(initialText)) throw new Error("空白工作区仍出现演示目的地内容");
  await clickText("新建行程");

  console.log("stage=upload-real-workbook");
  const upload = await page.waitForSelector('input[type="file"][accept*=".xlsx"]');
  await upload.uploadFile(workbook);
  await page.waitForFunction(() => document.body.innerText.includes("确认识别结果") && ![...document.querySelectorAll("button")].find((node) => node.textContent.includes("确认识别结果"))?.disabled, { timeout: 120000 });
  await clickText("确认识别结果");
  await page.waitForSelector(".confirm-form", { timeout: 120000 });
  await setLabel("成人", "2");
  await setLabel("儿童", "1");
  await setLabel("出发日期", "2026-08-17");
  await setLabel("返程日期", "2026-08-25");
  await page.waitForFunction(() => document.body.innerText.includes("自然日共9天"));
  await page.screenshot({ path: path.join(evidenceDir, "01-before-generation-date-conflict.png"), fullPage: true });
  await setLabel("返程日期", "2026-08-24");
  await page.waitForFunction(() => !document.body.innerText.includes("自然日共9天"));
  await page.screenshot({ path: path.join(evidenceDir, "02-before-generation-confirmed-facts.png"), fullPage: true });

  console.log("stage=real-ai-and-image-generation");
  await clickText("确认并生成内容");
  await page.waitForSelector(".generation-page", { timeout: 120000 });
  const started = Date.now();
  while (true) {
    const state = await page.evaluate(() => ({
      text: document.querySelector(".generation-main")?.innerText || "",
      progress: document.querySelector(".overall-progress strong")?.textContent || "",
      canEdit: [...document.querySelectorAll("button")].some((node) => node.textContent.includes("进入编辑") && !node.disabled),
    }));
    console.log(`generation=${state.progress}`);
    if (state.canEdit) break;
    if (/内容生成失败|生成失败|重新生成/.test(state.text)) throw new Error(state.text.slice(-1000));
    if (Date.now() - started > 60 * 60 * 1000) throw new Error("真实生成超过60分钟");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await page.screenshot({ path: path.join(evidenceDir, "03-real-generation-complete.png"), fullPage: true });
  await clickText("进入编辑");
  await page.waitForSelector(".editor-grid", { timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);

  console.log("stage=verify-editor-and-every-day");
  const { result, fullData } = await page.evaluate(() => {
    const projects = JSON.parse(localStorage.getItem("sheyou-workspace-projects-v1") || "[]");
    const project = projects[0];
    const data = project.data;
    const brokenImages = [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.alt);
    const title = document.querySelector(".cover-copy h1")?.getBoundingClientRect();
    const cover = document.querySelector(".cover-copy")?.getBoundingClientRect();
    const customerData = structuredClone(data);
    delete customerData.imageSourceLedger;
    delete customerData.imageFailures;
    delete customerData.imageResearch;
    delete customerData.imagePlan;
    return { fullData: data, result: {
      projectId: project.id,
      title: data.title,
      traveler: { adults: data.adults, children: data.children },
      startDate: data.startDate,
      endDate: data.endDate,
      dates: data.days.map((day) => day.date),
      routes: data.days.map((day) => day.routeNodes),
      spotsPerDay: data.days.map((day) => day.spots?.length || 0),
      overnightTypes: data.days.map((day) => day.overnightType),
      lastHotel: data.days.at(-1).hotel,
      imageResearch: data.imageResearch,
      imageSources: (data.imageSourceLedger || []).map((image) => image.src),
      brokenImages,
      titleContained: Boolean(title && cover && title.left >= cover.left && title.right <= cover.right + 1),
      oldDemoLeak: /肯尼亚|安博塞利|马赛马拉/.test(JSON.stringify(customerData)),
    } };
  });
  fs.writeFileSync(path.join(evidenceDir, "generated-data.json"), JSON.stringify(fullData, null, 2));
  fs.writeFileSync(path.join(evidenceDir, "validation-result.json"), JSON.stringify(result, null, 2));
  if (result.brokenImages.length) throw new Error(`仍有破图：${result.brokenImages.join(", ")}`);
  if (!result.titleContained) throw new Error("封面标题仍超出容器");
  if (result.oldDemoLeak) throw new Error("真实项目仍包含旧肯尼亚演示内容");
  if (result.dates.join(",") !== ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"].join(",")) throw new Error("每日日期不连续");
  if (result.spotsPerDay.some((count) => count < 1)) throw new Error("仍有 DAY 未创建结构化体验图片位");
  if (result.overnightTypes.at(-1) === "hotel") throw new Error("返程日仍被识别为酒店住宿");
  if (result.imageSources.some((src) => /^https?:/i.test(src))) throw new Error("最终图片数据仍包含远程 URL");

  await page.evaluate(() => [...document.querySelectorAll(".structure-panel nav > button")].find((node) => node.textContent.trim().startsWith("封面"))?.click());
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(evidenceDir, "04-after-editor-cover-and-missing-state.png"), fullPage: false });
  const dayButtons = await page.$$(".day-nav-group > div button");
  for (let index = 0; index < dayButtons.length; index += 1) {
    await dayButtons[index].click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.screenshot({ path: path.join(evidenceDir, `day-${String(index + 1).padStart(2, "0")}.png`), fullPage: false });
  }
  await page.evaluate(() => { const stage = document.querySelector(".canvas-stage"); stage.scrollTop = stage.scrollHeight; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.screenshot({ path: path.join(evidenceDir, "05-after-editor-bottom-visible.png"), fullPage: false });
  const scroll = await page.$eval(".canvas-stage", (stage) => ({ top: stage.scrollTop, clientHeight: stage.clientHeight, scrollHeight: stage.scrollHeight }));
  if (scroll.top + scroll.clientHeight < scroll.scrollHeight - 4) throw new Error("中央画布无法滚动到底部");

  console.log("stage=render-real-2000px-output");
  const render = await page.evaluate(async () => {
    const projects = JSON.parse(localStorage.getItem("sheyou-workspace-projects-v1") || "[]");
    const response = await fetch("/api/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: projects[0].data }) });
    let job = await response.json();
    if (!response.ok) throw new Error(job.error || "无法创建渲染任务");
    while (!["complete", "failed"].includes(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      job = await fetch(`/api/jobs/${job.id}`).then((value) => value.json());
    }
    if (job.status === "failed") throw new Error(job.error);
    return job;
  });
  fs.writeFileSync(path.join(evidenceDir, "render-result.json"), JSON.stringify(render, null, 2));
  console.log(JSON.stringify({ evidenceDir, result, render }, null, 2));
} finally {
  await browser.close();
}
