const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function transportUsageLabel(item = {}) {
  if (clean(item.usageLabel)) return clean(item.usageLabel);
  const identity = `${item.category || ''} ${item.serviceLevel || ''} ${item.model || ''}`;
  if (/飞机|航班|航空/.test(identity)) return '境内轻型航空衔接';
  if (/越野|游猎|4x4/i.test(identity)) return '园区与保护区游猎用车';
  if (/商务|轿车|接送|专车|MPV/i.test(identity)) return '城市与机场接送';
  if (/船|轮渡|快艇|游艇|海上/.test(identity)) return '海上与岛屿交通衔接';
  return '全程专属交通衔接';
}

export function transportProductName(item = {}) {
  const category = clean(item.category);
  const identity = `${category} ${item.serviceLevel || ''}`;
  if (/商务|轿车|接送|专车|MPV/i.test(identity) && /^(?:商务用车|商务车)$/.test(category)) return '城市与机场商务用车';
  return category || '交通安排';
}

export function transportConfigurationLabels(item = {}) {
  const identity = `${item.category || ''} ${item.serviceLevel || ''} ${item.model || ''}`;
  const labels = [];
  if (/飞机|航班|航空/.test(identity)) labels.push('境内轻型航空衔接');
  else if (/越野|游猎|4x4|4×4/i.test(identity)) labels.push('园区与保护区游猎车辆');
  else if (/商务|轿车|接送|专车|MPV/i.test(identity)) labels.push('市区商务车');
  else if (clean(item.serviceLevel) && clean(item.serviceLevel) !== clean(item.category)) labels.push(clean(item.serviceLevel));
  if (item.seatCount) labels.push(`${item.seatCount}座`);
  if (clean(item.model)) labels.push(`${item.modelGuaranteed ? '指定车型' : '参考车型'} · ${clean(item.model)}`);
  return [...new Set(labels)].filter((label) => label !== transportProductName(item));
}
