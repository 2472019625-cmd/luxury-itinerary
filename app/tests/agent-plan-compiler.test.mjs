import test from "node:test";
import assert from "node:assert/strict";
import { compileAgentExecutionPlan, filterImagePlanForModules, normalizeBusinessModules } from "../server/agent-plan-compiler.mjs";

const factBasis = { destination: "坦桑尼亚", dayCount: 10, hotels: [{ id: "h1", name: "营地", nights: 3 }], diningExperiences: [], transport: [{ category: "游猎车" }], days: Array.from({ length: 10 }, (_, index) => ({ day: index + 1 })) };

test("模型只给业务判断，程序稳定编译技术任务图", () => {
  const raw = { modules: [{ moduleId: "days", decision: "show", contentAction: "optimize" }], tasks: [{ taskId: "模型不应控制" }], copyPlan: { groups: [{ id: "模型不应控制" }] } };
  const first = compileAgentExecutionPlan(raw, { factBasis });
  const second = compileAgentExecutionPlan(structuredClone(raw), { factBasis: structuredClone(factBasis) });
  assert.deepEqual(first.tasks, second.tasks);
  assert.equal(first.copyPlan.compiledBy, "program");
  assert.equal(first.tasks.some((item) => item.taskId === "模型不应控制"), false);
  assert.equal(first.tasks.filter((item) => item.taskType === "copy_day_group").length, 1);
});

test("有真实交通和酒店时模型不能错误隐藏硬模块", () => {
  const compiled = compileAgentExecutionPlan({ modules: [{ moduleId: "transport", decision: "hide", contentAction: "hide" }, { moduleId: "hotels", decision: "hide", contentAction: "hide" }] }, { factBasis });
  assert.equal(compiled.modules.find((item) => item.moduleId === "transport").decision, "show");
  assert.equal(compiled.modules.find((item) => item.moduleId === "hotels").decision, "show");
});

test("已隐藏条件模块的补充图片位不会进入后续搜索", () => {
  const modules = normalizeBusinessModules([{ moduleId: "dining", decision: "hide", contentAction: "hide" }], { ...factBasis, diningExperiences: [] });
  const filtered = filterImagePlanForModules({ slots: [{ role: "cover" }, { role: "day:1" }, { slotId: "featured-dining:1", role: "featured" }, { module: "restaurant", role: "detail:1" }] }, modules);
  assert.deepEqual(filtered.slots.map((item) => item.role), ["cover", "day:1"]);
});
