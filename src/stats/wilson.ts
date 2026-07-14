export interface WilsonInterval {
  p: number;
  lo: number;
  hi: number;
}

export function wilson(wins: number, n: number): WilsonInterval {
  if (n <= 0) return { p: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}
