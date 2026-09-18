import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const directory=path.resolve(process.argv[2]);
const baseline=path.resolve('output/web-relevance-smoke/2026-09-18T10-57-45-873Z');
const result=JSON.parse(fs.readFileSync(path.join(directory,'result.json')));
const previous=JSON.parse(fs.readFileSync(path.join(baseline,'result.json')));
const run=JSON.parse(fs.readFileSync(path.join(directory,'report.json')));
const names={'image:day:5:primary':'DAY5 角马渡河','image:day:2:primary':'DAY2 湿地俯瞰','image:day:4:primary':'DAY4 新月岛徒步','image:day:3:supporting:2':'DAY3 地狱门骑行','image:dining:imported-dining-restaurant-the-carnivore-day-7:primary':'The Carnivore','image:hotel:imported-hotel-1:primary':'Soroi Amboseli Camp'};
const fingerprint=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sameSlots=fingerprint(path.join(directory,'input-slots.json'))===fingerprint(path.join(baseline,'input-slots.json'));
const rows=result.results.map(s=>{
  const e=s.pipelineEvidence.webExecution,q=e.queryReports||[],old=previous.results.find(x=>x.slotId===s.slotId);
  const sum=k=>q.reduce((a,x)=>a+Number(x[k]||0),0);
  const attempted=s.candidates.filter(c=>c.originalDownloadStatus==='success'||c.originalDownloadStatus==='failed');
  return {slotId:s.slotId,name:names[s.slotId],status:s.status,wallClockMs:s.durationMs,raw:sum('rawResources'),technical:sum('technicalFiltered'),resize:sum('resizeDuplicates'),strong:sum('strong_match'),mismatch:sum('explicit_mismatch'),uncertain:sum('insufficient_evidence'),uncertainChosen:sum('insufficientInDownloadPool'),uniqueDownloads:e.downloadsUsed,downloadAttempts:sum('downloadAttempts'),downloadSuccess:sum('downloadSuccess'),vision:sum('visionAudits'),waves:q.flatMap(x=>x.visionBatchSizes||[]),selected:s.selected,queryPages:q.map(x=>x.accessedPages),pageFailures:sum('pageFailures'),secondQueryExecuted:e.executedQueries.length>1,plannedQueriesUnchanged:JSON.stringify(e.plannedQueries)===JSON.stringify(old.pipelineEvidence.webExecution.plannedQueries),attemptedURLs:attempted.map(c=>c.imageUrl)};
});
const summary={sameSlots,knowledgeCalls:result.metrics.knowledgeCalls,wallClockMs:run.wallClockMs,previousWallClockMs:742012,rows,metrics:result.metrics,tests:{targeted:{passed:18,total:18},existingImage:{passed:76,total:82,failed:6}}};
fs.writeFileSync(path.join(directory,'comparison.json'),JSON.stringify(summary,null,2));
let md='# Web三态门禁：同组6个真实图片位回归\n\n';
md+=`整轮等待：${(run.wallClockMs/1000).toFixed(1)}秒；上轮742.0秒。相同图片位文件指纹：${sameSlots}；所有计划Web词保持不变：${rows.every(x=>x.plannedQueriesUnchanged)}；Knowledge请求${result.metrics.knowledgeCalls}。未跑完整Pipeline、未部署。实时搜索返回网页与网络状态会变化，耗时差异不能全部归因于门禁。\n\n`;
md+='| 图片位 | 原始资源 | 技术/resize | 明确相关 | 明确不符 | 证据不足 | 不足中选入下载池 | 下载候选/HTTP尝试/成功 | Vision批次 | 采用 | 秒 |\n|---|---:|---|---:|---:|---:|---:|---|---|---|---:|\n';
for(const r of rows)md+=`| ${r.name} | ${r.raw} | ${r.technical}/${r.resize} | ${r.strong} | ${r.mismatch} | ${r.uncertain} | ${r.uncertainChosen} | ${r.uniqueDownloads}/${r.downloadAttempts}/${r.downloadSuccess} | ${r.waves.join('+')||0} | ${r.status} | ${(r.wallClockMs/1000).toFixed(1)} |\n`;
md+='\n说明：下载候选数为累计预算消耗的独立候选数；下载尝试含技术重试，不等于候选数。下载成功与Vision成功不同。queryReport.downloadPool是门禁后可排序待选总数，不是全部会下载；有限池以downloadsUsed和insufficientInDownloadPool计。证据不足候选不自动视为合格，仍需Vision、下载和去重。审核接口上限4张。\n\n定向测试18/18通过，旧Image测试76/82通过，剩余6项失败均已存在上一轮失败名单中，整体回归未通过。最后补充的住宿背景身份隔离对这6个真实输入等价（非酒店位hotel均为空）。\n\n';
for(const s of result.results){const e=s.pipelineEvidence;let pageOffset=0;md+=`## ${names[s.slotId]}\n\n结果：${s.status}；停止原因：${e.webExecution.stopReason}。\n\n`;for(const [i,q]of e.webExecution.queryReports.entries()){const pages=e.searchPageUrls.slice(pageOffset,pageOffset+q.accessedPages);pageOffset+=q.accessedPages;md+=`### Query ${i+1}\n\n${q.query}\n\n访问${q.accessedPages}页，失败${q.pageFailures}页；明确相关${q.strong_match}，明确不符${q.explicit_mismatch}，证据不足${q.insufficient_evidence}，不足中选入下载${q.insufficientInDownloadPool}；下载尝试${q.downloadAttempts}，成功${q.downloadSuccess}，Vision批次${(q.visionBatchSizes||[]).join('+')||0}。\n\n${pages.map(p=>`- [来源页](${p})`).join('\n')}\n\n`;}
for(const c of s.candidates.filter(c=>c.originalDownloadStatus!=='not_requested'||c.hardJudgment)){md+=`- [图片资源](${c.imageUrl})：下载${c.originalDownloadStatus}；审核${c.qualificationStatus}；实际主体${c.actualSubject||'未完成判断'}；原因${c.matchReason||c.originalDownloadFailureReason||c.rejection||'未采用'}${c.selected?'；最终采用':''}\n`;}
if(s.selected?.localUrl){const file=path.join(process.cwd(),'output',s.selected.localUrl.replace(/^\//,''));md+=`\n最终采用：[本地图片](${file.replace(/\\/g,'/')})；[来源网页](${s.selected.sourcePage})。\n`;}
md+='\n';}
fs.writeFileSync(path.join(directory,'test-report.md'),md);
console.log(JSON.stringify({directory,sameSlots,rows:rows.map(({selected,attemptedURLs,...r})=>r)},null,2));
