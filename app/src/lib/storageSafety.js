export const DEFAULT_STORAGE_BUDGET = 4.5 * 1024 * 1024;

export function serializedBytes(value) {
  return new Blob([JSON.stringify(value)]).size;
}

export function storageRisk(value, budget = DEFAULT_STORAGE_BUDGET) {
  const serialized = JSON.stringify(value);
  const bytes = new Blob([serialized]).size;
  const dataUrlBytes = [...serialized.matchAll(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g)].reduce((sum, match) => sum + Math.ceil(match[1].length * 0.75), 0);
  return { bytes, dataUrlBytes, budget, safe: bytes <= budget, message: bytes > budget ? `项目数据约${(bytes / 1024 / 1024).toFixed(1)}MB，超过本机安全保存上限；请删除内嵌大图或先导出当前版本。` : '' };
}

export function safeWriteStorage(storage, key, value, budget = DEFAULT_STORAGE_BUDGET) {
  const risk = storageRisk(value, budget);
  if (!risk.safe) return { ok: false, code: 'capacity_precheck', ...risk };
  try {
    storage.setItem(key, JSON.stringify(value));
    return { ok: true, ...risk };
  } catch (error) {
    return { ok: false, code: error?.name === 'QuotaExceededError' ? 'quota_exceeded' : 'storage_error', ...risk, message: error?.name === 'QuotaExceededError' ? '浏览器本地存储空间不足，当前编辑仍保留在页面中，但尚未持久保存。请先导出或删除大图后重试。' : `本地保存失败：${error?.message || '未知错误'}` };
  }
}
