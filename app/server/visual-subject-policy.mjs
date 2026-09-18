const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const SEPARATE_MOMENT = /(?:^|[，,；;。\s])(?:随后|之后|然后|接着|另(?:外|行)|分别|再(?:去|前往|转往|转到|进入|体验)|then\b|afterwards\b|separately\b)/i;
const FIRST_THEN = /(?:先|first).{1,40}(?:再|随后|然后|then).{1,40}/i;

function hasMultipleSentenceMoments(value) {
  const clauses = clean(value).split(/[；;。]+/).map((item) => item.trim()).filter(Boolean);
  return clauses.length > 1;
}

export function visualSubjectPolicyIssue(value, queryCore = {}) {
  const fields = [value, queryCore?.subject, queryCore?.action].map(clean).filter(Boolean);
  if (!fields.length) return null;
  if (fields.some((field) => hasMultipleSentenceMoments(field) || SEPARATE_MOMENT.test(field) || FIRST_THEN.test(field))) {
    return { code: "separate_visual_moments", message: "包含明确先后或分开的多个画面时刻" };
  }
  return null;
}
