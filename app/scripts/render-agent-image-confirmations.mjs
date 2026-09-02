import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const projectId = process.argv.find((value) => value.startsWith("--project="))?.slice(10);
const origin = process.argv.find((value) => value.startsWith("--origin="))?.slice(9) || "http://127.0.0.1:4174";
const output = path.resolve(process.argv.find((value) => value.startsWith("--output="))?.slice(9) || "agent-image-confirmations.png");
if (!projectId) throw new Error("必须提供 --project=");
const snapshot = await fetch(`${origin}/api/agent/projects/${projectId}`).then((response) => response.json());
const pending = (snapshot.confirmations || []).filter((item) => item.status === "pending" && item.category === "图片");
const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!executablePath) throw new Error("未找到 Chrome/Edge");
const escape = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const cards = pending.map((item, index) => {
  const choices = item.choices.filter((choice) => choice.previewUrl);
  return `<article><header><b>${index + 1}. ${escape(item.imageSlotId)}</b><span>${choices.length} 张候选</span></header><div class="choices">${choices.map((choice) => `<section><img src="${origin}${escape(choice.previewUrl)}"><strong>${escape(choice.label)}</strong><p>${escape(choice.reason).slice(0, 150)}</p></section>`).join("")}</div></article>`;
}).join("");
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:38px;background:#f2eee6;color:#25221d;font-family:"Microsoft YaHei",sans-serif}h1{margin:0 0 8px;font:700 30px/1.3 Georgia,serif}body>p{margin:0 0 26px;color:#6d665b}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{padding:18px;background:#fff;border:1px solid #ded5c7;border-radius:12px;box-shadow:0 6px 20px #392d1d12}header{display:flex;justify-content:space-between;gap:12px;margin-bottom:12px}header b{font-size:14px;overflow-wrap:anywhere}header span{flex:none;color:#9c772e;font-size:12px}.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.choices section{min-width:0}.choices img{width:100%;height:190px;object-fit:cover;border-radius:8px;background:#ddd}.choices strong{display:block;margin-top:7px;font-size:13px}.choices p{margin:5px 0 0;color:#70695e;font-size:11px;line-height:1.45}</style><h1>坦桑尼亚真实项目 · 必需图片候选</h1><p>以下候选均无明确硬伤，但未达到系统自动采用门槛，需要人工确认。按编号回复“全部采用候选1”或单独指定。</p><main>${cards}</main>`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: output, fullPage: true });
  process.stdout.write(`${output}\n`);
} finally {
  await browser.close();
}
