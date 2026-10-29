import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { ApprovalService } from "../src/approvals";
import { AppsService } from "../src/apps";
import { migrations } from "../src/db/migrations";
import type { RuntimeManager } from "../src/runtime/runtime-manager";
import { Vault } from "../src/vault";

async function withApprovals(
  run: (approvals: ApprovalService, apps: AppsService, vault: Vault) => Promise<void>,
) {
  const ttl = process.env.UPBOT_APPROVAL_TTL_MS;
  const vaultKey = process.env.UPBOT_VAULT_KEY;
  process.env.UPBOT_APPROVAL_TTL_MS = "50";
  process.env.UPBOT_VAULT_KEY = "ab".repeat(32);
  const db = new Database(":memory:");
  try {
    for (const sql of migrations) db.exec(sql);
    db.query(
      "INSERT INTO connected_apps (id, catalog_id, config_json, enabled, created_at) VALUES (?, ?, ?, 0, 1)",
    ).run(
      "notes",
      "custom-stdio",
      JSON.stringify({
        name: "Notes",
        transport: "stdio",
        command: ["unused"],
        url: null,
        secretKeys: [],
        headers: {},
        agentIds: [],
      }),
    );
    const vault = new Vault(db, "unused");
    const apps = new AppsService(db, vault, () => {});
    const runtimes = {
      currentTurn: () => ({ id: "turn", background: false }),
    } as unknown as RuntimeManager;
    const approvals = new ApprovalService(
      db,
      vault,
      () => runtimes,
      () => {},
      apps,
    );
    await run(approvals, apps, vault);
  } finally {
    if (ttl === undefined) delete process.env.UPBOT_APPROVAL_TTL_MS;
    else process.env.UPBOT_APPROVAL_TTL_MS = ttl;
    if (vaultKey === undefined) delete process.env.UPBOT_VAULT_KEY;
    else process.env.UPBOT_VAULT_KEY = vaultKey;
    db.close();
  }
}

test("read nouns pass the gate with read allow even when sensitive permissions are off", async () => {
  await withApprovals(async (approvals, apps) => {
    await apps.update({
      id: "notes",
      permissions: { read: "allow", send: "off", book: "off", pay: "off", del: "off" },
    });
    for (const operation of [
      "list_comments",
      "get_text",
      "get_mailbox",
      "list_chats",
      "get_share_link",
      "search_messages",
      "list_bookings",
      "get_payment",
    ]) {
      await approvals.gate("bot", `notes-${operation}`, {}, true);
    }
    expect(approvals.list()).toEqual([]);
    await expect(approvals.gate("bot", "notes-send_email", {}, true)).rejects.toThrow(
      "Notes não permite send",
    );
    await expect(approvals.gate("bot", "notes-get_and_delete", {}, true)).rejects.toThrow(
      "Notes não permite del",
    );
    expect(approvals.list()).toEqual([]);
  });
});

test("expired decisions persist neither permanent permissions nor task grants", async () => {
  await withApprovals(async (approvals, apps) => {
    const update = spyOn(apps, "update");
    for (const decision of ["always", "task"] as const) {
      const gate = approvals.gate("bot", "notes-create_note", {}, true).catch((error) => error);
      const pending = approvals.list().find((a) => a.status === "pending")!;
      await Bun.sleep(80);
      await expect(approvals.respond({ id: pending.id, decision })).rejects.toMatchObject({
        code: "not_found",
      });
      expect(await gate).toBeInstanceOf(Error);
      expect(apps.get("notes").permissions.write).toBe("ask");
      expect(approvals.decide("bot", "notes-create_note", true)).toBe("ask");
    }
    expect(update).not.toHaveBeenCalled();
  });
});

test("elapsed deadline is checked even before its timer callback runs", async () => {
  await withApprovals(async (approvals, apps) => {
    const update = spyOn(apps, "update");
    const gate = approvals.gate("bot", "notes-create_note", {}, true).catch((error) => error);
    const pending = approvals.list()[0]!;
    pending.expiresAt = Date.now() - 1;
    await expect(approvals.respond({ id: pending.id, decision: "always" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await gate).toBeInstanceOf(Error);
    expect(update).not.toHaveBeenCalled();
    expect(apps.get("notes").permissions.write).toBe("ask");
  });
});

test("claimed decision survives a slow update, rejects duplicates and cannot expire at turn end", async () => {
  await withApprovals(async (approvals, apps) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = apps.update.bind(apps);
    spyOn(apps, "update").mockImplementation(async (p) => {
      await held;
      return update(p);
    });
    const gate = approvals.gate("bot", "notes-create_note", {}, true);
    const pending = approvals.list()[0]!;
    const response = approvals.respond({ id: pending.id, decision: "always" });
    await expect(approvals.respond({ id: pending.id, decision: "task" })).rejects.toMatchObject({
      code: "busy",
    });
    await Bun.sleep(80);
    approvals.onTurnEnded("bot", "turn");
    expect(approvals.list()[0]?.status).toBe("pending");
    release();
    expect(await response).toMatchObject({ status: "approved", previousLevel: "ask" });
    await gate;
    expect(apps.get("notes").permissions.write).toBe("allow");
    await expect(approvals.respond({ id: pending.id, decision: "always" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

for (const persisted of [false, true]) {
  test(`failed update denies the claimed approval and restores permissions (persisted=${persisted})`, async () => {
    await withApprovals(async (approvals, apps) => {
      const update = apps.update.bind(apps);
      spyOn(apps, "update").mockImplementation(async (p) => {
        if (persisted) await update(p);
        await Bun.sleep(80);
        throw new Error("save failed");
      });
      const gate = approvals.gate("bot", "notes-create_note", {}, true).catch((error) => error);
      const pending = approvals.list()[0]!;
      await expect(approvals.respond({ id: pending.id, decision: "always" })).rejects.toThrow(
        "save failed",
      );
      expect(await gate).toBeInstanceOf(Error);
      expect(approvals.list()[0]?.status).toBe("denied");
      expect(apps.get("notes").permissions.write).toBe("ask");
      expect(approvals.decide("bot", "notes-create_note", true)).toBe("ask");
    });
  });
}

test("approving a secret merges the existing allowlist instead of shrinking it", async () => {
  await withApprovals(async (approvals, _apps, vault) => {
    vault.set("stripe.key", "v1", ["bot-a"]);
    const request = approvals.requestSecret("bot-b", "stripe.key", "", "need it");
    const pending = approvals.list().find((a) => a.status === "pending")!;
    await approvals.respond({ id: pending.id, decision: "approve", value: "v2" });
    expect(await request).toContain("gave you access");
    expect(vault.get("stripe.key")!.agentIds.sort()).toEqual(["bot-a", "bot-b"]);
    expect(vault.reveal("stripe.key", "bot-a")).toBe("v2");
  });
});

test("a vault read failure while approving a secret propagates and keeps the allowlist", async () => {
  await withApprovals(async (approvals, _apps, vault) => {
    vault.set("stripe.key", "v1", ["bot-a"]);
    spyOn(vault, "get").mockImplementation(() => {
      throw new Error("corrupt row");
    });
    const request = approvals.requestSecret("bot-b", "stripe.key", "", "need it");
    const pending = approvals.list().find((a) => a.status === "pending")!;
    await expect(
      approvals.respond({ id: pending.id, decision: "approve", value: "v2" }),
    ).rejects.toThrow("corrupt row");
    expect(await request).toContain("did not provide");
    expect(vault.reveal("stripe.key", "bot-a")).toBe("v1");
  });
});
