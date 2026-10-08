import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUsableFinalImageSource, validateItineraryFacts } from "../src/lib/itineraryRules.js";
import { selectCustomerRenderData } from "./customer-render-data.mjs";
import { MAX_CARD_IMAGE_UPSCALE } from "./image-download.mjs";
import { FIXED_MODULE_NAMES, SIMPLE_PIPELINE_DEFAULT_ORIGIN, fixedModuleExpectations, validateApprovedPayment } from "./simple-fixed-modules.mjs";
import { normalizeRenderIssues } from "./simple-render-issues.mjs";
import { createOperationTrace } from './operation-trace.mjs';
import { rendererQueue } from './shared-work-queue.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalVisible = /图片未通过终审|审核分数|候选状态|来源账本|成本|利润|供应商底价|内部报价/i;

const draftFatalCodes = new Set(["fact_conflict", "required_module_missing", "internal_visible_text"]);

function severityFor(code, mode) {
  return mode === "draft" && !draftFatalCodes.has(code) ? "warning" : "blocker";
}

export function layoutOverflowIssue(item = {}, { draft = false } = {}) {
  const path = String(item.editPath || "");
  const match = path.match(/^(?:days|overview|hotels|dining|transport|highlights|notes)\.(\d+)/);
  const section = path.split(".")[0];
  const names = { cover: "封面", highlights: "产品亮点", overview: "行程总览", hotels: "臻选酒店", dining: "特色餐饮", transport: "全程交通", days: "每日行程", expenses: "费用说明", booking: "预订流程", security: "资金安全提醒", notes: "注意事项", footer: "品牌页尾" };
  const location = section === "days" && match ? `DAY ${String(Number(match[1]) + 1).padStart(2, "0")}` : `${names[section] || "成品版面"}${match ? ` · 第 ${Number(match[1]) + 1} 项` : ""}`;
  return { severity: draft ? "warning" : "blocker", code: "text_overflow", targetPath: path, selector: item.selector || "", message: `${location}的文字或模块超出显示区域，请定位检查并调整内容或版式。` };
}

export function deterministicPreflight(data, { root = appRoot, mode = "final" } = {}) {
  const issues = [];
  const facts = validateItineraryFacts(data);
  facts.errors.forEach((message) => issues.push({ severity: "blocker", code: "fact_conflict", message }));
  const customer = selectCustomerRenderData(data);
  const expectedFixedModules = fixedModuleExpectations(customer);
  if (!customer.title || !customer.days?.length) issues.push({ severity: "blocker", code: "required_module_missing", message: "封面标题或每日行程缺失" });
  if (expectedFixedModules.notes && (!Array.isArray(customer.notes) || customer.notes.length === 0)) issues.push({ severity: severityFor("fixed_notes_missing", mode), code: "fixed_notes_missing", module: FIXED_MODULE_NAMES.notes, message: `固定必需模块缺失：${FIXED_MODULE_NAMES.notes}` });
  if (expectedFixedModules.payment) {
    const payment = validateApprovedPayment(customer.payment, { root });
    if (!payment.passed) {
      const detail = payment.missingFields.length
        ? `缺少字段：${payment.missingFields.join("、")}`
        : payment.mismatchedFields.length
          ? `非批准字段：${payment.mismatchedFields.join("、")}`
          : payment.assetStatus === "missing"
            ? "批准的支付宝二维码资产缺失"
            : "支付宝二维码不是批准资产";
      issues.push({ severity: severityFor("fixed_payment_incomplete", mode), code: "fixed_payment_incomplete", module: FIXED_MODULE_NAMES.payment, message: `${FIXED_MODULE_NAMES.payment}不完整：${detail}`, evidence: payment });
    }
  }
  if (internalVisible.test(JSON.stringify(customer))) issues.push({ severity: "blocker", code: "internal_visible_text", message: "客户输出包含内部审核或成本术语" });
  const sources = [customer.heroImage, ...(customer.hotels || []).flatMap((item) => item.images || []), ...(customer.diningExperiences || []).flatMap((item) => item.images || []), ...(customer.transportSummary || []).flatMap((item) => item.images || []), ...(customer.days || []).flatMap((day) => (day.spots || []).flatMap((spot) => spot.images || []))].map((item) => typeof item === "string" ? item : item?.src).filter(Boolean);
  sources.filter((source) => !isUsableFinalImageSource(source)).forEach((source) => issues.push({ severity: severityFor("unsafe_final_image", mode), code: "unsafe_final_image", message: `成品图片不是本地或用户资源：${source}` }));
  if (new Set(sources).size !== sources.length) issues.push({ severity: severityFor("duplicate_final_image", mode), code: "duplicate_final_image", message: "成品存在完全重复图片" });
  return { passed: !issues.some((item) => item.severity === "blocker"), issues, customer, expectedFixedModules };
}

