export const IMAGE_MEDIA_POLICY_VERSION = 1;

// An image filename, gallery page title or our own contact-sheet border does
// not establish that the candidate pixels contain a collage/interface.
export function isNonPhotographicMedia(audit = {}) {
  return ['interface_capture', 'collage', 'graphic'].includes(audit?.mediaType)
    && typeof audit.mediaEvidence === 'string' && Boolean(audit.mediaEvidence.trim());
}
