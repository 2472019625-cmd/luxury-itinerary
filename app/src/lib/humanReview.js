export function humanReviewReady(review = {}) {
  return review.aestheticConfirmed === true && review.licenseReviewed === true;
}

export function recordHumanReview(review = {}, key, checked, reviewerId, now = Date.now()) {
  if (!['aestheticConfirmed', 'licenseReviewed'].includes(key)) throw new Error('不支持的人工复核项');
  return { ...review, [key]: checked === true, updatedAt: now, reviewerId };
}
