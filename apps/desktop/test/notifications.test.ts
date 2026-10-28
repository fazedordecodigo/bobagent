import { expect, test } from "bun:test";
import type { Approval } from "@upbot/protocol";
import type { ApprovalResult } from "../src/lib/approval-decisions";
import type { DaemonClient } from "../src/lib/daemon";
import {
  ApprovalNotifications,
  type DecisionNotification,
  decisionNotification,
  MUTE_KEY,
  muteForHour,
  muteUntil,
  type NotificationBridge,
} from "../src/lib/notifications";

const pending: Approval = {
  id: "decision",
  agentId: "bot",
  turnId: "turn",
  kind: "tool",
  title: "Run notas-create_note",
  tool: "notas-create_note",
  detail: "{}",
  appId: "notes",
  appName: "Notas",
  permission: "write",
  status: "pending",
  secretName: null,
  background: false,
  createdAt: 100,
  expiresAt: 100000,
};
const notification = (overrides: Partial<Approval> = {}) =>
  decisionNotification({ ...pending, ...overrides }, "UpBot", false, 1000);

test("one pending decision produces human Portuguese and task-only permission actions", () => {
  expect(notification()).toEqual({
    id: "decision",
    title: "UpBot quer criar uma nota em Notas.",
    body: "",
    muted: false,
    actions: [
      { id: "deny", label: "Recusar" },
      { id: "task", label: "Só nesta tarefa" },
    ],
  });
  for (const status of ["approved", "denied", "expired", "done"] as const)
    expect(notification({ status })).toBeNull();
  expect(notification({ expiresAt: 1000 })).toBeNull();
});

test("payment, booking and deletion require the app; secrets and takeover never act inline", () => {
  for (const permission of ["pay", "book", "del"] as const) {
    expect(notification({ permission, detail: '{"total":100,"currency":"BRL"}' })?.actions).toEqual(
      [{ id: "review", label: "Revisar no UpBot" }],
    );
  }
  for (const kind of ["secret", "takeover"] as const) {
    const item = notification({ kind, detail: "secret stuff" });
    expect(item?.actions).toEqual([{ id: "review", label: "Revisar no UpBot" }]);
    expect(item?.body).not.toContain("secret stuff");
  }
});

test("sends require complete recipients and content, with every field fitting", () => {
  const send = { permission: "send" as const, tool: "notas-send_message" };
  for (const detail of [
    "{}",
    "oops",
    "null",
    "[]",
    '{"to":"Ana"}',
    '{"to":"Ana","text":"Oi","hidden":true}',
    JSON.stringify({ to: "Ana", text: "x".repeat(200) }),
    '{"to":[],"text":"Oi"}',
    '{"to":{"email":"ana"},"text":"Oi"}',
  ]) {
    expect(notification({ ...send, detail })?.actions.map((a) => a.id)).toEqual(["review"]);
  }
  const complete = notification({
    ...send,
    detail: '{"to":"Ana","text":"Oi","attachments":["Relatório.pdf"],"total":100}',
  });
  expect(complete?.body).toBe("Para: Ana · Mensagem: Oi · Anexos: Relatório.pdf · Total: 100");
  expect(complete?.actions.map((a) => a.id)).toEqual(["deny", "task"]);
  const { appId, permission, appName, ...nonApp } = pending;
  const direct = decisionNotification(
    { ...nonApp, tool: "send_email", detail: '{"to":"Ana","body":"Oi"}' },
    "UpBot",
    false,
    1000,
  );
  expect(direct?.actions).toEqual([
    { id: "approve", label: "Aprovar e enviar" },
    { id: "review", label: "Revisar no app" },
  ]);
  expect(JSON.stringify(complete)).not.toContain("always");
});

