import { visualSubjectPolicyIssue } from "./visual-subject-policy.mjs";

const choice = /或者|或|二选一|\bor\b|\//i;
const clean = value => typeof value === "string" ? value.trim() : "";
const compact = value => clean(value).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const words = value => [...segmenter.segment(clean(value).normalize("NFKC").toLowerCase())]
  .filter(part => part.isWordLike).map(part => part.segment);

function containsCoreWords(value, corePart) {
  const expected = words(corePart), actual = words(value);
  let cursor = -1;
  return expected.length > 0 && expected.every(word => {
    cursor = actual.indexOf(word, cursor + 1);
    return cursor >= 0;
  });
}

export function coreEnglishQueriesSupported(slot) {
  const englishWords = value => words(value).filter(word => !['a', 'an', 'the', 'and', 'with', 'on', 'in', 'at', 'of', 'through'].includes(word));
  const queries = [slot.fidelityQuery, ...(slot.alternateQueries || [])].map(clean);
  return [slot.queryCore?.subjectEn, slot.queryCore?.actionEn].map(clean).filter(Boolean).every(part =>
    queries.some(query => englishWords(part).every(word => words(query).includes(word))));
}

// Explicit examples name a category already chosen by the Planner. This is
// syntax recovery, not an animal/entity alias table or a choice of a branch.
export function resolveExamplePreference(slot) {
  const core = slot.queryCore || {};
  const values = [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn].map(clean);
  if (slot.userLocked || slot.exactIdentityRequired !== false || slot.locationRole !== 'scope_only'
    || !values[0] || values.some(value => choice.test(value))) return null;
  // Do not guess whether conflicting bilingual fields mean the same thing.
  // Require the saved queries to carry the complete English subject/action.
  if (!coreEnglishQueriesSupported(slot)) return null;
  const visual = clean(slot.primaryVisualSubject);
  for (const match of visual.matchAll(/(?:可见|例如|比如|如)([^，,；;。!?！？]{1,60})等([\p{L}]{2,16})/gu)) {
    const alternatives = match[1].split(choice).map(clean);
    const category = match[2];
    if (alternatives.length < 2 || alternatives.length > 3 || alternatives.some(v => !v || v.length > 30)
      || !compact(values[0]).includes(compact(category))) continue;
    const remaining = visual.slice(0, match.index) + category + visual.slice(match.index + match[0].length);
    const subjectWords = words(values[0]).filter(word => !['的', '与', '和'].includes(word));
    const subjectPreserved = subjectWords.length > 0 && subjectWords.every(word =>
      compact(remaining).replace(/式(?=[\p{L}])/gu, '').includes(compact(word)));
    if (choice.test(remaining) || !subjectPreserved || visualSubjectPolicyIssue(remaining, core)
      || values[1] && !compact(remaining).includes(compact(values[1]))) continue;
    return { reason: 'non_core_example_choice', primaryVisualSubject: [values[0], values[1]].filter(Boolean).join(' '),
      examplePreference: match[0], exampleAlternatives: alternatives };
  }
  return null;
}

// A bounded grammar for ordinary spaces of the SAME hotel. Qualifiers such as
// private/booked room types, actions and named facilities deliberately fail.
export function ordinaryHotelSpaceCategory(value) {
  const chinese = /^(?:(?:酒店|营地|度假村|公共|普通|标准|户外|室内|开放式|的)\s*)*(建筑外观|外观|建筑|套房|客房|房间|帐篷|游泳池|泳池|大堂|公共空间|公共区域|公共休息区|休息区|庭院|花园|甲板|露台)(?:内部|室内|空间|场景|露台|甲板)?$/u;
  const english = /^(?:(?:hotel|camp|resort|public|ordinary|standard|outdoor|indoor|open)\s+)*(building exterior|exterior|building|suite|guest room|room|tent|swimming pool|pool|lobby|public space|public area|public lounge|lounge|courtyard|garden|deck|terrace)(?:\s+(?:interior|inside|space|terrace|deck))?$/i;
  const head = chinese.exec(clean(value))?.[1] || english.exec(clean(value))?.[1];
  if (!head) return null;
  if (/外观|建筑|exterior|building/i.test(head)) return 'exterior';
  if (/套房|客房|房间|帐篷|suite|room|tent/i.test(head)) return 'suite';
  if (/泳池|pool/i.test(head)) return 'pool';
  return 'main_areas';
}

