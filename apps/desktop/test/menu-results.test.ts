import { expect, test } from "bun:test";
import {
  addMenuResult,
  expireMenuResults,
  MENU_RESULT_LIMIT,
  MENU_RESULT_TTL,
  type MenuResult,
} from "../src/lib/menu-results";

test("completed rows and real undo expire exactly six seconds after the decision", () => {
  const undo = async () => {};
  const rows = addMenuResult([], { id: "decision", createdAt: 0, message: "Concluído", undo }, 100);
  expect(rows[0]?.undo).toBe(undo);
  expect(expireMenuResults(rows, 100 + MENU_RESULT_TTL - 1)).toEqual(rows);
  expect(expireMenuResults(rows, 100 + MENU_RESULT_TTL)).toEqual([]);
  expect(expireMenuResults([], 0)).toEqual([]);
});

test("completed rows are capped, deduplicated and never retain expired results", () => {
  let rows: MenuResult[] = [];
  for (let i = 0; i < 20; i++)
    rows = addMenuResult(rows, { id: String(i), createdAt: i, message: "Concluído" }, i);
  expect(rows.length).toBe(MENU_RESULT_LIMIT);
  expect(rows.map((row) => row.id)).toEqual(["19", "18", "17", "16", "15"]);
  rows = addMenuResult(rows, { id: "19", createdAt: 19, message: "Atualizado" }, 20);
  expect(rows.filter((row) => row.id === "19").length).toBe(1);
  expect(addMenuResult(rows, { id: "new", createdAt: 0, message: "Concluído" }, 7000).length).toBe(
    1,
  );
});

test("an undo error does not extend the retention window", async () => {
  const rows = addMenuResult(
    [],
    {
      id: "decision",
      createdAt: 0,
      message: "Concluído",
      undo: async () => {
        throw new Error("offline");
      },
    },
    100,
  );
  await expect(rows[0]?.undo?.()).rejects.toThrow("offline");
  expect(expireMenuResults(rows, 6100)).toEqual([]);
});
