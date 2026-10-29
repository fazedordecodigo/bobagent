/**
 * Shared reader for numeric `UPBOT_*` environment variables.
 *
 * Returns `fallback` when the variable is unset, empty, not a finite number, or
 * outside the allowed range, so a malformed value can never turn into NaN and
 * silently disable the guard it configures.
 *
 * The default domain is "positive" (n > 0): pass `min: 0` where zero is
 * meaningful (e.g. an immediate timeout), `max` for an upper bound, and
 * `integer: true` for counts.
 */
export function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  const aboveMin = opts.min === undefined ? n > 0 : n >= opts.min;
  if (!Number.isFinite(n) || !aboveMin) return fallback;
  if (opts.max !== undefined && n > opts.max) return fallback;
  if (opts.integer && !Number.isInteger(n)) return fallback;
  return n;
}
