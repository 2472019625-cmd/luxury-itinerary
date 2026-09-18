import fs from 'node:fs';
import {explicitEntityRoute} from '../server/knowledge-scope-resolver.mjs';
import {buildWebExecutionQueries} from '../server/image-web-execution.mjs';
import {prepareWebCandidates} from '../server/web-image-candidates.mjs';
const p=JSON.parse(fs.readFileSync('output/simple-pipeline/projects/8fc84b8d-c685-4359-9ad8-f670fd837d7d/plans/d2997456-4265-42ee-a073-b78c9d0e69df.json'));
const r=JSON.parse(fs.readFileSync('output/full-pipeline-real-runs/2026-09-18T07-48-30-764Z/result.json'));
const slots=p.imageSlots.map(s=>{
  const x=r.imageExecution.results.find(x=>x.slotId===s.slotId);
  const raw=x.candidates.filter(c=>c.sourceKind!=='knowledge_library'&&!c.knowledgeAssetKey);
  const f=prepareWebCandidates(raw),route=explicitEntityRoute(s);
  return {slotId:s.slotId,subject:s.subject,route,preparedWebQueries:buildWebExecutionQueries(s,s.searchIntent,'',route),before:f.before,after:f.after,filtered:f.filtered};
});
const report={validationType:'offline_replay_real_records_not_live_search',before:slots.reduce((n,s)=>n+s.before,0),after:slots.reduce((n,s)=>n+s.after,0),filtered:slots.reduce((n,s)=>n+s.filtered.length,0),slots};
fs.writeFileSync('output/web-policy-real-output-replay.json',JSON.stringify(report,null,2));
fs.writeFileSync('output/web-policy-real-output-replay.md','# Web规则：真实记录离线对照\n\n不是新一轮联网结果；下载/审核数量仅在受控Image-only测试中验证。\n\n'+slots.map(s=>`## ${s.slotId}\n\n画面：${s.subject}\n\nFast path：${s.route.matched}；依据：${s.route.routingReason}\n\n准备Web词：\n\n${s.preparedWebQueries.map(q=>'- '+q).join('\n')}\n\n历史Web候选回放：${s.before} → ${s.after}\n`).join('\n'));
console.log(JSON.stringify({before:report.before,after:report.after,filtered:report.filtered,examples:slots.filter(s=>/day:4:primary|day:8:primary|carnivore|day:7:supporting:1/.test(s.slotId))},null,2));
