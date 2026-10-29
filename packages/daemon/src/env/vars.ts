/** Parses `process.env[name]` as a JSON array of strings; null when unset or
 * invalid. An empty array is returned as-is: callers that need an executable
 * command should use `envOverride`, which treats `[]` as unset. */
export function envStringArray(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

/** `envStringArray` for command overrides: an empty array counts as unset. */
export function envOverride(name: string): string[] | null {
  const v = envStringArray(name);
  return v && v.length > 0 ? v : null;
}

/** Positive finite number from `process.env[name]`, or `fallback`. */
export function envPositiveNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