export function reviewFixedModuleLayout(expected = {}, layout = {}) {
  const issues = [];
  const fixedModules = layout.fixedModules || {};
  for (const [key, required] of Object.entries(expected)) {
    if (!required) continue;
    const module = fixedModules[key];
    if (!module?.present) issues.push({ severity: "blocker", code: "fixed_module_missing", module: FIXED_MODULE_NAMES[key], message: `固定必需模块缺失：${FIXED_MODULE_NAMES[key]}` });
    else if (module.complete === false) issues.push({ severity: "blocker", code: "fixed_module_incomplete", module: FIXED_MODULE_NAMES[key], message: `固定必需模块不完整：${FIXED_MODULE_NAMES[key]}${module.missingParts?.length ? `（${module.missingParts.join("、")}）` : ""}` });
  }
  return issues;
}

export function reviewCardImageUpscales(layout = {}, mode = "final") {
  return (layout.cardImageUpscales || [])
    .filter((item) => Number.isFinite(item.scale) && item.scale > MAX_CARD_IMAGE_UPSCALE)
    .map((item) => ({
      severity: mode === "draft" ? "warning" : "blocker",
      code: "image_upscale_excessive",
      selector: item.selector,
      message: `图片在实际版面放大 ${item.scale.toFixed(2)} 倍，超过 ${MAX_CARD_IMAGE_UPSCALE} 倍上限`,
    }));
}

let activeRendererProcesses = 0;
function runRenderer(args, cwd, trace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    activeRendererProcesses++;
    trace.emit('renderer_active', { activeCount: activeRendererProcesses });
    let released = false;
    const release = () => { if (!released) { released = true; activeRendererProcesses--; trace.emit('renderer_active', { activeCount: activeRendererProcesses }); } };
    let stdout = "";
    let stderr = "";
    let pendingLine = '';
    const phases = {};
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event !== 'operation_trace' || event.operation !== 'renderer') continue;
          if (typeof event.durationMs === 'number') phases[event.phase] = (phases[event.phase] || 0) + event.durationMs;
          // Re-emit only controlled fields, not the renderer's customer layout.
          if (!/^[a-z0-9_]+$/i.test(event.phase || '')) continue;
          trace.emit(event.phase, Object.fromEntries(['durationMs', 'code', 'tile', 'attempt', 'transportCode', 'errorType', 'errno',
            'statusCode', 'resourceType', 'resourceId', 'pendingCount', 'requestFailures', 'pageErrors', 'badResponses',
            'itineraryPresent', 'documentComplete', 'fontsLoaded', 'imageCount', 'pendingImageCount', 'brokenImageCount',
            'snapshotUnavailable'].map(key => [key, event[key]])));
        } catch { /* ordinary renderer output is retained privately */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", error => { release(); reject(error); });
    child.on("close", (code) => {
      release();
      if (code === 0) return resolve({ stdout, stderr, timing: { requestId: trace.requestId, phases } });
      const lines = stderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const reason = lines.find((line) => /^(?:Error|TypeError|RangeError):/.test(line)) || `Renderer 退出码 ${code}`;
      const failure = new Error(reason);
      failure.code = /Export tile dimensions differ/.test(reason) ? "render_capture_failed" : "renderer_process_failed";
      failure.diagnostic = stderr.slice(-6000);
      failure.renderTiming = { requestId: trace.requestId, phases };
      reject(failure);
    });
  });
}

