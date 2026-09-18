import { canonicalImageAssetKey } from './page-images.mjs';

export function webImageAssetKey(url) {
  return canonicalImageAssetKey(resourceUrl(url)).replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)(?:\?|$))/i, '');
}
export function resourceUrl(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const url = new URL(current);
      const nested = [...url.searchParams.values()].find(v => /^https?:\/\//i.test(v));
      if (!nested) break;
      current = nested;
    } catch { break; }
  }
  return current;
}
export function webResourceFilterReason(candidate) {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(resourceUrl(candidate.imageUrl)).pathname); } catch { /* invalid URLs are handled by download security */ }
  if (/\.(?:woff2?|ttf|otf|eot|css|js|pdf|html?)(?:$|[?#])/i.test(pathname)) return 'non_image_resource';
  if (candidate.resourceRole === 'ui') return 'ui_resource';
  const signature = `${pathname} ${candidate.alt || ''} ${candidate.htmlSignature || ''}`;
  if (/(?:^|[\s/_.-])(?:logos?|icons?|favicon|placeholders?|404|patterns?\d*|sprite|badges?|whatsapp|social-icon|tracking-pixel)(?:$|[\s/_.-])/i.test(signature)) return 'decorative_resource';
  if (/(?:web|site|brand|company|header|footer)[_-]?logo/i.test(signature)
    || /\/(?:facebook|instagram|twitter|linkedin|pinterest)(?:[-_]icon)?\.(?:png|jpe?g|webp)$/i.test(pathname)) return 'decorative_resource';
  if (/\.(?:svg|ico)(?:$|[?#])/i.test(candidate.imageUrl || '')) return 'ui_resource_format';
  return null;
}

// Missing lexical support is uncertainty, never a demonstrated visual conflict.
const grammar = new Set('a an the of on in at to from with by for and or under over near as is are being be it its this that photo photos image images photography'.split(' '));
const terms = value => [...new Set(String(value || '').toLowerCase().normalize('NFKC').split(/[^a-z0-9\u4e00-\u9fff]+/u).filter(t => t.length >= 3 && !grammar.has(t)).map(t => t.replace(/(?:ing|ed|s)$/,'').replace(/(.)\1$/,'$1')))];
function matchTerms(values, evidence) {
  const words = terms(evidence);
  const alternatives = values.filter(Boolean).map(terms).filter(v => v.length);
  const matches = alternatives.map(v => v.filter(t => words.some(w => w === t || (/[\u4e00-\u9fff]/u.test(t) && (w.includes(t) || t.includes(w))))));
  return { matched: matches.some(v => v.length), matches: [...new Set(matches.flat())] };
}
export function imageRelevanceDecision(candidate, slot) {
  const core = slot.queryCore || {};
  const proof = slot.minimumVisualProof || {};
  let resourcePath = '';
  try { resourcePath = decodeURIComponent(new URL(resourceUrl(candidate.imageUrl)).pathname); } catch {}
  const own = [resourcePath, candidate.alt, candidate.imageTitle, candidate.caption, candidate.structuredImageText].filter(Boolean).join(' | ');
  const local = [own, candidate.localContext].filter(Boolean).join(' | ');
  const subject = matchTerms([proof.subject, core.subject, core.subjectEn], local);
  const actionValues = [proof.action, core.action, core.actionEn].filter(Boolean);
  const action = matchTerms(actionValues, local);
  const hotel = slot.moduleType === 'hotel';
  const identities = [hotel && slot.hotel, slot.entityName, ...(slot.identityAnchors || []), core.identity, core.identityEn].filter(Boolean);
  const identityAlternatives = identities.map(v => terms(v)).filter(v => v.length);
  const identity = identityAlternatives.some(words => {
    const localWords = terms(`${local} ${candidate.entitySectionText || ''} ${candidate.entityPagePath || ''}`);
    return words.every(t => localWords.some(w => w === t || (/[\u4e00-\u9fff]/u.test(t) && w.includes(t))));
  });
  const identityCore = slot.exactIdentityRequired === true;
  // A publisher-declared image identity can prove a conflict. Arbitrary names
  // in page text, and failure to match words, cannot establish one.
  const targetIdentity = (hotel && slot.hotel) || slot.entityName;
  const normalize = value => terms(value).sort().join('|');
  const declaredIdentityConflict = identityCore && targetIdentity && candidate.depictedIdentity
    && normalize(candidate.depictedIdentity) !== normalize(targetIdentity);
  const explicitText = [candidate.alt, candidate.caption, candidate.structuredImageText].filter(Boolean).join(' ').toLowerCase();
  const negatedCore = [...terms(core.subjectEn), ...terms(core.actionEn)].some(t => new RegExp(`\\b(?:no|not|without)\\s+${t}\\b`, 'i').test(explicitText));
  const state = declaredIdentityConflict || negatedCore ? 'explicit_mismatch'
    : (!identityCore || identity) && (subject.matched || (hotel && identity)) && (!actionValues.length || action.matched) ? 'strong_match' : 'insufficient_evidence';
  const pass = state !== 'explicit_mismatch';
  return { pass, state, status: pass ? 'pending_visual_confirmation' : 'filtered_before_download',
    reason: declaredIdentityConflict ? 'declared_image_identity_conflict' : negatedCore ? 'explicit_core_negation' : state === 'strong_match' ? 'local_core_evidence' : 'local_evidence_insufficient_not_mismatch',
    rankBoost: (state === 'strong_match' ? 100 : 0) + subject.matches.length * 12 + action.matches.length * 10 + (identity ? 25 : 0),
    resourcePath,
    subjectMatches: subject.matches, actionMatches: action.matches, identitySupported: identity,
    evidence: local.slice(0, 1400), evidenceSemantics: 'local_text_only_not_visual_judgment' };
}
export function gateWebCandidates(candidates, slot) {
  const decisions = candidates.map(candidate => ({ candidate, decision: imageRelevanceDecision(candidate, slot) }));
  return { counts: Object.fromEntries(['strong_match','explicit_mismatch','insufficient_evidence'].map(state => [state, decisions.filter(x=>x.decision.state===state).length])),
    candidates: decisions.filter(x => x.decision.pass).map(x => ({...x.candidate, downloadRelevance: x.decision})),
    filtered: decisions.filter(x => !x.decision.pass).map(x => ({ imageUrl: x.candidate.imageUrl, pageUrl: x.candidate.pageUrl, ...x.decision })) };
}
function quality(candidate) {
  let url;
  try { url = new URL(candidate.imageUrl); } catch { return 0; }
  const resize = url.pathname.match(/-(\d{2,5})x(\d{2,5})(?=\.(?:jpe?g|png|webp)$)/i);
  const width = Number(url.searchParams.get('w') || url.searchParams.get('width') || url.searchParams.get('imwidth') || url.searchParams.get('wid') || resize?.[1] || candidate.width || 0);
  return width || 1e6; // Original version ahead of explicitly resized versions.
}
export function prepareWebCandidates(candidates) {
  const groups = new Map(), filtered = [];
  for (const candidate of candidates) {
    if (!candidate?.imageUrl) continue;
    const reason = webResourceFilterReason(candidate);
    if (reason) { filtered.push({ imageUrl: candidate.imageUrl, pageUrl: candidate.pageUrl, status: 'filtered', reason }); continue; }
    const key = webImageAssetKey(candidate.imageUrl), old = groups.get(key);
    if (!old || quality(candidate) > quality(old)) {
      if (old) filtered.push({ imageUrl: old.imageUrl, status: 'filtered', reason: 'resize_duplicate', retainedUrl: candidate.imageUrl });
      groups.set(key, candidate);
    } else filtered.push({ imageUrl: candidate.imageUrl, status: 'filtered', reason: 'resize_duplicate', retainedUrl: old.imageUrl });
  }
  const positionScore = (candidate) => candidate.pagePosition === 'content' ? 2 : candidate.pagePosition === 'chrome' ? -2 : 0;
  return { candidates: [...groups.values()].sort((a,b) => positionScore(b)-positionScore(a)), filtered, before: candidates.length, after: groups.size };
}
