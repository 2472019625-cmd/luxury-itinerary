export const AGENT_STAGE_BUDGETS = Object.freeze({
  planning: Object.freeze({ targetMs: 180_000, stopMs: 300_000 }),
  verification: Object.freeze({ targetMs: 120_000, stopMs: 240_000 }),
  copy: Object.freeze({ targetMs: 360_000, stopMs: 600_000 }),
  images: Object.freeze({ targetMs: 420_000, stopMs: 720_000 }),
  render: Object.freeze({ targetMs: 180_000, stopMs: 300_000 }),
  final_checks: Object.freeze({ targetMs: 120_000, stopMs: 240_000 }),
  fullRunTargetMs: 1_200_000,
});
