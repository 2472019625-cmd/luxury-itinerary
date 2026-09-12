import { listImagePlacements } from "./imageSlots.js";

const imageSource = (value) => typeof value === "string" ? value : String(value?.src || "");

export function deriveProjectThumbnail(project = {}, currentData = project.data || {}) {
  const cover = imageSource(currentData.heroImage)
    || imageSource(project.thumbnailUrl)
    || imageSource(currentData.heroThumbnail);
  if (cover) return { thumbnailUrl: cover, thumbnailSource: "cover" };

  const placements = listImagePlacements(currentData);
  const dayPrimary = placements.find(({ slot, image }) => slot.module === "day" && slot.imageIndex === 0 && imageSource(image));
  const hotelPrimary = placements.find(({ slot, image }) => slot.module === "hotel" && slot.imageIndex === 0 && imageSource(image));
  const other = placements.find(({ slot, image }) => slot.module !== "cover"
    && !(slot.module === "day" && slot.imageIndex === 0)
    && !(slot.module === "hotel" && slot.imageIndex === 0)
    && imageSource(image));
  const fallback = dayPrimary || hotelPrimary || other;

  return fallback
    ? { thumbnailUrl: imageSource(fallback.image), thumbnailSource: "project_fallback" }
    : { thumbnailUrl: "", thumbnailSource: "destination_placeholder" };
}
