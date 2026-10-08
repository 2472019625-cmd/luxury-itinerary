export const EDITABLE_MODULE_VISIBILITY = new Set(['highlights', 'overview', 'hotels', 'dining', 'transport', 'expenses', 'booking', 'security', 'notes']);

export function applyModuleVisibility(data, visibility = {}) {
  const next = structuredClone(data);
  if (visibility.highlights === false) next.highlights = [];
  if (visibility.overview === false) next.showOverviewSection = false;
  if (visibility.hotels === false) next.hotels = [];
  if (visibility.dining === false) next.diningExperiences = [];
  if (visibility.transport === false) next.transportSummary = [];
  if (visibility.expenses === false) { next.totalPrice = null; next.included = []; next.excluded = []; next.cancellation = []; }
  if (visibility.booking === false) next.showBookingSection = false;
  if (visibility.security === false) next.showSecuritySection = false;
  if (visibility.notes === false) { next.notes = []; next.showNotesSection = false; }
  return next;
}
