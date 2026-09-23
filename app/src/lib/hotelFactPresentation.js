export const STRUCTURED_HOTEL_FACT_FORMAT = "fact_rows_v1";
const HOTEL_FACT_KEYS = new Set(["location", "rooms", "design", "facilities"]);

export function hotelFactPresentation(hotel = {}) {
  const hasLegacyCopy = Boolean(String(hotel.editorialCopy || "").trim()) ||
    (Array.isArray(hotel.proofPoints) && hotel.proofPoints.some((point) => String(point || "").trim()));
  const hasStructuredRows = Array.isArray(hotel.factRows) &&
    hotel.factRows.some((row) => HOTEL_FACT_KEYS.has(row?.key));
  const structured = hotel.hotelFactFormat === STRUCTURED_HOTEL_FACT_FORMAT ||
    hasStructuredRows || (Array.isArray(hotel.factRows) && !hasLegacyCopy);
  return {
    structured,
    rows: structured && Array.isArray(hotel.factRows) ? hotel.factRows.filter((row) => String(row?.text || "").trim()) : [],
    showLegacy: !structured,
  };
}
