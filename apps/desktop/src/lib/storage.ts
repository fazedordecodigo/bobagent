export function migrateLegacyStorage() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const legacyKey = localStorage.key(i);
      if (!legacyKey?.startsWith("upbot.")) continue;
      const key = `boto.${legacyKey.slice("upbot.".length)}`;
      const value = localStorage.getItem(legacyKey);
      if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value);
      localStorage.removeItem(legacyKey);
    }
  } catch {}
}

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
