import sharp from "sharp";

async function differenceHash(filePath) {
  const { data } = await sharp(filePath).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function hamming(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

export class ImageDeduper {
  constructor({ perceptualThreshold = 8 } = {}) { this.sha = new Set(); this.perceptual = []; this.threshold = perceptualThreshold; }
  seed(records = []) {
    for (const item of records) {
      if (item?.sha256) this.sha.add(item.sha256);
      if (item?.dHash || item?.perceptualHash) this.perceptual.push({ dHash: item.dHash || item.perceptualHash, publicUrl: item.src || item.publicUrl || item.slotId || "existing-image" });
    }
  }
  async accept(candidate) {
    if (this.sha.has(candidate.sha256)) return { accepted: false, reason: "exact-duplicate" };
    const dHash = await differenceHash(candidate.filePath);
    const similar = this.perceptual.find((item) => hamming(dHash, item.dHash) <= this.threshold);
    if (similar) return { accepted: false, reason: "visual-duplicate", duplicateOf: similar.publicUrl, dHash };
    this.sha.add(candidate.sha256);
    this.perceptual.push({ dHash, publicUrl: candidate.publicUrl });
    return { accepted: true, dHash };
  }
}
