import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { legacyPattern } from "../src/approvals";
import { appToolName, appToolNames } from "../src/apps";

function expectSafeNames<T extends { name: string }>(names: Map<string, T>, size: number) {
  expect(names.size).toBe(size);
  expect(new Set(names.keys()).size).toBe(size);
  for (const name of names.keys()) {
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("__");
  }
}

describe("appToolName", () => {
  test("returns sanitized, Grok-safe names capped at 64 characters", () => {
    const name = appToolName("microsof_learn", "microsoft_docs_search");
    const sanitized = appToolName("x", "a__b.c");
    const long = appToolName("x", "a".repeat(80));

    expect(name).toBe("microsof_learn-microsoft_docs_search");
    expect(sanitized).toBe("x-a_b_c");
    for (const value of [name, sanitized, long]) {
      expect(value).not.toContain("__");
      expect(value.length).toBeLessThanOrEqual(64);
    }
  });

  test("keeps lossless names when they collide with a generated suffix", () => {
    const double = { name: "foo__bar" };
    const single = { name: "foo_bar" };
    const suffix = { name: "foo_bar_a3a759" };
    const canonical = [double, single, suffix];
    const permutations = [
      canonical,
      [double, suffix, single],
      [single, double, suffix],
      [single, suffix, double],
      [suffix, double, single],
      [suffix, single, double],
    ];
    const names = appToolNames("notes", canonical);
    const doubleName = [...names].find(([, tool]) => tool.name === double.name)?.[0];

    expect(createHash("sha256").update(double.name).digest("hex").slice(0, 6)).toBe("a3a759");
    expectSafeNames(names, 3);
    expect(names.get("notes-foo_bar")?.name).toBe(single.name);
    expect(names.get("notes-foo_bar_a3a759")?.name).toBe(suffix.name);
    expect(doubleName).toMatch(/^notes-foo_bar_[0-9a-f]{6}$/);
    expect(doubleName).not.toBe("notes-foo_bar_a3a759");
    expect(names.get(doubleName ?? "")?.name).toBe(double.name);
    for (const tools of permutations) {
      expect([...appToolNames("notes", tools)]).toEqual([...names]);
    }
  });

  test("retries suffixes that collide with a unique lossy base", () => {
    const double = { name: "foo__bar" };
    const single = { name: "foo_bar" };
    const suffix = { name: "foo__bar_a3a759" };
    const canonical = [double, single, suffix];
    const permutations = [
      canonical,
      [double, suffix, single],
      [single, double, suffix],
      [single, suffix, double],
      [suffix, double, single],
      [suffix, single, double],
    ];
    const names = appToolNames("notes", canonical);
    const doubleName = [...names].find(([, tool]) => tool.name === double.name)?.[0];

    expectSafeNames(names, 3);
    expect(names.get("notes-foo_bar")?.name).toBe(single.name);
    expect(names.get("notes-foo_bar_a3a759")?.name).toBe(suffix.name);
    expect(doubleName).toMatch(/^notes-foo_bar_[0-9a-f]{6}$/);
    expect(doubleName).not.toBe("notes-foo_bar_a3a759");
    expect(names.get(doubleName ?? "")?.name).toBe(double.name);
    for (const tools of permutations) {
      expect([...appToolNames("notes", tools)]).toEqual([...names]);
    }
  });

  test("disambiguates long names after truncation", () => {
    const shared = "a".repeat(70);
    const names = appToolNames("notes", [
      { name: `${shared}${"1".repeat(10)}` },
      { name: `${shared}${"2".repeat(10)}` },
    ]);

    expectSafeNames(names, 2);
  });
});

describe("legacyPattern", () => {
  test("normalizes legacy app names without changing ordinary patterns", () => {
    expect(legacyPattern("notes__foo__bar")).toBe("notes-foo_bar");
    expect(legacyPattern("notes__*")).toBe("notes-*");
    expect(legacyPattern("list_agents")).toBe("list_agents");
  });
});
