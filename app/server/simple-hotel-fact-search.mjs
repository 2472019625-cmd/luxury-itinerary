import { runCopyWriterSkill } from "./simple-copy-skill.mjs";
import { saveSimpleHotelFactRow } from "./simple-manual-images.mjs";

const LABELS = Object.freeze({ location: "位置", rooms: "客房", design: "设计", facilities: "设施" });
const KEYS = Object.keys(LABELS);

export async function searchSimpleHotelFacts({ store, root, projectId, hotelIndex, hotelId, keys, mode, copyOptions = {}, render, runCopy = runCopyWriterSkill, saveRow = saveSimpleHotelFactRow } = {}) {
  const index = Number(hotelIndex);
  const project = store.getProject(projectId);
  const run = project?.activeExecutionRunId ? store.getExecutionRun(projectId, project.activeExecutionRunId) : null;
  const plan = project?.activePlanId ? store.getPlan(projectId, project.activePlanId) : null;
  const result = run ? store.getFinalResult(projectId, run.executionRunId) : null;
  const hotel = result?.data?.hotels?.[index];
  if (!hotel || String(hotel.id) !== String(hotelId)) throw Object.assign(new Error("酒店已变化，请重新选择"), { code: "hotel_changed" });
  if (!["fill", "suggest"].includes(mode)) throw Object.assign(new Error("查找方式无效"), { code: "hotel_search_mode_invalid" });
  const selectedKeys = [...new Set(keys || [])];
  if (!selectedKeys.length || selectedKeys.some((key) => !KEYS.includes(key)) || (mode === "suggest" && selectedKeys.length !== 1)) throw Object.assign(new Error("请选择有效的酒店信息字段"), { code: "hotel_fact_keys_invalid" });
  const wanted = mode === "fill" ? selectedKeys.filter((key) => !String((hotel.factRows || []).find((row) => row?.key === key)?.text || "").trim()) : selectedKeys;
  if (!wanted.length) return { mode, hotelId, appliedRows: [], candidates: [], missingKeys: [] };
  const task = (plan?.copyTasks || []).find((item) => item.moduleType === "hotel_fact_rows" && item.targetPath === `hotels.${index}.factRows`);
  if (!task) throw Object.assign(new Error("当前酒店没有可执行的事实查找任务"), { code: "hotel_fact_task_missing" });
  const searchKey = async (key) => {
    const focusedTask = {
      ...task,
      facts: { ...task.facts, hotelSearchSnippets: undefined },
      researchRequest: { ...task.researchRequest, entityName: String(hotel.officialName || task.researchRequest?.entityName || "").trim(), categories: [LABELS[key]], focusCategories: [key] },
      plannerGoal: `${task.plannerGoal}\n本次仅查找并输出「${LABELS[key]}」字段。其他字段留空，不得沿用旧结果。`,
    };
    const execution = await runCopy({ itineraryContext: plan.itineraryContext, tasks: [focusedTask], ...copyOptions });
    const returned = (execution.results || []).find((item) => item.targetId === task.targetId);
    const rows = Array.isArray(returned?.value) ? returned.value : [];
    const row = rows.find((value) => value?.key === key && value.status === "success" && String(value.text || "").trim() && /^https?:\/\//i.test(String(value.sourceUrl || "")));
    return row ? { key, label: LABELS[key], text: String(row.text).trim(), source: { sourceUrl: row.sourceUrl, sourceClass: row.sourceClass, sourceExcerpt: row.sourceExcerpt, checkedAt: row.checkedAt } } : null;
  };
  const candidates = [];
  const failedKeys = [];
  // Keep research bounded: each field gets the same focused query as the successful single-row action.
  for (let start = 0; start < wanted.length; start += 2) {
    const batch = wanted.slice(start, start + 2);
    const results = await Promise.allSettled(batch.map(searchKey));
    results.forEach((result, offset) => {
      if (result.status === "fulfilled" && result.value) candidates.push(result.value);
      else failedKeys.push(batch[offset]);
    });
  }
  if (mode === "suggest") return { mode, hotelId, appliedRows: [], candidates, missingKeys: wanted.filter((key) => !candidates.some((row) => row.key === key)), expectedText: String((hotel.factRows || []).find((row) => row?.key === wanted[0])?.text || "") };
  const appliedRows = [];
  let lastSave = null;
  for (const candidate of candidates) {
    const saved = await saveRow({ store, root, projectId, hotelIndex: index, hotelId, key: candidate.key, text: candidate.text, source: candidate.source, mode: "fill", render, deferRender: true });
    lastSave = saved;
    if (saved.applied) appliedRows.push(saved.row);
  }
  return { mode, hotelId, appliedRows, candidates: [], missingKeys: wanted.filter((key) => !appliedRows.some((row) => row.key === key)), failedKeys, manualVersion: lastSave?.manualVersion, manualRevision: lastSave?.manualRevision, renderPending: lastSave?.renderPending };
}
