const TYPES = {
  'FLOW-001':'A+B+C','FLOW-002':'A+C','FLOW-003':'A','FLOW-004':'A+C','FLOW-005':'A','FLOW-006':'A','FLOW-007':'A','FLOW-008':'D','FLOW-009':'A+D','FLOW-010':'D',
  'DATA-001':'A+B','DATA-002':'A','DATA-003':'A','DATA-004':'A','DATA-005':'A','DATA-006':'A+B','DATA-007':'A','DATA-008':'A','DATA-009':'A','DATA-010':'A+B','DATA-011':'A+C','DATA-012':'A+C','DATA-013':'A+D','DATA-014':'A+D','DATA-015':'A','DATA-016':'A+D',
  'COPY-001':'B+C+D','COPY-002':'A+C','COPY-003':'A+B+C','COPY-004':'B+C','COPY-005':'B+C','COPY-006':'A+B+C','COPY-007':'B+C','COPY-008':'A+B+C','COPY-009':'A+B+C','COPY-010':'B+C','COPY-011':'A+B+C','COPY-012':'A+B+C','COPY-013':'B+C+D','COPY-014':'A+B+C','COPY-015':'B+C+D','COPY-016':'A+C','COPY-017':'A+C',
  'IMG-001':'A+B','IMG-002':'B+A','IMG-003':'A+B+C','IMG-004':'B+C+D','IMG-005':'B+C+D','IMG-006':'A+B+C','IMG-007':'A+B+D','IMG-008':'A','IMG-009':'A','IMG-010':'A','IMG-011':'A+C','IMG-012':'A+C','IMG-013':'A','IMG-014':'A+D','IMG-015':'A+C','IMG-016':'A+C+D','IMG-017':'A+C+D','IMG-018':'C+D','IMG-019':'A+D','IMG-020':'A+C',
  'VIS-001':'C+D','VIS-002':'A+D','VIS-003':'A+C','VIS-004':'A+C+D','VIS-005':'A+C+D','VIS-006':'A+C+D','VIS-007':'A+C+D','VIS-008':'A+C+D','VIS-009':'A+C','VIS-010':'A+C+D','VIS-011':'C+D','VIS-012':'A+C','VIS-013':'A+C+D','VIS-014':'A+C','VIS-015':'A+C+D','VIS-016':'C+D',
  'OPS-001':'A+D','OPS-002':'A','OPS-003':'A','OPS-004':'A+C','OPS-005':'A+D','OPS-006':'A+B+C+D','OPS-007':'D','OPS-008':'A+C+D','OPS-009':'D','OPS-010':'A+D','OPS-011':'A+C+D','OPS-012':'A+C+D','OPS-013':'A+D',
};

const GROUPS = {
  FLOW: { stage: 'workflow', implementation: ['server/app.mjs','src/Workspace.jsx'], tests: ['tests/workflow-gates.test.mjs'], failure: '未形成阶段结果时阻止推进；允许降级的阶段保存原因。' },
  DATA: { stage: 'import/confirmation', implementation: ['src/lib/itineraryRules.js','src/lib/itineraryImport.js','server/customer-render-data.mjs'], tests: ['tests/itinerary-rules.test.mjs','tests/itinerary-import.test.mjs'], failure: 'blocker 阻止生成；普通缺失进入 needs_confirmation；不安全字段内部隔离。' },
  COPY: { stage: 'copy/brand-review/post-check', implementation: ['prompts/customer-itinerary-editor-v2.md','prompts/customer-itinerary-brand-reviewer-v1.md','config/copy-rule-runtime.mjs','server/content-quality.mjs','server/itinerary-refinement.mjs'], tests: ['tests/content-quality.test.mjs','tests/itinerary-refinement.test.mjs','tests/copy-rule-runtime.test.mjs'], failure: '首轮后固定执行一次独立品牌编辑复核；仅合并客户表达，事实冲突或最终仍不合格即阻止并保存逐规则问题。' },
  IMG: { stage: 'blueprint/search/audit/placement', implementation: ['server/image-blueprint.mjs','server/image-pipeline.mjs','src/lib/imageSlots.js','server/image-download.mjs'], tests: ['tests/image-pipeline.test.mjs','tests/image-security.test.mjs'], failure: '硬错误拒绝；软不足保留候选；预算耗尽 completed_empty；单槽问题只重搜目标位。' },
  VIS: { stage: 'final-qa/export', implementation: ['server/final-layout-review.mjs','renderer/render.mjs','src/App.jsx'], tests: ['tests/final-output-qa.test.mjs','renderer/test-dynamic.mjs'], failure: '布局或输出硬缺陷阻止正式导出；主观审美转人工记录。' },
  OPS: { stage: 'runtime/save/evidence', implementation: ['server/app.mjs','src/lib/storageSafety.js','src/Workspace.jsx'], tests: ['tests/storage-safety.test.mjs','tests/workflow-gates.test.mjs'], failure: '配置与保存失败必须显式失败并保留当前内存状态，不得静默丢失。' },
};

const HUMAN_REQUIRED = new Set(['FLOW-008','FLOW-010','IMG-019','VIS-001','VIS-004','VIS-005','VIS-006','VIS-007','VIS-008','VIS-010','VIS-011','VIS-013','VIS-015','VIS-016','OPS-007','OPS-009']);
const EXTERNAL_BLOCKED = new Set(['DATA-016','VIS-005']);

export const RULE_COVERAGE = Object.freeze(Object.entries(TYPES).map(([id, type]) => {
  const group = GROUPS[id.split('-')[0]];
  return Object.freeze({
    id,
    type: [...new Set(type.split('+'))].sort().join('+'),
    stage: group.stage,
    implementation: group.implementation,
    tests: group.tests,
    failure: group.failure,
    status: EXTERNAL_BLOCKED.has(id) ? 'external_blocked' : HUMAN_REQUIRED.has(id) ? 'human_required' : 'implemented_pending_review',
  });
}));

export function ruleCoverageById(id) {
  return RULE_COVERAGE.find((record) => record.id === id) || null;
}
