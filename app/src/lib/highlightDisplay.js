function displayText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeHighlightForDisplay(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      title: displayText(value.title),
      description: displayText(value.description),
    };
  }

  const text = displayText(value);
  const match = text.match(/^([\s\S]*?)[：:｜|]\s*([\s\S]+)$/);
  return match
    ? { title: match[1].trim(), description: match[2].trim() }
    : { title: text, description: '' };
}

export function normalizeHighlightsForDisplay(items = []) {
  return Array.isArray(items) ? items.map(normalizeHighlightForDisplay) : [];
}
