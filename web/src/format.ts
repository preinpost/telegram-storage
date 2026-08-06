/** Small formatting helpers (no dependencies). */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 || value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * Format an ISO date for the given BCP-47 locale (e.g. 'ko-KR', 'en-US', 'ja-JP').
 * Callers should pass the current UI language via `langToLocale()` from i18n.
 */
export function formatDate(iso: string, locale = 'ko-KR'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}
