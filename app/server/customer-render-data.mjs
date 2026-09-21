import { dayVisualCards } from '../src/lib/dayVisualCards.js';
import { buildCustomerTravelEntityData } from '../src/lib/travelEntityDisplay.js';
import { normalizeHighlightsForDisplay } from '../src/lib/highlightDisplay.js';

const ROOT_FIELDS = new Set([
  'title','subtitle','destination','travelers','adults','children','startDate','endDate','dayCount','heroImage','heroFocus',
  'travelStyle','serviceMode','tripRhythm','hotelReplacementPolicy','transportDisclaimer','sourcePosterHighlights','highlights',
  'highlightsSectionTitle','overviewSectionTitle','showOverviewSection','hotels','hotelSectionTitle','hotelIntroTitle','hotelIntroCopy',
  'diningSectionTitle','diningIntroTitle','diningIntroCopy','diningPolicy','diningExperiences','transportSectionTitle','transportIntroTitle',
  'transportIntroCopy','transportSummary','days','totalPrice','priceUnit','priceNotes','included','excluded','cancellation','includedCustomer','excludedCustomer','cancellationCustomer','notes',
  'notesSectionTitle','notesIntro','showBookingSection','showSecuritySection','showPaymentSection','payment','contact','pendingConfirmations','designer','locale'
]);

const INTERNAL_KEYS = new Set(['audit','terminalAudit','initialAudit','status','adoptable','requiresDecision','hardRejectCode','duplicateOf','candidateId','sha256','dHash','perceptualHash','originalImageUrl','sourceMedia','sourcePage','sourceTitle','sourceUrl','sourceType','sourceClass','sourceExcerpt','checkedAt','officialSource','baseScore','shortlist','humanDecision','libraryEligible','userProvided','licenseNotice','internalPath','verifiedAt','verificationStatus','confirmedByUser','sourceEvidence','usageSegments','verifiedFacts','copyEvidence','sourceImportCoverage','authoritativeFacts','entityDisplayIssues']);

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !INTERNAL_KEYS.has(key)).map(([key, item]) => [key, clean(item)]));
}

export function selectCustomerRenderData(data = {}, { locale = data?.locale || 'zh-CN' } = {}) {
  const displayData = buildCustomerTravelEntityData(data, { locale });
  const result = Object.fromEntries(Object.entries(displayData).filter(([key]) => ROOT_FIELDS.has(key)).map(([key, value]) => [key, clean(value)]));
  result.hotels = (result.hotels || []).map((hotel) => ({
    ...hotel,
    ...(Array.isArray(hotel.factRows) ? { factRows: hotel.factRows.filter((row) => String(row?.text || '').trim()) } : {}),
  }));
  result.highlights = normalizeHighlightsForDisplay(result.highlights);
  if (displayData.simpleImageSlotBindings) result.days = (displayData.days || []).map((day, index) => ({ ...result.days[index], spots: dayVisualCards(day, index, displayData.simpleImageSlotBindings).map(({ spot }) => clean(spot)) }));
  return result;
}
