import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const [normalSource, conflictSource] = process.argv.slice(2,4).map((item) => path.resolve(item || ""));
if (!existsSync(normalSource) || !existsSync(conflictSource)) throw new Error("需要提供两个存在的全新 Excel 路径");
const outputDir=path.resolve("../audit/evidence/2026-09-02-最终智能体项目主流程与执行调度框架MVP/页面截图"); mkdirSync(outputDir,{recursive:true});
const executablePath=[process.env.LUXURY_TRAVEL_BROWSER,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(existsSync);
if(!executablePath) throw new Error("未找到 Chrome/Edge");
const browser=await puppeteer.launch({executablePath,headless:true,args:["--disable-gpu","--font-render-hinting=none"]});
const results=[];
async function upload(source,expectedStatus,index){
  const page=await browser.newPage(); await page.setViewport({width:1440,height:1000,deviceScaleFactor:1});
  await page.goto("http://127.0.0.1:4174/agent",{waitUntil:"networkidle0",timeout:60000});
  const picker=await page.$('input[type="file"]'); await picker.uploadFile(source);
  await page.waitForFunction((status)=>document.querySelector(`.state-${status}`),{timeout:600000},expectedStatus);
  const projectId=new URL(page.url()).pathname.split("/").at(-1);
  const before=await page.evaluate(()=>({text:document.body.innerText,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,confirmationCards:document.querySelectorAll(".agent-confirm article").length,taskRows:document.querySelectorAll(".agent-run-list>div").length,planDetails:Boolean(document.querySelector(".agent-plan-details")),error:Boolean(document.querySelector(".agent-error"))}));
  if(expectedStatus==="ready_for_execution"){
    await page.click(".agent-ready button"); await page.waitForFunction(()=>document.querySelector(".agent-execution-notice")?.textContent.includes("执行能力尚未开放"),{timeout:30000});
  }
  const api=await (await fetch(`http://127.0.0.1:4174/api/agent/projects/${projectId}`)).json();
  const screenshot=path.join(outputDir,`${String(index).padStart(2,"0")}-${projectId.slice(0,8)}-${expectedStatus}.png`); await page.screenshot({path:screenshot,fullPage:true});
  const result={projectId,source:path.basename(source),expectedStatus,actualStatus:api.project.status,activePlanId:api.project.activePlanId,confirmationCount:api.confirmations.length,executionRunId:api.executionRun?.executionRunId||null,executionStatus:api.executionRun?.status||null,executionActualCalls:(api.executionRun?.capabilityCallStats||[]).reduce((sum,item)=>sum+item.actualCalls,0),planTaskCount:api.plan?.tasks?.length||0,planStatus:api.plan?.status||null,planExecutionEnabled:api.plan?.executionEnabled??null,downstreamActualCalls:(api.plan?.capabilityCallStats||[]).filter((item)=>!["source_parser","trip_planner"].includes(item.capabilityId)).reduce((sum,item)=>sum+item.actualCalls,0),screenshot,...before};
  if(result.actualStatus!==expectedStatus||result.overflow||result.error||/100%|进入编辑器|导出成品/.test(before.text)) throw new Error(`页面状态验证失败: ${JSON.stringify(result)}`);
  if(expectedStatus==="ready_for_execution"&&(!result.activePlanId||!result.planDetails||result.taskRows<1||result.executionStatus!=="execution_disabled"||result.executionActualCalls!==0||result.downstreamActualCalls!==0)) throw new Error(`正式项目执行边界失败: ${JSON.stringify(result)}`);
  if(expectedStatus==="awaiting_confirmation"&&(result.activePlanId||result.confirmationCards<1||result.executionRunId)) throw new Error(`确认门禁失败: ${JSON.stringify(result)}`);
  results.push(result); await page.close();
}
try{await upload(normalSource,"ready_for_execution",1);await upload(conflictSource,"awaiting_confirmation",2);}finally{await browser.close();}
const value={createdAt:new Date().toISOString(),passed:true,results}; writeFileSync(path.join(outputDir,"formal-workspace-validation.json"),`${JSON.stringify(value,null,2)}\n`); console.log(JSON.stringify(value,null,2));
