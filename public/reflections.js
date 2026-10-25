export const REFLECTION_REASONS = Object.freeze({ melody: '멜로디·소리', lyrics: '가사', memory: '추억', atmosphere: '분위기' });
export const REFLECTION_RATINGS = Object.freeze({ like: '좋았어요', neutral: '보통이에요', dislike: '아쉬웠어요' });
export const REPORT_STORAGE_KEY = 'sai-listening-reports-v1';

// Describe only explicitly submitted responses, never queue votes or personality.
export function summarizeReflections(reviews) {
  const counts = { like: 0, neutral: 0, dislike: 0 };
  const reasons = Object.fromEntries(Object.keys(REFLECTION_REASONS).map(key => [key, 0]));
  for (const review of reviews) {
    if (!Object.hasOwn(counts, review.rating)) continue;
    counts[review.rating]++;
    if (review.rating === 'like') for (const reason of new Set(review.reasons || [])) if (Object.hasOwn(reasons, reason)) reasons[reason]++;
  }
  const maximum = Math.max(0, ...Object.values(reasons));
  return { total: Object.values(counts).reduce((sum, value) => sum + value, 0), counts, reasons, topReasons: maximum ? Object.keys(reasons).filter(key => reasons[key] === maximum) : [] };
}

export function rememberReport(storage, report) {
  try {
    const saved = readReports(storage);
    const reports = [report, ...saved.filter(item => item.listeningId !== report.listeningId)].slice(0, 20);
    storage.setItem(REPORT_STORAGE_KEY, JSON.stringify(reports));
    return true;
  } catch { return false; }
}

export function readReports(storage) {
  try {
    const value = JSON.parse(storage.getItem(REPORT_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.listeningId === 'string' && typeof item.title === 'string' && item.reflections && Array.isArray(item.reflections.mine)).slice(0, 20) : [];
  } catch { return []; }
}
