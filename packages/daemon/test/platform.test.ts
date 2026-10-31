import { afterEach, describe, expect, test } from "bun:test";
import { browserCandidates } from "../src/browser";
import { resolveCommandIn, spawnEnv } from "../src/env/login-path";
import { resolveWindowsCommandInEnv } from "../src/env/spawn";
import { daemonTarget, daemonTargetForTriple } from "../src/target";

describe("resolveCommandIn on Windows", () => {
  test("prefers PATHEXT shims over extensionless files", () => {
    const files = new Set(["C:\\tools\\claude", "C:\\tools\\claude.CMD"]);
    expect(
      resolveCommandIn("claude", ["C:\\tools"], {
        platform: "win32",
        exists: (path) => files.has(path),
      }),
    ).toBe("C:\\tools\\claude.CMD");
  });

  test("PATH directory order takes precedence over PATHEXT order", () => {
    const files = new Set(["C:\\first\\tool.CMD", "C:\\second\\tool.COM"]);
    expect(
      resolveCommandIn("tool", ["C:\\first", "C:\\second"], {
        platform: "win32",
        pathext: ".COM;.CMD",
        exists: (path) => files.has(path),
      }),
    ).toBe("C:\\first\\tool.CMD");
  });

  test("matches PATHEXT case-insensitively and checks explicit paths", () => {
    const files = new Set(["C:\\tools\\Agent.cMd", "C:\\tools\\other.EXE"]);
    const exists = (path: string) =>
      [...files].some((file) => file.toLowerCase() === path.toLowerCase());
    expect(
      resolveCommandIn("Agent.CMD", ["C:\\tools"], {
        platform: "win32",
        pathext: ".cmd;.exe",
        exists,
      }),
    ).toBe("C:\\tools\\Agent.CMD");
    expect(
      resolveCommandIn("C:\\tools\\other", [], {
        platform: "win32",
        pathext: ".EXE;.CMD",
        exists,
      }),
    ).toBe("C:\\tools\\other.EXE");
    expect(
      resolveCommandIn("C:\\tools\\Agent.cMd", [], {
        platform: "win32",
        exists,
      }),
    ).toBe("C:\\tools\\Agent.cMd");
  });
});

describe("Windows spawn command resolution", () => {
  test("reads PATH and PATHEXT case-insensitively from the supplied environment", () => {
    const files = new Set(["C:\\first\\claude.CMD", "C:\\second\\claude.EXE"]);
    const exists = (path: string) =>
      [...files].some((file) => file.toLowerCase() === path.toLowerCase());
    expect(
      resolveWindowsCommandInEnv(
        "claude",
        { pAtH: "C:\\first;C:\\second", PaThExT: ".EXE;.CMD" },
        "C:\\work",
        exists,
      ),
    ).toBe("C:\\first\\claude.CMD");
  });

  test("requires explicit paths to exist and resolves relative paths from cwd", () => {
    const files = new Set(["C:\\work\\tools\\agent.CMD"]);
    const exists = (path: string) =>
      [...files].some((file) => file.toLowerCase() === path.toLowerCase());
    expect(
      resolveWindowsCommandInEnv(
        ".\\tools\\agent",
        { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
        "C:\\work",
        exists,
      ),
    ).toBe("C:\\work\\tools\\agent.CMD");
    expect(
      resolveWindowsCommandInEnv(
        "C:\\missing\\agent.exe",
        { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
        "C:\\work",
        exists,
      ),
    ).toBeNull();
    expect(
      resolveWindowsCommandInEnv("agent", { PATHEXT: ".EXE;.CMD" }, "C:\\work", exists),
    ).toBeNull();
  });
});

describe("browser candidates", () => {
  test("keeps the macOS and Linux browser locations", () => {
    expect(browserCandidates("darwin")[0]).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(browserCandidates("linux")).toEqual([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
    ]);
  });

  test("builds Windows browser candidates from environment paths", () => {
    expect(
      browserCandidates("win32", {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      }),
    ).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ]);
  });
});

describe("spawnEnv on Windows", () => {
  test("strips both current and legacy internal product variables", () => {
    const keys = ["BOTO_TEST_INTERNAL", "UPBOT_TEST_INTERNAL"];
    const previous = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) process.env[key] = "not-for-providers";
      const env = spawnEnv({}, "win32", "C:\\tools");
      for (const key of keys) expect(env[key]).toBeUndefined();
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  const originalPath = process.env.PATH;
  const originalAltPath = process.env.Path;
  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAltPath === undefined) delete process.env.Path;
    else process.env.Path = originalAltPath;
  });

  test("deduplicates case-insensitive PATH keys before setting PATH", () => {
    process.env.PATH = "base-path";
    process.env.Path = "alternate-path";
    const env = spawnEnv({ Path: "extra-path" }, "win32", "C:\\tools");
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\tools");
  });
});

describe("daemon target mapping", () => {
  test.each([
    ["darwin", "arm64", "bun-darwin-arm64", "aarch64-apple-darwin"],
    ["linux", "x64", "bun-linux-x64", "x86_64-unknown-linux-gnu"],
    ["win32", "x64", "bun-windows-x64", "x86_64-pc-windows-msvc"],
  ])("%s/%s maps to its native bundle target", (platform, arch, bunTarget, rustTriple) => {
    expect(daemonTarget(platform, arch)).toEqual({ bunTarget, rustTriple });
    expect(daemonTargetForTriple(rustTriple).bunTarget).toBe(bunTarget);
  });

  test("rejects unsupported targets", () => {
    expect(() => daemonTarget("linux", "arm64")).toThrow("Unsupported daemon build target");
    expect(() => daemonTargetForTriple("x86_64-pc-windows-gnu")).toThrow(
      "Unsupported Rust target triple",
    );
  });
});
