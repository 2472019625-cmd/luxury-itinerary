import assert from "node:assert/strict";
import test from "node:test";
import { imageSearchPresentation } from "../src/lib/imageSearchPresentation.js";

test("provisional image is described as visible but pending confirmation", () => {
  const explanation = imageSearchPresentation({ status: "provisional_pending_confirmation", provisionalSelected: { candidateId: "synthetic" } });
  assert.equal(explanation.title, "已预填·待确认");
  assert.match(explanation.detail, /可编辑草稿/);
  assert.match(explanation.detail, /不能正式下载/);
});
