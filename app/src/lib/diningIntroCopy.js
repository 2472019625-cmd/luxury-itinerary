export const LEGACY_DINING_INTRO_COPY = "精选行程中最具代表性的餐饮与品饮体验，让不同风味、用餐方式与在地场景，共同构成旅途的味觉记忆。";
export const DEFAULT_DINING_INTRO_COPY = "从在地风味到别具一格的用餐场景，品味旅途中的精彩时刻。";

export function displayDiningIntroCopy(value) {
  return !value || value === LEGACY_DINING_INTRO_COPY ? DEFAULT_DINING_INTRO_COPY : value;
}
