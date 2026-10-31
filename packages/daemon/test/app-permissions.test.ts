import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type AppPermissionKind,
  type AppPermissions,
  classifyAppTool,
  defaultAppPermissions,
} from "@boto/protocol";
import { AppsService } from "../src/apps";
import { migrations } from "../src/db/migrations";
import { Vault } from "../src/vault";

test("classifier recognizes sensitive verbs before general writes and ignores the app slug", () => {
  const cases = {
    del: ["delete", "remove", "destroy", "trash"],
    pay: ["pay", "charge", "refund", "transfer", "payout", "purchase"],
    book: ["book", "reserve"],
    send: [
      "send",
      "post",
      "publish",
      "invite",
      "reply",
      "forward",
      "email",
      "message",
      "dispatch",
      "deliver",
      "notify",
      "broadcast",
      "sms",
      "text",
      "chat",
      "push",
      "share",
      "comment",
      "dm",
      "mail",
      "tweet",
    ],
    write: [
      "create",
      "update",
      "merge",
      "write",
      "edit",
      "archive",
      "cancel",
      "move",
      "rename",
      "upload",
      "patch",
      "put",
      "set",
      "add",
      "insert",
      "close",
    ],
  } as const;
  for (const [kind, verbs] of Object.entries(cases))
    for (const verb of verbs) {
      expect(classifyAppTool(`read_app-${verb}_item`)).toBe(kind as AppPermissionKind);
      expect(classifyAppTool(`read_app-${verb.toUpperCase()}Item`)).toBe(kind as AppPermissionKind);
    }
  for (const tool of ["send_app-list", "pay_app-get", "write_app-search"])
    expect(classifyAppTool(tool)).toBe("read");
  for (const verb of [
    "get",
    "list",
    "search",
    "read",
    "query",
    "fetch",
    "retrieve",
    "find",
    "describe",
    "lookup",
    "view",
    "show",
    "count",
    "check",
    "status",
  ]) {
    expect(classifyAppTool(`app-${verb}_items`)).toBe("read");
    expect(classifyAppTool(`app-${verb}Items`)).toBe("read");
  }
  for (const tool of ["app-echo", "app-whoami", "app-frobnicate", "app-getaway", "app-", ""])
    expect(classifyAppTool(tool)).toBe("write");
  expect(classifyAppTool("app-dispatch_message")).toBe("send");
  expect(classifyAppTool("app-deliver_notification")).toBe("send");
  expect(classifyAppTool("app-get_and_delete")).toBe("del");
  expect(classifyAppTool("app-send_payment")).toBe("send");
  expect(classifyAppTool("app-send_booking")).toBe("send");
  expect(classifyAppTool("app-create_and_send")).toBe("send");
  expect(classifyAppTool("app-update_reserve")).toBe("write");
});

test("read objects are nouns, while connectors chain actions with sensitivity precedence", () => {
  for (const noun of [
    "comments",
    "text",
    "mailbox",
    "chats",
    "share_link",
    "messages",
    "bookings",
    "payment",
    "send",
    "post",
    "publish",
    "invite",
    "reply",
    "forward",
    "mail",
    "email",
    "message",
    "dispatch",
    "deliver",
    "notify",
    "broadcast",
    "sms",
    "chat",
    "push",
    "share",
    "comment",
    "dm",
    "tweet",
    "delete",
    "pay",
    "book",
    "write",
  ]) {
    expect(classifyAppTool(`notes-get_${noun}`)).toBe("read");
    expect(classifyAppTool(`notes-list_${noun}`)).toBe("read");
    expect(classifyAppTool(`notes-search_${noun}`)).toBe("read");
  }
  for (const verb of [
    "send_email",
    "post_comment",
    "dispatch_message",
    "deliver_notification",
    "share_file",
    "reply",
  ])
    expect(classifyAppTool(`notes-${verb}`)).toBe("send");
  const cases = {
    get_and_delete: "del",
    fetch_then_send: "send",
    read_or_archive: "write",
    list_then_book: "book",
    send_and_pay: "pay",
    pay_or_delete: "del",
    delete_then_send: "del",
    book_then_write: "book",
    getAndDelete: "del",
    "fetch-then-send": "send",
    readOrArchive: "write",
    GETText: "read",
    listBookings: "read",
    getPayment: "read",
    book_room: "book",
    message_send: "send",
    page_create: "write",
    page_get: "read",
    page_send_and_delete: "del",
    unknown: "write",
    get_and_unknown: "read",
    get_then_payment: "read",
  } as const;
  for (const [operation, kind] of Object.entries(cases))
    expect(classifyAppTool(`notes-${operation}`)).toBe(kind);
});

test("migration backfills existing apps and service validation rejects sensitive allow", async () => {
  const db = new Database(":memory:");
  try {
    for (const sql of migrations.slice(0, -1)) db.exec(sql);
    db.query(
      "INSERT INTO connected_apps (id, catalog_id, config_json, enabled, created_at) VALUES (?, ?, ?, 0, 1)",
    ).run(
      "legacy",
      "custom-stdio",
      JSON.stringify({
        name: "Legacy",
        transport: "stdio",
        command: ["unused"],
        url: null,
        secretKeys: [],
        headers: {},
        agentIds: [],
      }),
    );
    db.exec(migrations.at(-1)!);
    const apps = new AppsService(db, new Vault(db, "unused"), () => {});
    expect(apps.get("legacy").permissions).toEqual(defaultAppPermissions);
    for (const kind of ["send", "pay", "book", "del"]) {
      const permissions = { [kind]: "allow" } as Partial<AppPermissions>;
      await expect(apps.update({ id: "legacy", permissions })).rejects.toThrow();
      expect(() =>
        apps.connect({
          catalogId: "custom-stdio",
          name: "Rejected",
          command: ["unused"],
          secrets: {},
          permissions,
        }),
      ).toThrow();
    }
    expect(apps.list()).toHaveLength(1);
    expect(apps.get("legacy").permissions).toEqual(defaultAppPermissions);
  } finally {
    db.close();
  }
});
