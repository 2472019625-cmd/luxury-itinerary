import sharp from "sharp";

// Chromium can report the complete layout while a very tall single capture
// contains an unpainted tail. Keep every capture within a bounded viewport.
export async function captureLongElement(page, target, { tileHeight = 8192 } = {}) {
  const originalViewport = page.viewport();
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Export element has no visible bounds");
  const width = Math.round(box.width);
  const height = Math.ceil(box.height);
  const left = Math.floor(box.x);
  const pageTop = Math.floor(box.y);
  if (height <= 16000) return { png: await target.screenshot({ type: "png", captureBeyondViewport: true }), capture: { mode: "single", width, height, tiles: 1 } };
  const inputs = [];
  try {
    await page.setViewport({ ...originalViewport, width: Math.max(originalViewport.width, Math.ceil(box.x + width)), height: tileHeight, deviceScaleFactor: 1 });
    for (let top = 0; top < height; top += tileHeight) {
      const partHeight = Math.min(tileHeight, height - top);
      let input;
      let actual = "no image";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await page.evaluate(async (y) => {
          window.scrollTo(0, y);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, pageTop + top);
        // Document coordinates and beyond-viewport capture keep the last tile
        // complete when scrolling cannot place its top at the viewport top.
        const candidate = await page.screenshot({ type: "png", captureBeyondViewport: true,
          clip: { x: left, y: pageTop + top, width, height: partHeight } });
        const metadata = await sharp(candidate).metadata();
        actual = `${metadata.width}x${metadata.height}`;
        if (metadata.width === width && metadata.height === partHeight) { input = candidate; break; }
      }
      if (!input) throw new Error(`Export tile dimensions differ at ${top}: expected ${width}x${partHeight}, actual ${actual}, after 3 attempts`);
      inputs.push({ input, left: 0, top });
    }
    const png = await sharp({ create: { width, height, channels: 4, background: "#ffffff" }, limitInputPixels: false }).composite(inputs).png().toBuffer();
    return { png, capture: { mode: "viewport_tiles", width, height, tileHeight, tiles: inputs.length } };
  } finally {
    await page.setViewport(originalViewport);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}
