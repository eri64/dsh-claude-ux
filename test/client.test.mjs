// dsh-claude 客户端逻辑单元测试：
//  - chatEnded 投影订阅 → pendingInteraction 发布/撤销（ended 观察器）
//  - conversation.composer chain select 契约（pendingInteraction 命中才接管）
//  - settings.section 独立标签注册（id/label/order）
//  - startNewChat：sessions.create + uiWorkspace.openSession
//  - 纯 HTTP 状态快照缓存（stub fetch 喂 GET /_dsh/claude/status）
// 用法：node test/client.test.mjs

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail}`); }
}

// ── 加载浏览器 bundle ─────────────────────────────────────────────────
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { loaded = entry; },
  },
};
const reactStub = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (v) => v };
await import(new URL("../lib/client.js", import.meta.url).href);
check("bundle loaded", loaded !== null && typeof loaded.factory === "function");

const mod = loaded.factory((name) => {
  if (name === "react") return reactStub;
  throw new Error(`unexpected require: ${name}`);
});
check(
  "inject declares 0.2.x services",
  Array.isArray(mod.inject)
    && mod.inject.includes("slots")
    && mod.inject.includes("sessions")
    && mod.inject.includes("uiSession")
    && mod.inject.includes("uiWorkspace")
    && mod.inject.includes("workspaces"),
  JSON.stringify(mod.inject)
);

// ── stub fetch：喂状态快照 ────────────────────────────────────────────
let fetchCalls = 0;
const snapshotValue = {
  settings: { value: { enabled: false, regionTarget: "cn", refusalEndsAfter: 3 }, revision: 0, writable: true },
  verdict: { region: "cn", blocked: true, score: 2, signals: [{ name: "tz_cn", weight: 2, detail: "Asia/Shanghai" }], blacklistHits: [], ip: null },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls++;
  if (String(url).includes("/_dsh/claude/status")) {
    return { ok: true, json: async () => ({ ok: true, value: snapshotValue }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// ── 可控投影 face ─────────────────────────────────────────────────────
function makeFace(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    set: (next) => {
      value = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

// ── 组装 fake ctx ─────────────────────────────────────────────────────
const registrations = [];
const published = []; // { interaction, delegate, active }
const created = [];
const opened = [];
const faces = { s1: makeFace(undefined) };
const sessionIds = ["s1"];
const listListeners = new Set();
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  slots: {
    inject: (name, fn) => { fn(); },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: Object.fromEntries(sessionIds.map((id) => [id, { id }])) }),
      subscribe: (fn) => {
        listListeners.add(fn);
        return () => { listListeners.delete(fn); };
      },
    },
    binding: (id) => (sessionIds.includes(id)
      ? { sessionId: id, session: { projections: { faceOf: (key) => faces[id] ?? makeFace(undefined) } } }
      : undefined),
    create: async (opts) => {
      created.push(opts);
      return "s2";
    },
  },
  uiSession: {
    registerPendingInteraction: (precedence) => {
      ctx.__precedence = precedence;
      return (interaction, delegate) => {
        const entry = { interaction, delegate, active: true };
        published.push(entry);
        return () => { entry.active = false; };
      };
    },
  },
  uiWorkspace: {
    openSession: (id) => { opened.push(id); },
  },
  workspaces: {
    list: {
      getSnapshot: () => ({ items: [{ workspaceId: "w1", sessionIds: ["s1"] }] }),
    },
  },
};
mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 30)); // 等后台状态快照 fetch 落定

const composerEntry = registrations.find((r) => r.options.name === "conversation.composer");
check("composer chain entry registered", composerEntry !== undefined);
check("composer entry priority 0", composerEntry?.options.priority === 0);

const sectionEntry = registrations.find((r) => r.options.name === "settings.section" && r.options.id === "claude");
check("settings.section entry registered (independent tab)", sectionEntry !== undefined);
check("settings.section label is Claude 风控", typeof sectionEntry?.options.label === "function" && sectionEntry.options.label() === "Claude 风控");
check("settings.section order 20", sectionEntry?.options.order === 20);

check("status snapshot fetched at apply", fetchCalls >= 1);
check("pending domain precedence beats questions (3)", typeof ctx.__precedence === "function" && ctx.__precedence({}) === 3);

// ── ended 观察器：投影 → pendingInteraction ───────────────────────────
check("no publish before projection data", published.length === 0);

faces.s1.set({ ended: true, reason: "abuse" });
check("ended projection → published", published.length === 1 && published[0].active === true, JSON.stringify(published.map((p) => p.interaction)));
check(
  "published interaction shape",
  published[0]?.interaction.kind === "claude-chat-ended"
    && published[0]?.interaction.sessionId === "s1"
    && published[0]?.interaction.reason === "abuse"
    && typeof published[0]?.interaction.key === "string",
  JSON.stringify(published[0]?.interaction)
);

// 重复通知不重复发布（同 key 只发一次）
faces.s1.set({ ended: true, reason: "abuse" });
check("repeat notify: no duplicate publish", published.length === 1);

// ended 消失 → 撤销
faces.s1.set({ ended: false, reason: "" });
check("projection cleared → unpublished", published[0].active === false);

// region 结束 → reason=region
faces.s1.set({ ended: true, reason: "region" });
const live = published.filter((p) => p.active);
check("region end → live publish reason=region", live.length === 1 && live[0].interaction.reason === "region", JSON.stringify(live.map((p) => p.interaction)));

// 会话移除 → 撤销 + 解订阅
sessionIds.length = 0;
for (const fn of [...listListeners]) fn();
check("session removed → unpublished", live[0].active === false);

// ── select 契约 ───────────────────────────────────────────────────────
const select = composerEntry.options.select;
check("no pendingInteraction → null", select({}) === null);
check("other kind → null", select({ pendingInteraction: { kind: "user-question", key: "q1", sessionId: "s1" } }) === null);
check("missing owner → null", select(undefined) === null);
const matched = select({ pendingInteraction: { kind: "claude-chat-ended", key: "claude-ended:s1", sessionId: "s1", reason: "harmful" } });
check("claude ended → matched (itself)", matched !== null && matched.reason === "harmful", JSON.stringify(matched));

// ── startNewChat：同 workspace 建新会话并打开 ──────────────────────────
sessionIds.push("s1");
const injected = composerEntry.options.inject("s1");
check("inject face exposes startNewChat", typeof injected?.startNewChat === "function");
await injected.startNewChat();
check("startNewChat creates in same workspace", created.length === 1 && created[0]?.workspaceId === "w1", JSON.stringify(created));
check("startNewChat opens via uiWorkspace", opened.length === 1 && opened[0] === "s2", JSON.stringify(opened));

globalThis.fetch = originalFetch;

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILURES"}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
