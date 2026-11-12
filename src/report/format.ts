export const DASH = '—';
export const CANNOT_COMPARE = 'Cannot compare';
export const pct = (v: number | null): string => (v === null ? DASH : `${(v * 100).toFixed(1)}%`);
export const pp = (v: number | null): string => (v === null ? CANNOT_COMPARE : `${v > 0 ? '+' : ''}${v.toFixed(1)} pp`);
export const count = (n: number): string => n.toLocaleString('en-US');
