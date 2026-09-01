const DINING_TYPES = [
  { key: "bush-breakfast", pattern: /丛林早餐|荒野早餐|bush\s*breakfast/i },
  { key: "sundowner", pattern: /落日酒会|日落酒会|sundowner/i },
  { key: "starlit-dinner", pattern: /星空晚宴|星空晚餐|星空用餐|starlit|starry\s*(?:night\s*)?dinner/i },
  { key: "wine", pattern: /私人酒窖|酒窖品酒|品酒体验|wine\s*(?:cellar|tasting)/i },
  { key: "boma", pattern: /boma|篝火晚宴|篝火晚餐/i },
  { key: "carnivore", pattern: /the\s*carnivore|特色烤肉|烤肉晚餐/i },
  { key: "private-dining", pattern: /私人晚宴|私享晚宴|private\s*dining|private\s*dinner/i },
  { key: "picnic", pattern: /草原野餐|荒野野餐|bush\s*picnic/i },
];

function sourceText(data) {
  return (data.days || []).flatMap((day) => [
    day.theme,
    day.description,
    day.mealPlan?.breakfast,
    day.mealPlan?.lunch,
    day.mealPlan?.dinner,
    ...(day.spots || []).flatMap((spot) => [spot.name, spot.description, spot.experience]),
  ]).filter(Boolean).join(" ");
}

export function filterDiningExperiences(data, experiences) {
  if (!Array.isArray(experiences)) return [];
  const source = sourceText(data);
  const allowed = new Set(DINING_TYPES.filter((type) => type.pattern.test(source)).map((type) => type.key));
  if (!allowed.size) return [];
  return experiences.filter((item) => {
    const candidate = [item?.title, item?.officialName, item?.editorialCopy, item?.location].filter(Boolean).join(" ");
    return DINING_TYPES.some((type) => allowed.has(type.key) && type.pattern.test(candidate));
  });
}
