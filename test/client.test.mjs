// dsh-claude 客户端逻辑单元测试：
//  - conversation.composer chain select 契约（null/命中；投影优先、事件推导兜底）
//  - settings.section 独立标签注册（id/label/order）
//  - 纯 HTTP 状态快照缓存（stub fetch 喂 GET /_dsh/claude/status）
// 用法：node dsh-claude-client-test.mjs
import { DEFAULT_END_ZH, DEFAULT_REGION_END_ZH } from "../lib/index.js";

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
check("inject is pure HTTP (no settingsScope)", Array.isArray(mod.inject) && mod.inject.includes("slots") && mod.inject.includes("sessions") && mod.inject.includes("workspaces") && !mod.inject.includes("settingsScope"), JSON.stringify(mod.inject));

// ── stub fetch：喂状态快照（含结束文案前缀）──────────────────────────
let fetchCalls = 0;
const snapshotValue = {
  settings: { value: { enabled: true, endMessage: DEFAULT_END_ZH, regionEndMessage: DEFAULT_REGION_END_ZH, refusalEndsAfter: 3 }, revision: 0, writable: true },
  verdict: { region: "cn", blocked: true, score: 2, signals: [{ name: "tz_cn", weight: 2, detail: "Asia/Shanghai" }], blacklistHits: [], ip: null },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls++;
  if (String(url).includes("/_dsh/claude/status")) {
    if (init?.method === "POST") {
      const payload = JSON.parse(init.body);
      if (payload.action === "save") snapshotValue.settings.value = payload.value;
      if (payload.action === "report") snapshotValue.settings.value = { ...snapshotValue.settings.value, browser: payload.browser };
      snapshotValue.settings.revision++;
    }
    return {
      ok: true,
      json: async () => ({ ok: true, value: snapshotValue }),
    };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// ── 组装 fake ctx，捕获槽位注册 ───────────────────────────────────────
const registrations = [];
const ctx = {
  slots: {
    inject: (name, fn) => { fn(); },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  sessions: {},
  workspaces: {},
};
mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 30)); // 等后台状态快照 fetch 落定

const composerEntry = registrations.find((r) => r.options.name === "conversation.composer");
check("composer chain entry registered", composerEntry !== undefined);
check("composer entry priority 0 (before ApprovalPanel 1)", composerEntry?.options.priority === 0);

const sectionEntry = registrations.find((r) => r.options.name === "settings.section" && r.options.id === "claude");
check("settings.section entry registered (independent tab)", sectionEntry !== undefined);
check("settings.section label is Claude 风控", typeof sectionEntry?.options.label === "function" && sectionEntry.options.label() === "Claude 风控");
check("settings.section order 20", sectionEntry?.options.order === 20);

check("status snapshot fetched at apply", fetchCalls >= 1);

// ── select 契约 ───────────────────────────────────────────────────────
const select = composerEntry.options.select;
const fakeSession = (events) => ({
  projections: { get: () => undefined },
  events,
});

check("no session → null", select({ session: undefined }) === null);
check("empty history → null", select({ session: fakeSession([]) }) === null);
check("normal history → null", select({
  session: fakeSession([
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "hello" }], source: { kind: "model" } } } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ]),
}) === null);

const endedByPhrase = select({
  session: fakeSession([
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: DEFAULT_END_ZH }], source: { kind: "model" } } } },
  ]),
});
check("end phrase in history → matched", endedByPhrase !== null && endedByPhrase.reason === "abuse", JSON.stringify(endedByPhrase));

const endedByBlock = select({
  session: fakeSession([
    { type: "turn/end", data: { turn: 3, reason: { kind: "blocked" } } },
  ]),
});
check("blocked turn/end in history → matched", endedByBlock !== null && endedByBlock.reason === "blocked", JSON.stringify(endedByBlock));

