import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { captureLongElement } from "../renderer/capture-long-element.mjs";

test("长图按文档坐标分段截取，短块重试后仍检查实际尺寸", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "long-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clips = [];
  const viewports = [];
  const originalViewport = { width: 20, height: 1000, deviceScaleFactor: 1 };
  const page = {
    viewport: () => originalViewport,
    setViewport: async value => { viewports.push(value); },
    evaluate: async () => {},
    screenshot: async ({ clip, captureBeyondViewport }) => {
      clips.push(clip);
      assert.equal(captureBeyondViewport, true);
      const short = clips.length === 1;
      return sharp({ create: { width: clip.width, height: clip.height - (short ? 1 : 0), channels: 3, background: "white" } }).png().toBuffer();
    },
  };
  const target = { boundingBox: async () => ({ x: 1.4, y: 2.6, width: 10, height: 16001 }) };
  const output = path.join(directory, "output.png");
  const { png, capture } = await captureLongElement(page, target, { tileHeight: 6000 });
  await writeFile(output, png);
  assert.equal(capture.tiles, 3);
  assert.deepEqual(viewports.at(-1), originalViewport);
  assert.equal(clips.length, 4);
  assert.deepEqual(clips.at(-1), { x: 1, y: 12002, width: 10, height: 4001 });
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 10);
  assert.equal(metadata.height, 16001);
});
