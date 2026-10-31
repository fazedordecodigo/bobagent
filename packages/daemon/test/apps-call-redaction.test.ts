import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppsService, AppToolError } from "../src/apps";
import { migrations } from "../src/db/migrations";
import { Vault } from "../src/vault";

const SECRET = "ghp_deletedMidCallSecret93";

function setup(): { apps: AppsService; db: Database } {
  const db = new Database(":memory:");
  for (const sql of migrations) db.exec(sql);
  db.query(
    "INSERT INTO connected_apps (id, catalog_id, config_json, enabled, created_at) VALUES (?, ?, ?, 1, 1)",
  ).run(
    "leaky",
    "custom-stdio",
    JSON.stringify({
      name: "Leaky",
      transport: "stdio",
      command: ["unused"],
      url: null,
      secretKeys: ["TOKEN"],
      headers: {},
      agentIds: [],
    }),
  );
  const vault = new Vault(db, mkdtempSync(join(tmpdir(), "boto-vault-")));
  vault.set("app.leaky.TOKEN", SECRET, []);
  return { apps: new AppsService(db, vault, () => {}), db };
}

/** Stands in for a running MCP client whose pending call settles after the app is deleted. */
function connect(apps: AppsService, callTool: () => Promise<unknown>) {
  (apps as unknown as { live: Map<string, unknown> }).live.set("leaky", {
    client: { callTool, close: async () => {} },
    starting: null,
    status: "ready",
    error: null,
    tools: [{ name: "leak", inputSchema: { type: "object" } }],
    secretValues: [SECRET],
  });
}

test("an app deleted while its call is pending still has its secret out of the thrown error", async () => {
  const { apps, db } = setup();
  try {
    const cause = Object.assign(new Error(`upstream rejected Bearer ${SECRET}`), { code: -32000 });
    connect(apps, async () => {
      await apps.delete("leaky");
      throw cause;
    });
    const err = await apps.call("bot1", "leaky-leak", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppToolError);
    expect((err as Error).message).toBe("app MCP tool call failed");
    expect((err as Error).cause).toBe(cause);
  } finally {
    db.close();
  }
});

test("an app deleted while its call is pending still has its secret redacted from the output", async () => {
  const { apps, db } = setup();
  try {
    connect(apps, async () => {
      await apps.delete("leaky");
      return { content: [{ type: "text", text: `token=${SECRET}` }] };
    });
    expect(await apps.call("bot1", "leaky-leak", {})).toEqual({
      text: "token=[redacted]",
      isError: false,
    });
  } finally {
    db.close();
  }
});
