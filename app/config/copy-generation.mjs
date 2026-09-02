export const COPY_GENERATION_CONFIG = Object.freeze({
  initialConcurrency: 2,
  maximumConcurrency: 3,
  standardDayBatchSize: 10,
  maxDayInputChars: 60_000,
  maxRequestAttempts: 2,
  maxBrandPasses: 1,
  version: "copy-modules-v4-light-plan-batches",
});
