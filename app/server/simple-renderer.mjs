import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUsableFinalImageSource, validateItineraryFacts } from "../src/lib/itineraryRules.js";
import { selectCustomerRenderData } from "./customer-render-data.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalVisible = /图片未通过终审|审核分数|候选状态|来源账本|成本|利润|供应商底价|内部报价/i;

function deterministicPreflight(data) {
  const issues = [];
  const facts = validateItineraryFacts(data);
  facts.errors.forEach((message) => issues.push({ severity: "blocker", code: "fact_conflict", message }));
  const customer = selectCustomerRenderData(data);
  if (!customer.title || !customer.days?.length) issues.push({ severity: "blocker", code: "required_module_missing", message: "封面标题或每日行程缺失" });
  if (internalVisible.test(JSON.stringify(customer))) issues.push({ severity: "blocker", code: "internal_visible_text", message: "客户输出包含内部审核或成本术语" });
  const sources = [customer.heroImage, ...(customer.hotels || []).flatMap((item) => item.images || []), ...(customer.diningExperiences || []).flatMap((item) => item.images || []), ...(customer.transportSummary || []).flatMap((item) => item.images || []), ...(customer.days || []).flatMap((day) => (day.spots || []).flatMap((spot) => spot.images || []))].map((item) => typeof item === "string" ? item : item?.src).filter(Boolean);
  sources.filter((source) => !isUsableFinalImageSource(source)).forEach((source) => issues.push({ severity: "blocker", code: "unsafe_final_image", message: `成品图片不是本地或用户资源：${source}` }));
  if (new Set(sources).size !== sources.length) issues.push({ severity: "blocker", code: "duplicate_final_image", message: "成品存在完全重复图片" });
  return { passed: !issues.some((item) => item.severity === "blocker"), issues, customer };
}

function runRenderer(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim().split(/\r?\n/).slice(-4).join(" ") || `Renderer 退出码 ${code}`)));
  });
}

export async function runSimpleRenderer({ data, projectId, root = appRoot, origin = "http://127.0.0.1:4173", outputDirectory = path.join(root, "output", "simple-pipeline", projectId) } = {}) {
  const startedAt = Date.now();
  const preflight = deterministicPreflight(data);
  if (!preflight.passed) return { status: "blocked", outputPath: null, qa: preflight, durationMs: Date.now() - startedAt, rendererCalls: 0 };
  await mkdir(outputDirectory, { recursive: true });
  const dataFile = path.join(outputDirectory, "render-data.json");
  const outputPath = path.join(outputDirectory, `${projectId}-itinerary-2000.png`);
  const qaPath = path.join(outputDirectory, "layout-qa.json");
  await writeFile(dataFile, `${JSON.stringify(preflight.customer, null, 2)}\n`, "utf8");
  await runRenderer([
    path.join(root, "renderer", "render.mjs"),
    "--width=2000",
    "--dataset=workspace",
    `--data-file=${dataFile}`,
    `--output=${outputPath}`,
    `--qa-output=${qaPath}`,
    `--origin=${origin}`,
  ], root);
  const layout = JSON.parse(await readFile(qaPath, "utf8"));
  const issues = [];
  if (layout.width !== 2000) issues.push({ severity: "blocker", code: "wrong_width", message: `正式成品宽度为 ${layout.width}px` });
  for (const item of layout.overflows || []) issues.push({ severity: "blocker", code: "text_overflow", message: `文字或模块溢出：${item.selector}` });
  for (const item of layout.brokenImages || []) issues.push({ severity: "blocker", code: "broken_image", message: `图片未能正常渲染：${item.src}` });
  if (!layout.footerPresent) issues.push({ severity: "blocker", code: "footer_missing", message: "固定品牌页脚缺失" });
  for (const item of layout.largeGaps || []) issues.push({ severity: "warning", code: "large_gap", message: `检测到异常大空白 ${item.gap}px` });
  const passed = existsSync(outputPath) && !issues.some((item) => item.severity === "blocker");
  return { status: passed ? "success" : "blocked", outputPath: passed ? outputPath : null, qa: { passed, issues, layout }, durationMs: Date.now() - startedAt, rendererCalls: 1 };
}
