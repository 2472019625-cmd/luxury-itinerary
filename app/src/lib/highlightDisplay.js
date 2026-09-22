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
  // Only a short leading label can use a legacy em dash as its separator.
  // A dash later in an already separated description must remain body text.
  const dashMatch = text.match(/^([^，。；！？,;!?\r\n：:｜|—]{1,12})\s*——\s*(\S[\s\S]*)$/);
  if (dashMatch) return { title: dashMatch[1].trim(), description: dashMatch[2].trim() };
  const match = text.match(/^([\s\S]*?)[：:｜|]\s*([\s\S]+)$/);
  return match
    ? { title: match[1].trim(), description: match[2].trim() }
    : { title: text, description: '' };
}

export function normalizeHighlightsForDisplay(items = []) {
  return Array.isArray(items) ? items.map(normalizeHighlightForDisplay) : [];
}

export function highlightToText(value) {
  const { title, description } = normalizeHighlightForDisplay(value);
  return [title, description].filter(Boolean).join('：');
}
