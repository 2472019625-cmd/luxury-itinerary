import test from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeImageConfirmations, enrichPendingImageConfirmations, imageConfirmationChoices } from "../server/agent-image-confirmation.mjs";

const candidate = {
  candidateId: "candidate-cover-1",
  slotId: "cover:hero",
  status: "manual_review",
  adoptable: true,
  hardRejectCode: "none",
  localPreviewUrl: "/image-assets/run/cover.webp",
  sourcePage: "https://example.com/source",
  reason: "无硬伤，封面代表性需要人工确认",
  terminalAudit: { relevance: 76 },
};

test("必需图片确认会展示真实候选预览与来源，而不是只有等待选项", () => {
  const choices = imageConfirmationChoices({ imageCandidates: [candidate] }, "cover:hero");
  assert.equal(choices[0].choiceId, "use_image_candidate:candidate-cover-1");
  assert.equal(choices[0].previewUrl, candidate.localPreviewUrl);
  assert.equal(choices[0].sourcePage, candidate.sourcePage);
  assert.equal(choices.at(-1).choiceId, "wait_for_image:cover:hero");
  const enriched = enrichPendingImageConfirmations([{ confirmationId: "c1", category: "图片", status: "pending", choices: [{ choiceId: "wait_for_image:cover:hero" }] }], { imageCandidates: [candidate] });
  assert.equal(enriched[0].imageSlotId, "cover:hero");
  assert.equal(enriched[0].choices.length, 2);
});

test("人工采用候选后锁定对应版位并留下选择记录", () => {
  const imageResult = {
    data: {
      title: "坦桑尼亚10日行程",
      destination: "坦桑尼亚",
      hotels: [], days: [], diningExperiences: [], transportSummary: [],
      imageCandidates: [candidate],
      imageReview: { slots: [{ slotId: "cover:hero", status: "manual_review", selectedCandidateIds: [] }], pendingCount: 1, stats: { manualReview: 1, manualReviewSlots: 1 } },
      imageResearch: { pendingReviewCount: 1, stats: { manualReview: 1, manualReviewSlots: 1 } },
    },
  };
  const applied = applyRuntimeImageConfirmations(imageResult, [{ status: "resolved", imageSlotId: "cover:hero", selectedChoiceId: "use_image_candidate:candidate-cover-1" }]);
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.pendingCount, 0);
  assert.equal(applied.data.heroImage, candidate.localPreviewUrl);
  assert.equal(applied.data.imageLocks["cover:hero"].candidateId, candidate.candidateId);
  assert.equal(applied.data.imageReview.slots[0].status, "user_locked");
  assert.equal(applied.data.imageDecisions[0].action, "accept_manual_candidate");
});

test("旧检查点里已经明确主体或地点不符的图片不会继续展示为可采用候选", () => {
  const wrong = { ...candidate, candidateId: "wrong", terminalAudit: { subjectMatch: false, placeMatch: true, relevance: 90 } };
  const choices = imageConfirmationChoices({ imageCandidates: [wrong] }, "cover:hero");
  assert.deepEqual(choices.map((item) => item.choiceId), ["wait_for_image:cover:hero"]);
});
