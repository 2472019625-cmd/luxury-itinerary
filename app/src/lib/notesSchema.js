export const NOTES_SCHEMA_VERSION = 'COPY-013-notes-v1';

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function isValidNotesGroup(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && clean(value.title)
    && Array.isArray(value.items)
    && value.items.length > 0
    && value.items.every((item) => typeof item === 'string' && clean(item))
    && (!value.tone || typeof value.tone === 'string')
  );
}

export function validateNotesSchema(notes) {
  const errors = [];
  if (!Array.isArray(notes)) return { valid: false, errors: ['注意事项必须是分组对象数组'] };
  notes.forEach((item, index) => {
    if (typeof item === 'string') errors.push(`注意事项第${index + 1}项仍是字符串，缺少分类标题和条目数组`);
    else if (!item || typeof item !== 'object' || Array.isArray(item)) errors.push(`注意事项第${index + 1}项不是合法对象`);
    else {
      if (!clean(item.title)) errors.push(`注意事项第${index + 1}项缺少分类标题`);
      if (!Array.isArray(item.items) || !item.items.length) errors.push(`注意事项第${index + 1}项缺少非空条目数组`);
      else if (item.items.some((entry) => typeof entry !== 'string' || !clean(entry))) errors.push(`注意事项第${index + 1}项包含非法条目`);
      if (item.tone != null && typeof item.tone !== 'string') errors.push(`注意事项第${index + 1}项tone必须是字符串`);
    }
  });
  return { valid: errors.length === 0, errors };
}

export function normalizeLegacyNotesForDisplay(notes) {
  if (!Array.isArray(notes)) return [];
  const strings = notes.filter((item) => typeof item === 'string').map(clean).filter(Boolean);
  const groups = notes.filter((item) => isValidNotesGroup(item)).map((item) => ({
    ...item,
    title: clean(item.title),
    items: item.items.map(clean).filter(Boolean),
    tone: clean(item.tone) || 'gold',
  }));
  if (strings.length) groups.unshift({
    title: '历史注意事项（待复核）',
    items: strings,
    tone: 'warning',
    legacyConverted: true,
  });
  return groups;
}

