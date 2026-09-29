import sharp from "sharp";

export async function captureLongElement({ page, target, output, tileHeight = 6000 } = {}) {
  const box = await target.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error("Export target has no visible bounds");
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  const left = Math.floor(box.x);
  const pageTop = Math.floor(box.y);
  if (height <= 16000) {
    await target.screenshot({ path: output, type: "png", captureBeyondViewport: true });
    return { width, height, tiles: 1 };
  }
  const inputs = [];
  for (let top = 0; top < height; top += tileHeight) {
    const partHeight = Math.min(tileHeight, height - top);
    let image;
    let actual = "no image";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.evaluate((position) => new Promise((resolve) => {
        window.scrollTo(0, position);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }), pageTop + top);
      // Clip coordinates are document-relative; captureBeyondViewport avoids a short
      // last tile when the browser cannot scroll its bottom to the viewport top.
      const candidate = await page.screenshot({ type: "png", captureBeyondViewport: true, clip: { x: left, y: pageTop + top, width, height: partHeight } });
      const metadata = await sharp(candidate).metadata();
      actual = `${metadata.width}x${metadata.height}`;
      if (metadata.width === width && metadata.height === partHeight) { image = candidate; break; }
    }
    if (!image) throw new Error(`Export tile dimensions differ at ${top}: expected ${width}x${partHeight}, actual ${actual}, after 3 attempts`);
    inputs.push({ input: image, top, left: 0 });
  }
  await sharp({ create: { width, height, channels: 4, background: "#ffffff" }, limitInputPixels: false }).composite(inputs).png().toFile(output);
  return { width, height, tiles: inputs.length };
}
