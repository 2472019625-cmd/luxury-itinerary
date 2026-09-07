import test from "node:test";
import assert from "node:assert/strict";
import { coverLayout } from "../src/lib/coverLayout.js";

test("clear landscape covers retain their natural ratio", () => {
  assert.deepEqual(coverLayout(2400, 1600), { displayMode: "landscape", aspectRatio: "2400 / 1600" });
  assert.equal(coverLayout(1200, 1000).displayMode, "landscape");
  assert.equal(coverLayout(3200, 1000).aspectRatio, "3200 / 1000");
});

test("portrait, near-square, missing and invalid dimensions retain the existing safe frame", () => {
  for (const size of [[1600, 2400], [1000, 1200], [1000, 1000], [1100, 1000], [1000, 1100], [], [0, 100], [-1, 100], [Infinity, 100], [NaN, 100]]) {
    assert.deepEqual(coverLayout(...size), { displayMode: "portrait", aspectRatio: null });
  }
});
