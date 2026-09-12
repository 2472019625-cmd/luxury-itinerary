import test from "node:test";
import assert from "node:assert/strict";
import { deriveProjectThumbnail } from "../src/lib/projectThumbnail.js";

const baseData = () => ({
  destination: "肯尼亚",
  hotels: [{ id: "hotel-1", images: [{ src: "/image-assets/hotel.jpg" }] }],
  diningExperiences: [{ id: "dining-1", images: [{ src: "/image-assets/dining.jpg" }] }],
  transportSummary: [],
  days: [{ id: "day-1", description: "全天游猎体验", spots: [{ id: "spot-1", name: "草原游猎", images: [{ src: "/image-assets/day.jpg" }] }] }],
});

test("homepage thumbnail prefers the adopted cover image", () => {
  const data = { ...baseData(), heroImage: "/image-assets/cover.jpg" };
  assert.deepEqual(deriveProjectThumbnail({ data }), { thumbnailUrl: "/image-assets/cover.jpg", thumbnailSource: "cover" });
});

test("homepage thumbnail falls back from day primary to hotel primary", () => {
  const data = baseData();
  assert.deepEqual(deriveProjectThumbnail({ data }), { thumbnailUrl: "/image-assets/day.jpg", thumbnailSource: "project_fallback" });
  data.days[0].spots[0].images = [];
  assert.deepEqual(deriveProjectThumbnail({ data }), { thumbnailUrl: "/image-assets/hotel.jpg", thumbnailSource: "project_fallback" });
});

test("homepage thumbnail uses the destination placeholder when no adopted image exists", () => {
  const data = { destination: "肯尼亚", hotels: [], diningExperiences: [], transportSummary: [], days: [] };
  assert.deepEqual(deriveProjectThumbnail({ data }), { thumbnailUrl: "", thumbnailSource: "destination_placeholder" });
});

test("derived fallback never writes into the cover slot", () => {
  const data = baseData();
  deriveProjectThumbnail({ data });
  assert.equal(data.heroImage, undefined);
});
