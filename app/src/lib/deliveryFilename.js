const MAX_BASE_LENGTH = 64;

export function cleanDeliveryFilenameBase(value) {
  return Array.from(String(value || "")
    .replace(/\.png$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f\uD800-\uDFFF]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.\s_-]+$/g, "")
    .trim())
    .slice(0, MAX_BASE_LENGTH)
    .join("")
    .replace(/[.\s_-]+$/g, "");
}

export function defaultDeliveryFilenameBase(project) {
  const fullTitle = cleanDeliveryFilenameBase(project?.data?.title || project?.title || "客户行程");
  const title = Array.from(fullTitle).slice(0, 36).join("");
  const customer = Array.from(cleanDeliveryFilenameBase(project?.customerName || project?.data?.customerName || "")).slice(0, 12).join("");
  const parts = [title];
  if (customer && !fullTitle.includes(customer)) parts.push(customer);
  parts.push("行程方案");
  return cleanDeliveryFilenameBase(parts.join("_"));
}

export function deliveryDownloadUrl(url, baseName) {
  const base = cleanDeliveryFilenameBase(baseName);
  if (!url || !base) return "";
  const parsed = new URL(url, "http://local.invalid");
  parsed.searchParams.set("downloadName", base);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function deliveryContentDisposition(baseName) {
  const base = cleanDeliveryFilenameBase(baseName) || "客户行程_行程方案";
  return `attachment; filename="itinerary.png"; filename*=UTF-8''${encodeURIComponent(`${base}.png`)}`;
}
