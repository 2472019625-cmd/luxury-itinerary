const ROOT_FIELDS = new Set([
  'title','subtitle','destination','travelers','adults','children','startDate','endDate','dayCount','heroImage','heroFocus',
  'travelStyle','serviceMode','tripRhythm','hotelReplacementPolicy','transportDisclaimer','sourcePosterHighlights','highlights',
  'highlightsSectionTitle','overviewSectionTitle','showOverviewSection','hotels','hotelSectionTitle','hotelIntroTitle','hotelIntroCopy',
  'diningSectionTitle','diningIntroTitle','diningIntroCopy','diningPolicy','diningExperiences','transportSectionTitle','transportIntroTitle',
  'transportIntroCopy','transportSummary','days','totalPrice','priceUnit','priceNotes','included','excluded','cancellation','includedCustomer','excludedCustomer','cancellationCustomer','notes',
  'notesSectionTitle','notesIntro','showBookingSection','showSecuritySection','showPaymentSection','payment','contact','pendingConfirmations','designer'
]);

const INTERNAL_KEYS = new Set(['audit','terminalAudit','initialAudit','status','adoptable','requiresDecision','hardRejectCode','duplicateOf','candidateId','sha256','dHash','perceptualHash','originalImageUrl','sourceMedia','sourcePage','sourceTitle','sourceUrl','sourceType','officialSource','baseScore','shortlist','humanDecision','libraryEligible','userProvided','licenseNotice','internalPath','verifiedAt','verificationStatus','confirmedByUser','sourceEvidence','usageSegments','verifiedFacts','copyEvidence','sourceImportCoverage','authoritativeFacts']);

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !INTERNAL_KEYS.has(key)).map(([key, item]) => [key, clean(item)]));
}

export function selectCustomerRenderData(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => ROOT_FIELDS.has(key)).map(([key, value]) => [key, clean(value)]));
}