export async function runSimpleRenderer(input = {}) {
  const trace = createOperationTrace('renderer_queue', input);
  return rendererQueue.enqueue(() => {
    if (input.canRender && !input.canRender()) {
      trace.emit('superseded');
      return { status: 'superseded', outputPath: null, rendererCalls: 0 };
    }
    return renderWithPermit({ ...input, requestId: trace.requestId });
  }, { signal: input.signal, onState: state => {
    trace.emit(state.state, { ...state, durationMs: state.waitMs });
    input.onQueueState?.(state);
  } });
}

async function renderWithPermit({ data, projectId, root = appRoot, origin = SIMPLE_PIPELINE_DEFAULT_ORIGIN, outputDirectory = path.join(root, "output", "simple-pipeline", projectId), mode = "final", requestId, revision } = {}) {
  const trace = createOperationTrace('simple_renderer', { projectId, requestId, revision });
  const startedAt = Date.now();
  const draft = mode === "draft";
  const preflight = deterministicPreflight({ ...data, suppressMissingImagePlaceholders: mode === "final" }, { root, mode });
  if (!preflight.passed) return { status: "blocked", outputPath: null, qa: preflight, durationMs: Date.now() - startedAt, rendererCalls: 0 };
  await mkdir(outputDirectory, { recursive: true });
  // A superseded render must not replace a newer request's data, QA or PNG.
  const suffix = revision ? `-${String(revision).replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  const dataFile = path.join(outputDirectory, `render-data${draft ? '-draft' : ''}${suffix}.json`);
  const outputPath = path.join(outputDirectory, `${projectId}-itinerary-${draft ? "draft-" : ""}2000${suffix}.png`);
  const qaPath = path.join(outputDirectory, `layout-qa${draft ? '-draft' : ''}${suffix}.json`);
  await writeFile(dataFile, `${JSON.stringify(preflight.customer, null, 2)}\n`, "utf8");
  const rendered = await runRenderer([
    path.join(root, "renderer", "render.mjs"),
    "--width=2000",
    "--dataset=workspace",
    `--data-file=${dataFile}`,
    `--output=${outputPath}`,
    `--qa-output=${qaPath}`,
    `--origin=${origin}`,
    `--request-id=${trace.requestId}`,
    `--project-id=${projectId}`,
    ...(revision ? [`--revision=${revision}`] : []),
  ], root, trace);
  const layout = JSON.parse(await readFile(qaPath, "utf8"));
  const issues = [];
  if (layout.width !== 2000) issues.push({ severity: draft ? "warning" : "blocker", code: "wrong_width", message: `成品宽度为 ${layout.width}px` });
  for (const item of layout.overflows || []) issues.push(layoutOverflowIssue(item, { draft }));
  for (const item of layout.brokenImages || []) issues.push({ severity: draft ? "warning" : "blocker", code: "broken_image", message: `图片未能正常渲染：${item.src}` });
  issues.push(...reviewCardImageUpscales(layout, mode));
  issues.push(...reviewFixedModuleLayout(preflight.expectedFixedModules, layout).map((item) => draft ? { ...item, severity: "warning" } : item));
  for (const item of layout.largeGaps || []) issues.push({ severity: "warning", code: "large_gap", message: `检测到异常大空白 ${item.gap}px` });
  issues.push(...(layout.issues || []), ...(layout.imageQualityIssues || []), ...(layout.imageUpscaleIssues || []));
  const normalizedIssues = normalizeRenderIssues(issues);
  const passed = existsSync(outputPath) && !normalizedIssues.some((item) => item.severity === "blocker");
  return { status: passed ? "success" : "blocked", mode: draft ? "draft" : "final", outputPath: passed ? outputPath : null, timing: rendered.timing, qa: { passed, issues: normalizedIssues, layout }, durationMs: Date.now() - startedAt, rendererCalls: 1 };
}