test("oversized titles and unknown operations fail closed to review, malformed details are safe", () => {
  expect(notification({ appName: "A".repeat(150) })?.actions.map((a) => a.id)).toEqual(["review"]);
  expect(notification({ detail: "not JSON" })?.body).toBe("Revise os detalhes no UpBot.");
  expect(notification({ detail: '{"password":"secret"}' })?.body).not.toContain("secret");
  const { appId, permission, ...nonApp } = pending;
  for (const tool of [
    "get_and_delete",
    "fetch_then_send",
    "read_or_archive",
    "pay_invoice",
    "book_room",
  ]) {
    expect(
      decisionNotification({ ...nonApp, tool, detail: "{}" }, "UpBot", false, 1000)?.actions.map(
        (a) => a.id,
      ),
    ).toEqual(["review"]);
  }
  expect(
    decisionNotification(
      { ...nonApp, tool: "mystery", detail: "{}" },
      "UpBot",
      false,
      1000,
    )?.actions.map((a) => a.id),
  ).toEqual(["review"]);
});

function preferences() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

test("mute is a persisted finite timestamp with exactly one hour duration", () => {
  const store = preferences();
  expect(muteUntil(store)).toBe(0);
  expect(muteForHour(store, 1000)).toBe(3601000);
  expect(muteUntil(store)).toBe(3601000);
  store.setItem(MUTE_KEY, "Infinity");
  expect(muteUntil(store)).toBe(0);
  store.setItem(MUTE_KEY, "broken");
  expect(muteUntil(store)).toBe(0);
});

function harness(initial: Approval[] = [pending], store = preferences(), result?: ApprovalResult) {
  let approvals = initial;
  let handler: ((approval: Approval) => void) | undefined;
  const posts: DecisionNotification[] = [];
  const removals: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const errors: string[] = [];
  const views: string[] = [];
  let fail = false;
  let now = 1000;
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "approvals.list") return approvals;
      if (method === "approvals.respond") {
        if (fail) throw new Error("Pedido já resolvido.");
        const decision = (params as { decision: string }).decision;
        const result = {
          ...pending,
          status: decision === "deny" ? "denied" : "approved",
        } as Approval;
        approvals = [result];
        handler?.(result);
        return result;
      }
      throw new Error(`Unexpected RPC ${method}`);
    },
    on: (_event: string, fn: (approval: Approval) => void) => {
      handler = fn;
      return () => {
        handler = undefined;
      };
    },
    onReconnect: () => () => {},
  } as unknown as Pick<DaemonClient, "request" | "on" | "onReconnect">;
  const bridge: NotificationBridge = {
    initialize: async () => true,
    post: async (item) => {
      posts.push(item);
    },
    remove: async (id) => {
      removals.push(id);
    },
    listen: async () => () => {},
    open: async () => {
      views.push("open");
    },
  };
  const controller = new ApprovalNotifications(
    client,
    bridge,
    store,
    () => "UpBot",
    (view) => views.push(view),
    (error) => errors.push(error),
    () => now,
    result ? async () => result : undefined,
  );
  return {
    controller,
    posts,
    removals,
    calls,
    errors,
    views,
    bridge,
    update: async (a: Approval) => {
      approvals = [a];
      handler?.(a);
      await Bun.sleep(0);
    },
    fail: () => {
      fail = true;
    },
    store,
    time: (value: number) => {
      now = value;
    },
  };
}

test("notification lifecycle deduplicates updates and restart; external decisions remove without responding", async () => {
  const h = harness();
  try {
    await h.controller.start();
    await h.update(pending);
    expect(h.posts.length).toBe(1);
    expect(h.calls.some((c) => c.method === "approvals.respond")).toBe(false);
    await h.update({ ...pending, status: "expired" });
    expect(h.removals).toContain(pending.id);
  } finally {
    h.controller.stop();
  }
  const restarted = harness([pending], h.store);
  try {
    await restarted.controller.start();
    expect(restarted.posts).toEqual([]);
  } finally {
    restarted.controller.stop();
  }
});

test("inline decisions use normal daemon RPC and same identifier for a truthful result without undo", async () => {
  for (const action of ["task", "deny"] as const) {
    const h = harness();
    try {
      await h.controller.start();
      await h.controller.respond({ id: pending.id, action });
      await Bun.sleep(0);
      expect(h.calls.filter((c) => c.method === "approvals.respond")).toEqual([
        { method: "approvals.respond", params: { id: pending.id, decision: action } },
      ]);
      expect(h.posts.at(-1)?.id).toBe(pending.id);
      expect(h.posts.at(-1)?.actions).toEqual([]);
      expect(h.removals).toEqual([]);
    } finally {
      h.controller.stop();
    }
  }
});

