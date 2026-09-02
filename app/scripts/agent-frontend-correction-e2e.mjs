import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const [normalSource, conflictSource] = process.argv.slice(2,4).map((value) => path.resolve(value || ""));
if (!existsSync(normalSource) || !existsSync(conflictSource)) throw new Error("需要提供正常项目与关键确认项目的真实 Excel");
const outputDir = path.resolve("../audit/evidence/2026-09-02-智能体接入原美化工具前端纠偏/页面截图"); mkdirSync(outputDir,{recursive:true});
const executablePath = [process.env.LUXURY_TRAVEL_BROWSER,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error("未找到 Chrome/Edge");
const browser = await puppeteer.launch({executablePath,headless:true,protocolTimeout:900000,args:["--disable-gpu","--font-render-hinting=none"]});

async function freshWorkspace(page,url,account){
  await page.goto(url,{waitUntil:"networkidle0",timeout:60000}); await page.evaluate(()=>localStorage.clear()); await page.reload({waitUntil:"networkidle0"});
  await page.click(".auth-tabs button:nth-child(2)"); const inputs=await page.$$(".auth-panel form input");
  for(const [index,value] of ["SHEYOU2026",account.name,account.login,"123456"].entries()) await inputs[index].type(value);
  await page.click('.auth-panel form button[type="submit"]'); await page.waitForSelector(".projects-page",{timeout:30000});
}
async function createProject(page){await page.click(".projects-heading .ws-button-primary");await page.waitForSelector(".upload-zone");}
async function upload(page,file){const input=await page.$('.upload-zone input[type="file"]');await input.uploadFile(file);await page.waitForSelector(".recognition-strip",{timeout:60000});}
const results={createdAt:new Date().toISOString(),fixed:{},agent:{},normal:{},conflict:{}};
try{
  const fixed=await browser.newPage();await fixed.setViewport({width:1440,height:1000});await freshWorkspace(fixed,"http://127.0.0.1:4173/",{name:"固定流程对比",login:"fixedcompare"});await createProject(fixed);
  results.fixed={url:fixed.url(),stepLabels:await fixed.$$eval(".step-item strong",items=>items.map(item=>item.textContent)),storageKeys:await fixed.evaluate(()=>Object.keys(localStorage).sort()),hasAgentStrip:Boolean(await fixed.$(".agent-mode-strip")),screenshot:path.join(outputDir,"01-4173-固定流程上传页.png")};await fixed.screenshot({path:results.fixed.screenshot,fullPage:true});await fixed.close();

  const page=await browser.newPage();await page.setViewport({width:1440,height:1000});await freshWorkspace(page,"http://127.0.0.1:4174/agent",{name:"智能体前端验证",login:"agentverify"});await createProject(page);
  results.agent={url:page.url(),stepLabels:await page.$$eval(".step-item strong",items=>items.map(item=>item.textContent)),storageKeys:await page.evaluate(()=>Object.keys(localStorage).sort()),hasAgentStrip:Boolean(await page.$(".agent-mode-strip")),uploadScreenshot:path.join(outputDir,"02-4174-智能体上传页.png")};await page.screenshot({path:results.agent.uploadScreenshot,fullPage:true});

  await upload(page,normalSource);await page.click(".flow-footer .ws-button-primary");await page.waitForSelector(".confirm-layout");results.normal.confirmScreenshot=path.join(outputDir,"03-4174-正常项目确认页.png");await page.screenshot({path:results.normal.confirmScreenshot,fullPage:true});
  await page.click(".flow-footer .ws-button-primary");await page.waitForSelector(".agent-workspace-generation");await page.waitForFunction(()=>document.querySelector(".agent-workspace-generation h1")?.textContent.includes("计划已经准备好"),{timeout:600000});
  const agentProjects=JSON.parse(await page.evaluate(()=>localStorage.getItem("sheyou-agent-projects-v1")));const normalLocal=agentProjects.find(item=>item.agentProjectId);const normalId=normalLocal.agentProjectId;
  const normalApi=await (await fetch(`http://127.0.0.1:4174/api/agent/projects/${normalId}`)).json();const executionResponse=await fetch(`http://127.0.0.1:4174/api/agent/projects/${normalId}/execution-runs`,{method:"POST"});const executionValue=await executionResponse.json();
  results.normal={...results.normal,projectId:normalId,source:path.basename(normalSource),projectStatus:normalApi.project.status,activePlanId:normalApi.project.activePlanId,planId:normalApi.plan?.planId,taskCount:normalApi.plan?.tasks?.length||0,planOnly:normalApi.plan?.status,executionEnabled:normalApi.plan?.executionEnabled,downstreamActualCalls:(normalApi.plan?.capabilityCallStats||[]).filter(item=>!["source_parser","trip_planner"].includes(item.capabilityId)).reduce((sum,item)=>sum+item.actualCalls,0),executionRunId:executionValue.executionRun?.executionRunId,executionPlanId:executionValue.executionRun?.planId,executionActualCalls:(executionValue.executionRun?.capabilityCallStats||[]).reduce((sum,item)=>sum+item.actualCalls,0),fiveSteps:await page.$$eval(".step-item strong",items=>items.map(item=>item.textContent)),hasProgressPercent:/\d+%/.test(await page.$eval(".agent-workspace-generation",el=>el.innerText)),hasEditorAction:/进入编辑|下载版本已开放/.test(await page.$eval(".agent-workspace-generation",el=>el.innerText)),generationScreenshot:path.join(outputDir,"04-4174-智能体生成页.png")};await page.screenshot({path:results.normal.generationScreenshot,fullPage:true});
  await page.click(".workspace-agent-plan > summary");results.normal.planScreenshot=path.join(outputDir,"05-4174-生成页展开规划.png");await page.screenshot({path:results.normal.planScreenshot,fullPage:true});

  await page.click(".header-brand");await page.waitForSelector(".projects-page");await createProject(page);await upload(page,conflictSource);await page.click(".flow-footer .ws-button-primary");await page.waitForSelector(".agent-inline-confirm");
  const latestProjects=JSON.parse(await page.evaluate(()=>localStorage.getItem("sheyou-agent-projects-v1")));const conflictLocal=latestProjects.find(item=>item.agentProjectId&&item.agentProjectId!==normalId);const conflictApi=await (await fetch(`http://127.0.0.1:4174/api/agent/projects/${conflictLocal.agentProjectId}`)).json();
  results.conflict={projectId:conflictLocal.agentProjectId,source:path.basename(conflictSource),projectStatus:conflictApi.project.status,activePlanId:conflictApi.project.activePlanId,confirmationCount:conflictApi.confirmations.length,hasRecommendedChoice:/建议/.test(await page.$eval(".agent-inline-confirm",el=>el.innerText)),screenshot:path.join(outputDir,"06-4174-关键确认页.png")};await page.screenshot({path:results.conflict.screenshot,fullPage:true});await page.close();
}finally{await browser.close();}

results.passed=JSON.stringify(results.fixed.stepLabels)===JSON.stringify(["上传资料","确认信息","生成内容","编辑预览","下载版本"])&&JSON.stringify(results.agent.stepLabels)===JSON.stringify(results.fixed.stepLabels)&&!results.fixed.hasAgentStrip&&results.agent.hasAgentStrip&&results.fixed.storageKeys.some(key=>key.startsWith("sheyou-workspace-"))&&!results.fixed.storageKeys.some(key=>key.startsWith("sheyou-agent-"))&&results.agent.storageKeys.some(key=>key.startsWith("sheyou-agent-"))&&!results.agent.storageKeys.some(key=>key.startsWith("sheyou-workspace-"))&&results.normal.projectStatus==="ready_for_execution"&&results.normal.activePlanId===results.normal.planId&&results.normal.executionPlanId===results.normal.planId&&results.normal.downstreamActualCalls===0&&results.normal.executionActualCalls===0&&!results.normal.hasProgressPercent&&!results.normal.hasEditorAction&&results.conflict.projectStatus==="awaiting_confirmation"&&!results.conflict.activePlanId&&results.conflict.confirmationCount>0&&results.conflict.hasRecommendedChoice;
writeFileSync(path.join(outputDir,"frontend-correction-validation.json"),`${JSON.stringify(results,null,2)}\n`);console.log(JSON.stringify(results,null,2));if(!results.passed)process.exitCode=1;
