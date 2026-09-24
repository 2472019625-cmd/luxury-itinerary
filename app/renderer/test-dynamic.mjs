import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.LUXURY_TRAVEL_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);
const executablePaths = [...new Set(candidates.filter((candidate) => fs.existsSync(candidate)))];
if (!executablePaths.length) throw new Error("未找到 Edge/Chrome");

const scenarios = ["short", "standard", "long", "no-images", "three-images", "four-images", "composite-images", "long-copy", "missing-services", "no-payment", "no-security", "payment-no-qr", "designer-contact", "designer-phone-only", "designer-wechat-only", "designer-wechat-long"];
const baseUrl = process.env.LUXURY_TRAVEL_BASE_URL || "http://127.0.0.1:4173";
const expectedDayFactLabels = ["当日行程", "当日路线", "当晚入住", "当日用餐", "当日节奏"];
const expectedDayContentOrder = ["当日行程", "体验图片", "当日路线", "当晚入住", "当日用餐", "当日节奏"];
const expectedBookingSteps = [
  ["说出您的向往", "告知出行时间、目的地与人数，任何天马行空的想法，我们都认真聆听。"],
  ["专属定制师就位", "专属旅行顾问24小时内致电或添加微信，第一时间响应您的期待。"],
  ["查收定制方案", "您将收到一份涵盖行程动线、甄选酒店与特色体验的完整方案。"],
  ["随心调整至臻", "路线、房型、餐食均可按您的偏好调整，直至每一处细节都契合心意。"],
  ["锁定稀缺资源", "确认方案并完成支付签约，即刻为您抢订限量席位及特殊体验资源。"],
  ["静候非凡之旅", "专属服务群全程护航，出行琐事尽托付于我们，您只需随心而动。"],
];
const expectedBookingLines = [
  ["告知出行时间、目的地与人数，", "任何天马行空的想法，我们都认真聆听。"],
  ["专属旅行顾问24小时内致电或添加微信，", "第一时间响应您的期待。"],
  ["您将收到一份涵盖行程动线、", "甄选酒店与特色体验的完整方案。"],
  ["路线、房型、餐食均可按您的偏好调整，", "直至每一处细节都契合心意。"],
  ["确认方案并完成支付签约，", "即刻为您抢订限量席位及特殊体验资源。"],
  ["专属服务群全程护航，", "出行琐事尽托付于我们，您只需随心而动。"],
];
let browser = null;
const launchErrors = [];
for (const executablePath of executablePaths) {
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu", "--font-render-hinting=none"] });
    break;
  } catch (error) {
    launchErrors.push(`${path.basename(executablePath)}: ${error?.message || String(error)}`);
  }
}
if (!browser) throw new Error(`Edge/Chrome 均无法启动：${launchErrors.join(' | ')}`);
const results = [];

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/session") request.respond({ status: 200, contentType: "application/json", body: '{"enabled":false}' });
      else request.continue();
    });
    await page.setViewport({ width: 2000, height: 1200, deviceScaleFactor: 1 });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/?export=1&width=2000&scenario=${scenario}`, { waitUntil: "networkidle0", timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const canvas = document.querySelector("#itinerary");
      const canvasRect = canvas.getBoundingClientRect();
      const logoRect = canvas.querySelector(".brand-logo-cover")?.getBoundingClientRect();
      const firstDayBody = canvas.querySelector(".day-body");
      const readDayFactLabel = (element) => element.querySelector(":scope > div > span, :scope > div > small")?.textContent?.trim();
      const missingImages = [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src);
      const overflowing = [...canvas.querySelectorAll("*")].filter((element) => element.scrollWidth > element.clientWidth + 2).map((element) => element.className || element.tagName).slice(0, 12);
      const bookingFlowRect = canvas.querySelector(".booking-flow")?.getBoundingClientRect();
      const brandAboutRect = canvas.querySelector(".brand-source-crop-about")?.getBoundingClientRect();
      const brandContactWaveRect = canvas.querySelector(".brand-source-crop-contact-wave")?.getBoundingClientRect();
      const brandCtaMaskRect = canvas.querySelector(".brand-contact-cta-mask")?.getBoundingClientRect();
      const designerNameRect = canvas.querySelector(".designer-heading > strong")?.getBoundingClientRect();
      const designerRoleRect = canvas.querySelector(".designer-heading > span")?.getBoundingClientRect();
      const designerContactRect = canvas.querySelector(".designer-contact-row")?.getBoundingClientRect();
      const designerContactItemRect = canvas.querySelector(".designer-contact-item")?.getBoundingClientRect();
      const designerSecondContactItemRect = canvas.querySelector(".designer-contact-item + .designer-contact-item")?.getBoundingClientRect();
      const designerContactItemRects = [...canvas.querySelectorAll(".designer-contact-item")].map((item) => ({
        item: item.getBoundingClientRect(),
        label: item.querySelector("dt")?.getBoundingClientRect(),
        value: item.querySelector("dd")?.getBoundingClientRect(),
      }));
      const designerBioRect = canvas.querySelector(".designer-heading > p")?.getBoundingClientRect();
      const readTextStyle = (selector) => {
        const element = canvas.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          fontSize: Number.parseFloat(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10),
          fontFamily: style.fontFamily,
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      };
      const twoColumnSpotGallery = canvas.querySelector(".spot-count-2, .spot-count-4");
      const threeSpotGallery = canvas.querySelector(".spot-count-3");
      const threeSpotCards = [...(threeSpotGallery?.querySelectorAll(":scope > .spot-card") || [])];
      const threeSpotGalleryRect = threeSpotGallery?.getBoundingClientRect();
      const threeSpotCardRects = threeSpotCards.map((card) => card.getBoundingClientRect());
      const threeSpotLastImageRect = threeSpotCards[2]?.querySelector(".spot-image")?.getBoundingClientRect();
      const threeSpotLastCopyRect = threeSpotCards[2]?.querySelector(".spot-copy")?.getBoundingClientRect();
      const bookingNodeMetrics = [...canvas.querySelectorAll(".booking-step")].map((step) => {
        const stepRect = step.getBoundingClientRect();
        const nodeRect = step.querySelector(":scope > strong")?.getBoundingClientRect();
        const copy = step.querySelector(".booking-copy");
        const copyRect = copy?.getBoundingClientRect();
        const titleRect = copy?.querySelector("h3")?.getBoundingClientRect();
        const bodyRect = copy?.querySelector("p")?.getBoundingClientRect();
        const lineHalfHeight = copy ? Number.parseFloat(getComputedStyle(copy, "::after").height) / 2 : null;
        const lineY = copyRect ? copyRect.top + copyRect.height / 2 : null;
        return {
          axisDelta: nodeRect && bookingFlowRect ? Math.abs((nodeRect.left + nodeRect.width / 2) - (bookingFlowRect.left + bookingFlowRect.width / 2)) : null,
          rowDelta: nodeRect ? Math.abs((nodeRect.top + nodeRect.height / 2) - (stepRect.top + stepRect.height / 2)) : null,
          lineClearance: lineY !== null && lineHalfHeight !== null && titleRect && bodyRect
            ? Math.min(lineY - titleRect.bottom, bodyRect.top - lineY) - lineHalfHeight
            : null,
        };
      });
      return {
        width: Math.round(canvasRect.width),
        height: Math.round(canvasRect.height),
        logoTop: logoRect ? Math.round(logoRect.top - canvasRect.top) : null,
        dayCount: canvas.querySelectorAll(".day-section").length,
        firstDayFactLabels: [...(firstDayBody?.querySelectorAll(".day-fact, .route-preview") || [])].map(readDayFactLabel).filter(Boolean),
        firstDayContentOrder: [...(firstDayBody?.children || [])].flatMap((element) => {
          if (element.classList.contains("fact-description")) return [readDayFactLabel(element)];
          if (element.classList.contains("spot-galleries")) return ["体验图片"];
          if (element.classList.contains("day-facts")) return [...element.children].map(readDayFactLabel).filter(Boolean);
          return [];
        }).filter(Boolean),
        dayNoticeCount: canvas.querySelectorAll(".day-notices").length,
        spotCardCount: canvas.querySelectorAll(".spot-card").length,
        serviceTagCount: canvas.querySelectorAll(".service-tags > span").length,
        missingImages,
        overflowing,
        slogan: canvas.querySelector(".slogan-lockup")?.textContent?.trim(),
        fontStatus: document.fonts.status,
        securitySectionCount: canvas.querySelectorAll(".security-section").length,
        paymentVisualCount: canvas.querySelectorAll(".payment-visual").length,
        paymentQrCount: canvas.querySelectorAll(".payment-qr").length,
        paymentFallback: canvas.querySelector(".payment-account-lines")?.textContent?.trim() || "",
        bookingSteps: [...canvas.querySelectorAll(".booking-step")].map((step) => [step.querySelector("h3")?.textContent?.trim() || "", step.querySelector("p")?.textContent?.trim() || ""]),
        bookingLines: [...canvas.querySelectorAll(".booking-step p")].map((copy) => [...copy.querySelectorAll(":scope > span")].map((line) => line.textContent?.trim() || "")),
        bookingAxisMaxDelta: Math.max(...bookingNodeMetrics.map((item) => item.axisDelta ?? Number.POSITIVE_INFINITY)),
        bookingRowMaxDelta: Math.max(...bookingNodeMetrics.map((item) => item.rowDelta ?? Number.POSITIVE_INFINITY)),
        bookingLineMinClearance: Math.min(...bookingNodeMetrics.map((item) => item.lineClearance ?? Number.NEGATIVE_INFINITY)),
        overviewMealSummaries: [...canvas.querySelectorAll(".overview-meal-summary")].map((item) => item.textContent?.trim() || ""),
        hotelSectionTitle: canvas.querySelector(".hotels-section .section-title h2")?.textContent?.trim() || "",
        brandSectionTitles: [...canvas.querySelectorAll(".brand-footer-section .section-title")].map((title) => [title.querySelector(".section-title-en")?.textContent?.trim() || "", title.querySelector("h2")?.textContent?.trim() || ""]),
        brandCropCount: canvas.querySelectorAll(".brand-source-crop").length,
        oldFooterAssetCount: canvas.querySelectorAll('img[src*="fixed-footer-template-v1"]').length,
        forbiddenFooterCtaCount: [...canvas.querySelectorAll(".brand-footer-fixed *")].filter((item) => item.textContent?.includes("阅读全文")).length,
        brandAboutWidth: brandAboutRect?.width || 0,
        brandContactWaveWidth: brandContactWaveRect?.width || 0,
        brandContactWaveHeight: brandContactWaveRect?.height || 0,
        brandCtaMaskWidth: brandCtaMaskRect?.width || 0,
        designerContacts: [...canvas.querySelectorAll(".designer-contact-item")].map((item) => [item.querySelector("dt > span:last-child")?.textContent?.trim() || "", item.querySelector("dd")?.textContent?.trim() || ""]),
        designerContactWidth: designerContactRect?.width || 0,
        designerContactOrderValid: !designerContactRect || !designerNameRect || !designerBioRect ? false : designerContactRect.top >= designerNameRect.bottom && designerContactRect.bottom <= designerBioRect.top,
        designerContactItemCenterDelta: !designerContactRect || !designerContactItemRect ? null : Math.abs((designerContactItemRect.left + designerContactItemRect.width / 2) - (designerContactRect.left + designerContactRect.width / 2)),
        designerContactItemWidthDelta: designerContactItemRects.length < 2 ? 0 : Math.abs(designerContactItemRects[0].item.width - designerContactItemRects[1].item.width),
        designerContactLabelTopDelta: designerContactItemRects.length < 2 ? 0 : Math.abs(designerContactItemRects[0].label.top - designerContactItemRects[1].label.top),
        designerContactValueTopDelta: designerContactItemRects.length < 2 ? 0 : Math.abs(designerContactItemRects[0].value.top - designerContactItemRects[1].value.top),
        designerDividerAxisDelta: !designerRoleRect || !designerSecondContactItemRect ? null : Math.abs(designerRoleRect.left - designerSecondContactItemRect.left),
        dayDescriptionStyle: readTextStyle(".fact-description p"),
        spotTitleStyle: readTextStyle(".spot-copy h4"),
        spotBodyStyle: readTextStyle(".spot-copy p"),
        routeNodeStyle: readTextStyle(".route-nodes strong"),
        mealLabelStyle: readTextStyle(".meal-grid small"),
        mealValueStyle: readTextStyle(".meal-grid strong"),
        rhythmStyle: readTextStyle(".rhythm-chips b"),
        twoColumnSpotTrackCount: twoColumnSpotGallery ? getComputedStyle(twoColumnSpotGallery).gridTemplateColumns.split(" ").length : 0,
        threeSpotLayout: !threeSpotGalleryRect || threeSpotCardRects.length !== 3 ? null : {
          trackCount: getComputedStyle(threeSpotGallery).gridTemplateColumns.split(" ").length,
          topWidthDelta: Math.abs(threeSpotCardRects[0].width - threeSpotCardRects[1].width),
          thirdWidthDelta: Math.abs(threeSpotCardRects[2].width - threeSpotGalleryRect.width),
          thirdBelowTopRow: threeSpotCardRects[2].top > Math.max(threeSpotCardRects[0].bottom, threeSpotCardRects[1].bottom),
          thirdImageBeforeCopy: Boolean(threeSpotLastImageRect && threeSpotLastCopyRect && threeSpotLastImageRect.right <= threeSpotLastCopyRect.left + 1),
          thirdImageRatio: threeSpotLastImageRect ? threeSpotLastImageRect.width / threeSpotCardRects[2].width : 0,
          thirdCopyCentered: threeSpotLastCopyRect ? getComputedStyle(threeSpotCards[2].querySelector(".spot-copy")).justifyContent === "center" : false,
        },
      };
    });
    results.push({ scenario, ...metrics, consoleErrors: errors });
    await page.close();
  }
} finally {
  await browser.close();
}

const failures = results.filter((item) => {
  const wrongVisibility = item.scenario === "no-security"
    ? item.securitySectionCount !== 0
    : item.securitySectionCount !== 1 || (item.scenario === "no-payment" ? item.paymentVisualCount !== 0 : item.paymentVisualCount !== 1);
  const wrongQrFallback = item.scenario === "payment-no-qr"
    ? item.paymentQrCount !== 0 || item.paymentFallback !== "以正式合同所附账户为准"
    : item.scenario !== "no-payment" && item.scenario !== "no-security" && item.paymentQrCount !== 1;
  const wrongFrontendContent = item.scenario === "standard" && (
    item.logoTop < 240
    || item.dayNoticeCount !== 0
    || JSON.stringify(item.firstDayFactLabels) !== JSON.stringify(expectedDayFactLabels)
    || JSON.stringify(item.firstDayContentOrder) !== JSON.stringify(expectedDayContentOrder)
    || JSON.stringify(item.bookingSteps) !== JSON.stringify(expectedBookingSteps)
    || JSON.stringify(item.bookingLines) !== JSON.stringify(expectedBookingLines)
    || item.bookingAxisMaxDelta > 1
    || item.bookingRowMaxDelta > 1
    || item.bookingLineMinClearance < 0
    || item.overviewMealSummaries.length !== item.dayCount
    || item.overviewMealSummaries.some((summary) => !summary || !/(含餐|未含餐|待确认)/.test(summary))
    || item.hotelSectionTitle !== "臻选酒店"
    || JSON.stringify(item.brandSectionTitles) !== JSON.stringify([["ABOUT US", "关于我们"], ["FOLLOW US", "联系我们"]])
    || item.brandCropCount !== 2
    || item.oldFooterAssetCount !== 0
    || item.forbiddenFooterCtaCount !== 0
    || item.brandAboutWidth !== 2000
    || item.brandContactWaveWidth !== 2000
    || item.brandContactWaveHeight < 1050
    || item.brandCtaMaskWidth < 1080
    || item.designerContacts.length !== 0
    || item.dayDescriptionStyle?.fontSize !== 62
    || item.dayDescriptionStyle?.fontWeight !== 600
    || !item.dayDescriptionStyle?.fontFamily.includes("Source Han Serif CN")
    || Math.abs(item.dayDescriptionStyle?.lineHeight - 102.92) > 0.1
    || item.spotTitleStyle?.fontSize !== 48
    || !item.spotTitleStyle?.fontFamily.includes("Source Han Serif CN")
    || item.spotBodyStyle?.fontSize !== 40
    || item.spotBodyStyle?.fontWeight !== 600
    || !item.spotBodyStyle?.fontFamily.includes("Source Han Serif CN")
    || Math.abs(item.spotBodyStyle?.lineHeight - 64.8) > 0.1
    || item.routeNodeStyle?.fontSize !== 50
    || item.routeNodeStyle?.fontWeight !== 600
    || item.mealLabelStyle?.fontSize !== 36
    || item.mealValueStyle?.fontSize !== 44
    || item.mealValueStyle?.fontWeight !== 600
    || item.rhythmStyle?.fontSize !== 44
    || item.rhythmStyle?.fontWeight !== 600
    || item.twoColumnSpotTrackCount !== 2
  );
  const wrongDesignerContact = item.scenario === "designer-contact" && (
    JSON.stringify(item.designerContacts) !== JSON.stringify([["定制师电话", "138 0000 0000"], ["工作微信", "LuxuryTravel_Sunny"]])
    || item.designerContactWidth > 1180
    || item.designerContactItemWidthDelta > 1
    || item.designerContactLabelTopDelta > 1
    || item.designerContactValueTopDelta > 1
    || item.designerDividerAxisDelta > 1
    || !item.designerContactOrderValid
  );
  const expectedSingleDesignerContact = item.scenario === "designer-phone-only"
    ? [["定制师电话", "138 0000 0000"]]
    : item.scenario === "designer-wechat-only"
      ? [["工作微信", "LuxuryTravel_Sunny"]]
      : item.scenario === "designer-wechat-long"
        ? [["工作微信", "LuxuryTravel_Enterprise_Service_Sunny_2026"]]
      : null;
  const wrongSingleDesignerContact = expectedSingleDesignerContact && (
    JSON.stringify(item.designerContacts) !== JSON.stringify(expectedSingleDesignerContact)
    || item.designerContactItemCenterDelta > 1
    || !item.designerContactOrderValid
  );
  const wrongThreeSpotLayout = item.scenario === "three-images" && (
    !item.threeSpotLayout
    || item.threeSpotLayout.trackCount !== 2
    || item.threeSpotLayout.topWidthDelta > 1
    || item.threeSpotLayout.thirdWidthDelta > 1
    || !item.threeSpotLayout.thirdBelowTopRow
    || !item.threeSpotLayout.thirdImageBeforeCopy
    || Math.abs(item.threeSpotLayout.thirdImageRatio - 0.56) > 0.02
    || !item.threeSpotLayout.thirdCopyCentered
  );
  const wrongFourSpotLayout = item.scenario === "four-images" && (
    item.spotCardCount !== item.dayCount * 4
    || item.twoColumnSpotTrackCount !== 2
  );
  return item.width !== 2000 || item.missingImages.length || item.overflowing.length || item.consoleErrors.length || item.slogan !== "高品质度假管家，懂度假，更懂你" || item.fontStatus !== "loaded" || wrongVisibility || wrongQrFallback || wrongFrontendContent || wrongDesignerContact || wrongSingleDesignerContact || wrongThreeSpotLayout || wrongFourSpotLayout;
});
const output = path.join(root, "output", "dynamic-test-results.json");
fs.writeFileSync(output, `${JSON.stringify({ passed: failures.length === 0, results }, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: failures.length === 0, results }, null, 2));
if (failures.length) process.exitCode = 1;
