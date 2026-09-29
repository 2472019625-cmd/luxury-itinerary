// One bounded real research request; never runs Planner, Writer or image search.
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { requestCopyFactsResearch, verifyCopyFactsResearch } from "../server/simple-copy-facts-research.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const i=arg.indexOf("="); return [arg.slice(2,i),arg.slice(i+1)]; }));
const output = await realpath(args["output-dir"]);
const repo = path.resolve(import.meta.dirname, "../..");
const relative = path.relative(repo, output);
assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "Require registered external private evidence directory");
const request = JSON.parse((await readFile(args["request-file"], "utf8")).replace(/^\uFEFF/, ""));
assert.equal(request.entityKind, "hotel");
for (const file of [".env.local", ".env.image-search.local"]) {
  const contents = await readFile(path.join(args["config-dir"], file), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}
const save = (name,value) => writeFile(path.join(output,name),JSON.stringify(value,null,2),{flag:"wx"});
const started=Date.now();
let physicalRequests=0;
const pages=[];
const signal=AbortSignal.timeout(240000);
try {
  const response=await requestCopyFactsResearch({ researchRequest:request, apiKey:process.env.IMAGE_SEARCH_API_KEY,
    baseUrl:process.env.IMAGE_SEARCH_BASE_URL, emptyContentRetries:0, maxTransportAttempts:1, signal,
    fetchImpl:async (...input)=>{
      if(physicalRequests>=1)throw new Error("Single physical request limit");
      physicalRequests++;
      const result=await fetch(...input);
      const payload=await result.clone().json().catch(()=>({}));
      await save("raw-response.json",{content:payload.choices?.[0]?.message?.content||null,finishReason:payload.choices?.[0]?.finish_reason||null,status:result.status});
      return result;
    },
  });
  await save("parsed-response.json",response.json);
  const verified=await verifyCopyFactsResearch({researchRequest:request,candidates:response.json.facts,reportedOutcomes:response.json.categoryOutcomes,signal,
    onSourcePage:async page=>{pages.push(page);await writeFile(path.join(output,"source-pages.json"),JSON.stringify(pages,null,2));},
  });
  await save("verified.json",verified);
  const summary={status:"REQUIRES_SEMANTIC_REVIEW",physicalRequests,durationMs:Date.now()-started,verifiedCount:verified.verifiedFacts.length,
    rejected:verified.rejected.map(item=>({category:item.category,reason:item.reason})),pages:pages.length};
  await save("summary.json",summary);console.log(JSON.stringify(summary));
}catch(error){
  const summary={status:"FAIL",physicalRequests,durationMs:Date.now()-started,code:error.code||error.name};
  await save("summary.json",summary);console.log(JSON.stringify(summary));process.exitCode=1;
}