test("forged or stale actions never respond; mute and review never resolve", async () => {
  const h = harness();
  try {
    await h.controller.start();
    await h.controller.respond({ id: pending.id, action: "always" });
    await h.controller.respond({ id: pending.id, action: "approve" });
    await h.controller.respond({ id: pending.id, action: "undo" });
    await h.controller.respond({ id: pending.id, action: "review" });
    await h.controller.respond({ id: pending.id, action: "mute" });
    expect(h.views).toEqual(["bot", "open"]);
    expect(muteUntil(h.store)).toBe(3601000);
    await h.update({ ...pending, status: "approved" });
    await h.controller.respond({ id: pending.id, action: "task" });
    expect(h.calls.filter((c) => c.method === "approvals.respond")).toEqual([]);
  } finally {
    h.controller.stop();
  }
});

test("RPC failure does not fabricate success; initialization disabled and muted posting are safe", async () => {
  const h = harness();
  try {
    await h.controller.start();
    h.fail();
    await expect(h.controller.respond({ id: pending.id, action: "task" })).rejects.toThrow(
      "Pedido já resolvido.",
    );
    expect(h.posts.length).toBe(1);
    expect(h.removals).toContain(pending.id);
  } finally {
    h.controller.stop();
  }
  const muted = harness();
  muteForHour(muted.store, 1000);
  try {
    await muted.controller.start();
    expect(muted.posts[0]?.muted).toBe(true);
  } finally {
    muted.controller.stop();
  }
  const disabled = harness();
  disabled.bridge.initialize = async () => false;
  try {
    await disabled.controller.start();
    expect(disabled.posts).toEqual([]);
  } finally {
    disabled.controller.stop();
  }
});

test("a real preference undo is offered for six seconds, never executed twice or after its deadline", async () => {
  let calls = 0;
  const result = {
    message: "Preferência salva.",
    undo: async () => {
      calls++;
    },
  };
  const h = harness([pending], preferences(), result);
  try {
    await h.controller.start();
    await h.controller.respond({ id: pending.id, action: "task" });
    expect(h.posts.at(-1)?.actions).toEqual([{ id: "undo", label: "Desfazer" }]);
    h.time(6999);
    await h.controller.respond({ id: pending.id, action: "undo" });
    expect(calls).toBe(1);
    expect(h.posts.at(-1)?.title).toBe("Preferência restaurada.");
    await h.controller.respond({ id: pending.id, action: "undo" });
    expect(calls).toBe(1);
  } finally {
    h.controller.stop();
  }
  const expired = harness([pending], preferences(), result);
  try {
    await expired.controller.start();
    await expired.controller.respond({ id: pending.id, action: "task" });
    expired.time(7000);
    await expired.controller.respond({ id: pending.id, action: "undo" });
    expect(calls).toBe(1);
  } finally {
    expired.controller.stop();
  }
});

test("undo errors do not claim success or lose the saved preference", async () => {
  const h = harness([pending], preferences(), {
    message: "Preferência salva.",
    undo: async () => {
      throw new Error("A permissão já mudou.");
    },
  });
  try {
    await h.controller.start();
    await h.controller.respond({ id: pending.id, action: "task" });
    await expect(h.controller.respond({ id: pending.id, action: "undo" })).rejects.toThrow(
      "A permissão já mudou.",
    );
    expect(h.posts.at(-1)?.title).toBe("Preferência salva.");
  } finally {
    h.controller.stop();
  }
});

test("empty approvals cause no notifications and dismissal is not an approval decision", async () => {
  const h = harness([]);
  try {
    await h.controller.start();
    await h.controller.respond({ id: pending.id, action: "dismiss" });
    expect(h.posts).toEqual([]);
    expect(h.calls.some((c) => c.method === "approvals.respond")).toBe(false);
  } finally {
    h.controller.stop();
  }
});
