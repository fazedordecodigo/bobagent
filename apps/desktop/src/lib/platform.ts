const platform =
  typeof navigator === "undefined" ? "" : `${navigator.userAgent} ${navigator.platform}`;

export const isMac = /mac/i.test(platform);
export const isWindows = /windows|win32|win64/i.test(platform);
export const mod = isMac ? "⌘" : "Ctrl+";
