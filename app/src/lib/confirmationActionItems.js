const clean = (value) => String(value ?? "").trim();

function dateNumber(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Number(`${match[1]}${match[2]}${match[3]}`);
}

function offerRange(period, fallbackYear) {
  const matches = [...clean(period).matchAll(/(\d{4})[.\/年-](\d{1,2})[.\/月-](\d{1,2})日?/g)];
  if (matches.length >= 2) {
    const numbers = matches.slice(0, 2).map((match) => Number(`${match[1]}${String(match[2]).padStart(2, "0")}${String(match[3]).padStart(2, "0")}`));
    return { start: Math.min(...numbers), end: Math.max(...numbers) };
  }
  if (!fallbackYear) return null;
  const shortMatches = [...clean(period).matchAll(/(?:^|[^\d])(\d{1,2})[.\/月-](\d{1,2})日?(?=$|[^\d])/g)];
  if (shortMatches.length < 2) return null;
  const [first, second] = shortMatches.slice(0, 2).map((match) => Number(`${String(match[1]).padStart(2, "0")}${String(match[2]).padStart(2, "0")}`));
  const start = Number(`${fallbackYear}${String(first).padStart(4, "0")}`);
  const endYear = second < first ? fallbackYear + 1 : fallbackYear;
  return { start, end: Number(`${endYear}${String(second).padStart(4, "0")}`) };
}

export function priceOfferKey(offer = {}) {
  return `${clean(offer.period)}|${Number(offer.amount) || ""}`;
}

export function listPriceOffers(data = {}) {
  const offers = Array.isArray(data.sourceImportCoverage?.priceOffers) ? data.sourceImportCoverage.priceOffers : [];
  return [...new Map(offers.filter((offer) => Number(offer?.amount) > 0).map((offer) => [priceOfferKey(offer), offer])).values()];
}

export function matchingPriceOffers(startDate, offers = []) {
  const departure = dateNumber(startDate);
  if (departure == null) return [];
  const departureYear = Math.floor(departure / 10000);
  return offers.filter((offer) => {
    const range = offerRange(offer.period, departureYear);
    return range && departure >= range.start && departure <= range.end;
  });
}

export function currentPriceSelection(project = {}) {
  return project.confirmationSelections?.priceOffer || null;
}

export function isChildCountConfirmed(project = {}, data = project.data || {}) {
  const value = data.children;
  if (value === "" || value == null || !Number.isInteger(Number(value)) || Number(value) < 0) return false;
  if (Number(value) > 0) return true;
  return project.confirmationSelections?.childrenConfirmed === true
    || data.sourceImportCoverage?.travelerCounts?.childrenExplicit === true;
}

export function isPriceSelectionValid(project = {}, data = project.data || {}) {
  const offers = listPriceOffers(data);
  if (offers.length < 2) return true;
  const selection = currentPriceSelection(project);
  if (!selection || !(Number(selection.amount) > 0)) return false;
  if (selection.mode === "custom") return Boolean(clean(selection.unit));
  return offers.some((offer) => priceOfferKey(offer) === selection.sourceKey);
}

function multiPriceState(project = {}, data = {}, warnings = []) {
  const offers = listPriceOffers(data);
  const warning = warnings.map(clean).find((item) => /(?:不同档期价格|多档价格|价格档期)/.test(item));
  const warningCount = Number(warning?.match(/(\d+)\s*个(?:不同)?档期价格/)?.[1] || 0);
  const count = Math.max(offers.length, warningCount);
  if (count < 2) return { required: false, count: 0 };
  const matchingOffers = matchingPriceOffers(data.startDate, offers);
  return { required: !isPriceSelectionValid(project, data), count, hasDeparture: dateNumber(data.startDate) != null, matchingOffers };
}

function issueTitle(issue = {}) {
  if (String(issue.path || "").startsWith("hotels.")) return "住宿信息";
  if (String(issue.path || "").startsWith("transportSummary.")) return "交通信息";
  if (String(issue.path || "").startsWith("notes.")) return "注意事项";
  return "行程信息";
}

export function buildConfirmationActionItems({ project = {}, data = project.data || {}, validation = {}, confirmations = [], decisions = {} } = {}) {
  const items = [];
  const add = (item) => {
    if (!items.some((current) => current.id === item.id)) items.push(item);
  };

  if (!clean(data.destination)) add({ id: "field:destination", title: "目的地", description: "请确认本次行程的目的地。", path: "destination" });
  if (!clean(project.title || data.title)) add({ id: "field:title", title: "项目名称", description: "请填写便于识别的项目名称。", path: "title" });
  if (!clean(project.customerName || data.customerName)) add({ id: "field:customerName", title: "客户称呼", description: "请填写本次客户的称呼。", path: "customerName" });
  if (!clean(data.startDate)) add({ id: "field:startDate", title: "出发日期", description: "请填写本次客户的出发日期。", path: "startDate" });
  if (!clean(data.endDate)) add({ id: "field:endDate", title: "返程日期", description: "请填写本次客户的返程日期。", path: "endDate" });
  const adultCount = Number(data.adults ?? data.travelers);
  if (!Number.isInteger(adultCount) || adultCount < 1) add({ id: "field:adults", title: "成人数量", description: "请确认本次出行的成人数量。", path: "adults" });
  if (!isChildCountConfirmed(project, data)) add({ id: "field:children", title: "儿童人数", description: "请确认本次出行的儿童数量，没有儿童请填写 0。", path: "children" });

  const ignoredIssueCodes = new Set(["dates_missing", "travelers_missing"]);
  for (const issue of [...(validation.issues || [])]) {
    if (ignoredIssueCodes.has(issue.code) || issue.classification === "warning") continue;
    add({ id: `validation:${issue.code}:${issue.path || "general"}`, title: issueTitle(issue), description: clean(issue.message), path: issue.path || "" });
  }

  const price = multiPriceState(project, data, Array.isArray(project.recognition?.warnings) ? project.recognition.warnings : []);
  if (price.required) {
    const selection = currentPriceSelection(project);
    if (selection?.mode === "custom" && !(Number(selection.amount) > 0)) add({ id: "source:multiPricePeriod", title: "本次采用金额", description: "请填写本次采用金额。", path: "sourceImportCoverage.priceOffers" });
    else if (selection?.mode === "custom" && !clean(selection.unit)) add({ id: "source:multiPricePeriod", title: "计价单位", description: "请填写本次报价的计价单位。", path: "sourceImportCoverage.priceOffers" });
    else add({ id: "source:multiPricePeriod", title: "价格档期", description: price.hasDeparture && price.matchingOffers.length !== 1 ? "当前出发日期未能唯一对应原报价，请选择或自定义本次客户报价。" : `原报价包含 ${price.count} 个价格档期，请选择本次客户采用的报价。`, path: "sourceImportCoverage.priceOffers" });
  }

  for (const confirmation of confirmations.filter((item) => item.status === "pending")) {
    if (decisions?.[confirmation.confirmationId]) continue;
    add({ id: `confirmation:${confirmation.confirmationId}`, title: clean(confirmation.question) || "生成前确认", description: clean(confirmation.reason) || "请确认后继续。", confirmationId: confirmation.confirmationId });
  }
  return items;
}
