// Mobile companion web app served by src/mobile.ts (kept as a string so `bun build --compile` embeds it).
export const MOBILE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#09090b">
<link rel="manifest" href="/manifest.webmanifest">
<title>UpBot</title>
<style>
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; font: 15px -apple-system, system-ui, sans-serif; background: #09090b; color: #f4f4f5; height: 100dvh; display: flex; flex-direction: column; }
  header { padding: 12px 16px; border-bottom: 1px solid #27272a; display: flex; align-items: center; gap: 8px; padding-top: max(12px, env(safe-area-inset-top)); }
  header button { background: none; border: 0; color: #38bdf8; font-size: 15px; }
  main { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .agent { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid #18181b; }
  .avatar { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: #3f3f46; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #52525b; margin-left: auto; }
  .dot.running { background: #34d399; } .dot.awaiting_permission { background: #f59e0b; } .dot.error { background: #ef4444; }
  .msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; margin: 6px 0; white-space: pre-wrap; word-wrap: break-word; }
  .user { background: #0369a1; margin-left: auto; } .agentmsg { background: #27272a; }
  .meta { font-size: 12px; color: #a1a1aa; margin: 4px 0; } .error { color: #f87171; }
  .perm { border: 1px solid #f59e0b; border-radius: 10px; padding: 8px; margin: 6px 0; }
  .perm button, form button { background: #0284c7; color: #fff; border: 0; border-radius: 8px; padding: 8px 12px; margin: 4px 4px 0 0; font-size: 14px; }
  form { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #27272a; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
  input, textarea { flex: 1; background: #18181b; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 8px; padding: 10px; font: inherit; }
  textarea { resize: none; height: 44px; }
  .center { max-width: 320px; margin: 15vh auto; text-align: center; }
  .center input { width: 100%; text-align: center; font-size: 28px; letter-spacing: 8px; margin: 12px 0; }
</style>
</head>
<body>
<header><button id="back" hidden>‹ Agents</button><strong id="title">UpBot</strong></header>
<main id="main"></main>
<form id="composer" hidden><textarea id="text" placeholder="Message"></textarea><button>Send</button></form>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let token = localStorage.getItem("upbot.token");
let agents = [], statuses = {}, current = null, items = [], perms = [], events = null;

async function rpc(method, params) {
  const r = await fetch("/api/rpc", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  if (r.status === 401) { localStorage.removeItem("upbot.token"); token = null; showPair(); throw new Error("unauthorized"); }
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function showPair(msg) {
  $("back").hidden = true; $("composer").hidden = true; $("title").textContent = "Pair with UpBot";
  const box = el("div", "center");
  box.append(el("p", "meta", "On your Mac open UpBot → Mobile → Pair a device, then enter the code."));
  const input = el("input"); input.inputMode = "numeric"; input.maxLength = 6; input.autocomplete = "one-time-code";
  const btn = el("button", null, "Pair"); btn.style.cssText = "background:#0284c7;color:#fff;border:0;border-radius:8px;padding:10px 20px";
  const err = el("p", "error", msg || "");
  btn.onclick = async () => {
    const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: input.value.trim(), name: navigator.platform || "Phone" }) });
    const j = await r.json();
    if (!r.ok) { err.textContent = j.error; return; }
    token = j.token; localStorage.setItem("upbot.token", token); start();
  };
  box.append(input, btn, err);
  $("main").replaceChildren(box);
}

function connectEvents() {
  if (events) events.close();
  events = new EventSource("/api/events?token=" + encodeURIComponent(token));
  events.onmessage = (m) => onEvent(JSON.parse(m.data));
}

function onEvent({ event, data }) {
  if (event === "agent.status") { statuses[data.agentId] = data.status; if (!current) renderAgents(); return; }
  if (event.startsWith("agent.")) { loadAgents(); return; }
  if (!current) return;
  if ((event === "item.created" || event === "item.updated") && data.agentId === current.id) {
    const i = items.findIndex((x) => x.id === data.id);
    if (i >= 0) items[i] = data; else items.push(data);
    renderChat();
  } else if (event === "item.delta" && data.agentId === current.id) {
    const it = items.find((x) => x.id === data.itemId);
    if (it) { it.text = (it.text || "") + data.text; renderChat(); }
  } else if (event.startsWith("permission.")) {
    loadPerms();
  }
}

async function loadAgents() {
  agents = await rpc("agents.list", {});
  const st = await rpc("agents.statuses", {});
  statuses = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status]));
  if (!current) renderAgents();
}

function renderAgents() {
  $("back").hidden = true; $("composer").hidden = true; $("title").textContent = "Agents";
  const list = agents.map((a) => {
    const row = el("div", "agent");
    const av = el(
      "span",
      "avatar",
      a.avatar && "emoji" in a.avatar ? a.avatar.emoji : a.name.slice(0, 1),
    );
    if (a.avatar && "color" in a.avatar) av.style.background = a.avatar.color;
    const name = el("div"); name.append(el("div", null, a.name), el("div", "meta", a.provider));
    row.append(av, name, el("span", "dot " + (statuses[a.id] || "idle")));
    row.onclick = () => openAgent(a);
    return row;
  });
  $("main").replaceChildren(...(list.length ? list : [el("p", "meta", "No agents yet.")]));
}

async function openAgent(a) {
  current = a; $("back").hidden = false; $("composer").hidden = false; $("title").textContent = a.name;
  items = (await rpc("chat.history", { agentId: a.id, limit: 100 })).items;
  await loadPerms();
}

async function loadPerms() {
  if (!current) return;
  perms = (await rpc("permissions.list", {})).filter((p) => p.agentId === current.id);
  renderChat();
}

function renderChat() {
  const out = [];
  for (const it of items) {
    if (it.kind === "user_message") out.push(el("div", "msg user", it.text));
    else if (it.kind === "agent_message") out.push(el("div", "msg agentmsg", it.text));
    else if (it.kind === "tool_call") out.push(el("div", "meta", "⚙ " + it.title + " · " + it.status));
    else if (it.kind === "error") out.push(el("div", "meta error", it.message));
    else if (it.kind === "compaction") out.push(el("div", "meta", "Context compacted"));
  }
  for (const p of perms) {
    const box = el("div", "perm"); box.append(el("div", null, p.title || "Permission requested"));
    for (const o of p.options || []) {
      const b = el("button", null, o.name);
      b.onclick = () => rpc("permissions.respond", { requestId: p.requestId, optionId: o.optionId }).then(loadPerms);
      box.append(b);
    }
    out.push(box);
  }
  const main = $("main"); main.replaceChildren(...out); main.scrollTop = main.scrollHeight;
}

$("back").onclick = () => { current = null; renderAgents(); };
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text || !current) return;
  $("text").value = "";
  try { await rpc("chat.send", { agentId: current.id, text }); } catch (err) { alert(err.message); }
};

async function start() {
  try { await loadAgents(); connectEvents(); } catch (e) { if (token) showPair(e.message); }
}
token ? start() : showPair();
</script>
</body>
</html>
`;
