import sharp from "sharp";

// Chromium can report the complete layout while a very tall single capture
// contains an unpainted tail. Keep every capture within a bounded viewport.
export async function captureLongElement(page, target, { tileHeight = 8192 } = {}) {
  const originalViewport = page.viewport();
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Export element has no visible bounds");
  const width = Math.round(box.width);
  const height = Math.ceil(box.height);
  if (height <= 16000) return { png: await target.screenshot({ type: "png", captureBeyondViewport: true }), capture: { mode: "single", width, height, tiles: 1 } };
  const inputs = [];
  try {
    await page.setViewport({ ...originalViewport, width: Math.max(originalViewport.width, Math.ceil(box.x + width)), height: tileHeight, deviceScaleFactor: 1 });
    for (let top = 0; top < height; top += tileHeight) {
      const partHeight = Math.min(tileHeight, height - top);
      await page.evaluate(async (y) => {
        window.scrollTo(0, y);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, box.y + top);
      const input = await page.screenshot({ type: "png", captureBeyondViewport: false,
        clip: { x: box.x, y: box.y + top, width, height: partHeight } });
      const metadata = await sharp(input).metadata();
      if (metadata.width !== width || metadata.height !== partHeight) throw new Error(`Export tile dimensions differ at ${top}`);
      inputs.push({ input, left: 0, top });
    }
    const png = await sharp({ create: { width, height, channels: 4, background: "#ffffff" } }).composite(inputs).png().toBuffer();
    return { png, capture: { mode: "viewport_tiles", width, height, tileHeight, tiles: inputs.length } };
  } finally {
    await page.setViewport(originalViewport);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}
