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

