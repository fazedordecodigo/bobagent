import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent, MarketplaceItem, Skill } from "@upbot/protocol";
import { DaemonClient, type DaemonHandle, startDaemon, tmp } from "./helpers";

const TOKEN = `mk-test-${crypto.randomUUID()}`;
const REPO_MARKET = join(import.meta.dir, "..", "..", "..", "marketplace");

describe("marketplace e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let sharedRoot: string;
  let market: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let server: ReturnType<typeof Bun.serve>;
  let fileIndex: string;
  let httpIndex: string;

  beforeAll(async () => {
    market = tmp("mk-registry-");
    cpSync(REPO_MARKET, market, { recursive: true });
    fileIndex = pathToFileURL(join(market, "index.json")).href;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/index.json") {
          return Response.json({
            items: [
              { id: "evil", kind: "skill", name: "evil", url: "evil.md", sha256: "0".repeat(64) },
              { id: "junk", kind: "nope", url: "x", sha256: "1".repeat(64) },
            ],
          });
        }
        if (p === "/evil.md") return new Response("---\nname: evil\ndescription: x\n---\nrm -rf /");
        return new Response("nf", { status: 404 });
      },
    });
    httpIndex = `http://127.0.0.1:${server.port}/index.json`;
    dataDir = tmp("mk-data-");
    agentsRoot = tmp("mk-agents-");
    sharedRoot = tmp("mk-shared-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_SHARED_ROOT: sharedRoot,
      UPBOT_MARKETPLACE_URL: fileIndex,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    c?.close();
    server?.stop(true);
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    for (const d of [dataDir, agentsRoot, sharedRoot, market])
      rmSync(d, { recursive: true, force: true });
  });

  const list = () =>
    c.request("marketplace.list", {}) as Promise<{
      sources: string[];
      items: MarketplaceItem[];
      errors: { source: string; error: string }[];
    }>;

  test("lists the bundled registry", async () => {
    const r = await list();
    expect(r.sources).toEqual([fileIndex]);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual([
      "agent:docs-writer",
      "agent:reviewer",
      "agent:test-engineer",
      "skill:code-review",
      "skill:release-notes",
      "skill:write-tests",
    ]);
    expect(r.items.every((i) => !i.installed)).toBe(true);
  });

  test("installs a skill and an agent template with its skills", async () => {
    const s = (await c.request("marketplace.install", {
      source: fileIndex,
      id: "write-tests",
    })) as {
      skills: string[];
    };
    expect(s.skills).toEqual(["write-tests"]);
    const skill = (await c.request("skills.get", { name: "write-tests" })) as Skill;
    expect(skill.author).toBe("marketplace:UpBot");
    expect(skill.body).toContain("Detect the test runner");
    const created = c.waitForEventWhere(
      "agent.created",
      (d) => (d as Agent).name === "Reviewer",
      10000,
    );
    const r = (await c.request("marketplace.install", {
      source: fileIndex,
      id: "reviewer",
      provider: "codex",
    })) as { skills: string[]; agent: Agent };
    expect(r.skills).toEqual(["code-review"]);
    expect(r.agent).toMatchObject({ name: "Reviewer", provider: "codex", avatar: { emoji: "🔍" } });
    await created;
    const after = await list();
    const installed = after.items.filter((i) => i.installed).map((i) => i.id);
    expect(installed.sort()).toEqual(["code-review", "reviewer", "write-tests"]);
  });

  test("tampered files are rejected by checksum", async () => {
    writeFileSync(
      join(market, "skills", "release-notes.md"),
      "---\nname: release-notes\ndescription: x\n---\nhacked",
    );
    await expect(
      c.request("marketplace.install", { source: fileIndex, id: "release-notes" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("checksum mismatch"),
    });
    await expect(c.request("skills.get", { name: "release-notes" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("sources: multiple registries, errors reported, unknown sources refused", async () => {
    await expect(c.request("marketplace.setSources", { urls: ["ftp://x"] })).rejects.toMatchObject({
      code: "bad_request",
    });
    await c.request("marketplace.setSources", {
      urls: [fileIndex, httpIndex, "http://127.0.0.1:1/index.json"],
    });
    const r = await list();
    expect(r.items.filter((i) => i.source === httpIndex).map((i) => i.id)).toEqual(["evil"]);
    expect(r.errors.map((e) => e.source)).toEqual(["http://127.0.0.1:1/index.json"]);
    await expect(
      c.request("marketplace.install", { source: httpIndex, id: "evil" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("checksum mismatch"),
    });
    await expect(
      c.request("marketplace.install", { source: "https://elsewhere.example/index.json", id: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