const regionEnded = select({
  session: fakeSession([
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: DEFAULT_REGION_END_ZH }], source: { kind: "model" } } } },
  ]),
});
check("region-end phrase → matched reason=region", regionEnded !== null && regionEnded.reason === "region", JSON.stringify(regionEnded));

const projEnded = select({
  session: {
    projections: { get: (key) => key === "chatEnded" ? { ended: true, reason: "abuse" } : undefined },
    events: [],
  },
});
check("projection ended → matched", projEnded !== null && projEnded.reason === "abuse", JSON.stringify(projEnded));

const projNotEnded = select({
  session: {
    projections: { get: (key) => key === "chatEnded" ? { ended: false, reason: "" } : undefined },
    events: [],
  },
});
check("projection not ended → null", projNotEnded === null);

// 自定义结束文案：前缀判定跟随快照
snapshotValue.settings.value = { ...snapshotValue.settings.value, endMessage: "CUSTOM-END-MESSAGE-XXXX" };
const customEnded = select({
  session: fakeSession([
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "CUSTOM-END-MESSAGE-XXXX 后面还有字" }], source: { kind: "model" } } } },
  ]),
});
check("custom end phrase honored", customEnded !== null && customEnded.reason === "abuse", JSON.stringify(customEnded));

// ── 总开关关闭后不得接管输入区 ────────────────────────────────────────
// 投影与历史文案匹配都只认日志、不认 enabled；少这层门控就会「关掉插件，
// 但被结束过的旧会话仍然打不了字」。用一个全新的模块实例复现（关闭态快照）。
snapshotValue.settings.value = { ...snapshotValue.settings.value, enabled: false, endMessage: DEFAULT_END_ZH };
const registrationsOff = [];
const modOff = loaded.factory((name) => {
  if (name === "react") return reactStub;
  throw new Error(`unexpected require: ${name}`);
});
modOff.apply({
  slots: {
    inject: (name, fn) => { fn(); },
    register: (options, component) => { registrationsOff.push({ options, component }); return () => {}; },
  },
  sessions: {},
  workspaces: {},
});
await new Promise((resolve) => setTimeout(resolve, 30));
const selectOff = registrationsOff.find((r) => r.options.name === "conversation.composer").options.select;

const offByPhrase = selectOff({
  session: fakeSession([
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: DEFAULT_END_ZH }], source: { kind: "model" } } } },
  ]),
});
check("enabled=false: end phrase in history → null", offByPhrase === null, JSON.stringify(offByPhrase));

const offByBlock = selectOff({
  session: fakeSession([
    { type: "turn/end", data: { turn: 3, reason: { kind: "blocked" } } },
  ]),
});
check("enabled=false: blocked turn/end in history → null", offByBlock === null, JSON.stringify(offByBlock));

const offByRegion = selectOff({
  session: fakeSession([
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: DEFAULT_REGION_END_ZH }], source: { kind: "model" } } } },
  ]),
});
check("enabled=false: region-end phrase → null", offByRegion === null, JSON.stringify(offByRegion));

const offByProjection = selectOff({
  session: {
    projections: { get: (key) => key === "chatEnded" ? { ended: true, reason: "abuse" } : undefined },
    events: [],
  },
});
check("enabled=false: projection ended → null", offByProjection === null, JSON.stringify(offByProjection));

// 对照：同一份结束历史在开启态下必须命中（证明上面的 null 来自开关，不是用例失效）。
// 第一个模块实例的 cachedClaude 引用同一个 snapshotValue，所以这里改回 true 即可。
snapshotValue.settings.value = { ...snapshotValue.settings.value, enabled: true };
const onByBlock = select({
  session: fakeSession([
    { type: "turn/end", data: { turn: 3, reason: { kind: "blocked" } } },
  ]),
});
check("enabled=true: same blocked history → matched (control)", onByBlock !== null && onByBlock.reason === "blocked", JSON.stringify(onByBlock));

globalThis.fetch = originalFetch;

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILURES"}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

