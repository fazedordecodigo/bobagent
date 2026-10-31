export function readStorage(key: string) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null || !key.startsWith("boto.")) return value;
    const legacyKey = `upbot.${key.slice("boto.".length)}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(legacyKey);
    }
    return legacy;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
