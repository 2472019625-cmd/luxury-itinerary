import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DINING_INTRO_COPY, LEGACY_DINING_INTRO_COPY, displayDiningIntroCopy } from "../src/lib/diningIntroCopy.js";

test("特色餐饮使用简洁默认引导文案，同时保留人工修改", () => {
  assert.equal(displayDiningIntroCopy(""), DEFAULT_DINING_INTRO_COPY);
  assert.equal(displayDiningIntroCopy(LEGACY_DINING_INTRO_COPY), DEFAULT_DINING_INTRO_COPY);
  assert.equal(displayDiningIntroCopy("我写的特色餐饮介绍"), "我写的特色餐饮介绍");
});
