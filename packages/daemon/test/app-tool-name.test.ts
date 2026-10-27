import { describe, expect, test } from "bun:test";
import { legacyPattern } from "../src/approvals";
import { appToolName, appToolNames } from "../src/apps";

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

  test("disambiguates lossy names deterministically", () => {
    const tools = [{ name: "foo__bar" }, { name: "foo_bar" }];
    const names = appToolNames("notes", tools);
    const reversed = appToolNames("notes", [...tools].reverse());
    const collided = [...names].find(([, tool]) => tool.name === "foo__bar")?.[0];

    expect(names.get("notes-foo_bar")?.name).toBe("foo_bar");
    expect(collided).toMatch(/^notes-foo_bar_[0-9a-f]{6}$/);
    expect(collided && names.get(collided)?.name).toBe("foo__bar");
    expect([...reversed]).toEqual([...names]);
  });

  test("disambiguates long names after truncation", () => {
    const shared = "a".repeat(70);
    const names = appToolNames("notes", [
      { name: `${shared}${"1".repeat(10)}` },
      { name: `${shared}${"2".repeat(10)}` },
    ]);

    expect(names.size).toBe(2);
    for (const name of names.keys()) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).not.toContain("__");
    }
  });
});

describe("legacyPattern", () => {
  test("normalizes legacy app names without changing ordinary patterns", () => {
    expect(legacyPattern("notes__foo__bar")).toBe("notes-foo_bar");
    expect(legacyPattern("notes__*")).toBe("notes-*");
    expect(legacyPattern("list_agents")).toBe("list_agents");
  });
});
