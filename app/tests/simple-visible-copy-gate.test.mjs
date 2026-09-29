import assert from "node:assert/strict";
import test from "node:test";
import { applySimpleSkillResults } from "../server/simple-pipeline-writeback.mjs";

test("可见体验卡文案失败在初次写回时阻止正式交付", () => {
  const slotId = "image:day:1:supporting:1";
  const binding = { module: "day", dayIndex: 0, spotIndex: 0, imageIndex: 0, fieldPath: "days.0.spots.0.images.0" };
  const result = applySimpleSkillResults({
    preparedData: { days: [{ spots: [{ id: "spot-1", name: "游猎", images: [] }] }], simpleImageSlotBindings: { [slotId]: binding } },
    copyTasks: [{ targetId: `copy:visual:${slotId}`, targetPath: "visual-card", required: false }],
    copyExecution: { results: [{ targetId: `copy:visual:${slotId}`, status: "failed" }] },
    imageSlots: [{ slotId, required: false }],
    slotBindings: { [slotId]: binding },
    imageExecution: { results: [{ slotId, status: "success", selected: { localUrl: "/image-assets/day.jpg" } }] },
  });
  assert.equal(result.unresolvedItems.find((item) => item.kind === "copy").required, true);
  assert.equal(result.requiredUnresolved.length, 1);
});