export function ordinaryHotelRepresentativeHeader(visual) {
  return /^(?:(?:酒店)?代表(?:性)?空间|酒店公共(?:空间|区域))\s*[，,]/.exec(clean(visual));
}

export function ordinaryHotelRepresentativeDetails(visual) {
  // The explicit representative-space header marks the following clause as
  // presentation detail. Every choice must still end in an ordinary space;
  // callers enforce identity, source, promises and private-facility exclusions.
  const header = ordinaryHotelRepresentativeHeader(visual);
  if (!header) return false;
  const alternatives = clean(visual).slice(header[0].length).split(choice).map(clean);
  if (alternatives.length < 2 || alternatives.length > 4) return false;
  return alternatives.every(part => [...part].some((_, index) => ordinaryHotelSpaceCategory(part.slice(index))));
}

// Both automatic and explicit searches reconstruct the already chosen Core. A
// location phrase may interrupt the Chinese action, so check the complete Core
// again AFTER removing that phrase. Never pick an alternative subject/action.
export function resolveScenePreference(slot) {
  const core = slot.queryCore || {};
  const values = [core.subject, core.action, core.identity, core.subjectEn, core.actionEn, core.identityEn].map(clean);
  if (slot.exactIdentityRequired !== false || slot.locationRole !== "scope_only"
    || !values[0] || values.some(value => choice.test(value))) return null;
  const visual = clean(slot.primaryVisualSubject);
  const languages = [{ subject: values[0], action: values[1] },
    ...(values[3] && (!values[1] || values[4]) ? [{ subject: values[3], action: values[4] }] : [])];
  const preservesCore = remaining => !choice.test(remaining) && !visualSubjectPolicyIssue(remaining, core)
    && languages.some(({ subject, action }) => containsCoreWords(remaining, subject)
      && (!action || compact(remaining).includes(compact(action)) || containsCoreWords(remaining, action)));
  const validAlternatives = text => {
    const alternatives = text.split(choice).map(clean);
    return alternatives.length >= 2 && alternatives.length <= 3
      && alternatives.every(part => part && part.length <= 30 && !/[，,；;。!?！？]/.test(part));
  };
  for (const marker of [...visual.matchAll(/背景(?:为|是|可为)|位于|在|\b(?:against|in|on|at)\s+/gi)].reverse()) {
    const start = marker.index, bodyStart = start + marker[0].length;
    const tail = visual.slice(bodyStart);
    const ends = [...new Set([
      visual.length,
      ...languages.flatMap(({ subject, action }) => [subject, action].filter(Boolean)).flatMap(part => {
        const at = visual.toLowerCase().indexOf(part.toLowerCase(), bodyStart);
        return at >= 0 ? [at] : [];
      }),
      ...[...tail.matchAll(/[，,；;。]/g)].map(match => bodyStart + match.index),
      ...[...tail.matchAll(/[上中内旁边里外下]/g)].map(match => bodyStart + match.index + 1),
    ])].sort((a, b) => a - b);
    for (const end of ends) {
      const background = visual.slice(bodyStart, end).trim();
      if (!validAlternatives(background)) continue;
      const remaining = `${visual.slice(0, start)}${visual.slice(end)}`.trim();
      if (!preservesCore(remaining)) continue;
      return { reason: "non_core_background_choice", backgroundPreference: background,
        primaryVisualSubject: [values[0], values[1]].filter(Boolean).join(" ") };
    }
  }
  // A separate supporting clause can offer choices (e.g. passengers boarding
  // or disembarking) while the complete plane/runway Core precedes it. Remove
  // the whole preference, never select a branch or remove part of the Core.
  // A leading "or" is a whole-scene alternative and deliberately fails.
  for (const marker of visual.matchAll(/[，,]/g)) {
    const remaining = visual.slice(0, marker.index).trim();
    const detail = visual.slice(marker.index + 1).trim();
    if (!preservesCore(remaining) || !validAlternatives(detail) || visualSubjectPolicyIssue(detail, core)) continue;
    const coreSubjectInDetail = [values[0], values[3]].filter(Boolean).some(subject => containsCoreWords(detail, subject));
    if (coreSubjectInDetail) continue;
    return { reason: "non_core_supporting_choice", supportingPreference: detail,
      primaryVisualSubject: [values[0], values[1]].filter(Boolean).join(" ") };
  }
  return null;
}

