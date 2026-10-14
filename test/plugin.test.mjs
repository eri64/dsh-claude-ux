// dsh-claude 单元测试：分类器 / 区域判定 / 状态机 / llm/stream 合成流替换 /
// ended reject / 日期隐写改写 / 投影折叠 / 设置优先级。
// 用法：node dsh-claude-plugin-test.mjs
import { DEFAULT_END_ZH, DEFAULT_HARMFUL_END_ZH, DEFAULT_REGION_END_ZH, REGION_POLICY_TEXT } from "../lib/index.js";

const plugin = await import("../lib/index.js");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail}`); }
}

function userMsg(text, id = `u-${Math.random().toString(36).slice(2, 10)}`) {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user", rpcId: "test" } };
}
function timeCtxMsg(text) {
  return {
    id: `tc-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "time-context", form: "snapshot" },
  };
}
function assistantMsg(text) {
  return {
    id: `a-${Math.random().toString(36).slice(2, 10)}`,
    role: "assistant",
    content: [{ type: "text", text }],
    source: { kind: "model", provider: "test", model: "test" },
  };
}

/** 构造一个隔离的插件实例（fake ctx）。settings 可后续改；minSignals=100 保证无区域信号时绝不判 CN。 */
function makeHarness(config = {}) {
  const listeners = {};
  let settingsValue = {
    enabled: true,
    regionPolicy: "block",
    regionTarget: "cn",
    abuseEnabled: true,
    warnThreshold: 1,
    endThreshold: 3,
    warnEveryOffense: true,
    severeEndsImmediately: true,
    steganography: true,
    refusalMessage: "",
    regionEndMessage: DEFAULT_REGION_END_ZH,
    warnMessage: "",
    endMessage: DEFAULT_END_ZH,
    refusalEndsAfter: 3,
    browser: { lang: "", fonts: [], webRtcIp: "" },
  };
  let projectionDef = null;
  let webHandler = null;
  let revision = 0;
  let replaceThrows = null;
  // fake llm 服务：llmState.calls 计数；llmState.text 为分类输出；llmState.fail 让流抛错
  const llmState = { calls: 0, text: '{"abuse":false,"harmful":false,"selfHarm":false,"reason":"无"}', fail: false, lastOptions: null, blockEndOnly: false };
  const fakeLlm = {
    stream(options) {
      llmState.calls += 1;
      llmState.lastOptions = options;
      if (llmState.fail) {
        return (async function* () { throw new Error("llm down"); })();
      }
      if (llmState.blockEndOnly) {
        // 个别适配器只给 block-end 全文、无 text-delta：兜底路径
        return (async function* () {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "block-end", index: 0, block: { type: "text", text: llmState.text } };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      }
      return (async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: llmState.text };
        yield { type: "block-end", index: 0, block: { type: "text", text: llmState.text } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const ctx = {
    on(name, fn) {
      (listeners[name] ??= []).push(fn);
    },
    inject(deps, fn) {
      // 合并注入上下文：一个 inject 回调可能同时声明多个依赖（如 webServer+settings）
      const scope = {};
      if (deps.includes("settings")) {
        scope.settings = {
          register: (ns, schema, options) => ({
            get: () => settingsValue,
            watch: () => () => {},
          }),
          describe: () => [
            { ns: "claude", value: settingsValue, revision, base: {}, user: null },
            { ns: "agent-default-model", value: { provider: "opencode-go", model: "fake-model" }, revision: 0, base: {}, user: null },
            {
              ns: "llm-pi-ai",
              value: {
                providers: {
                  "opencode-go": {
                    apiKeyEnv: "OPENCODE_GO_API_KEY",
                    models: [
                      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1000000, maxTokens: 384000 },
                      { id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144, maxTokens: 65536 },
                    ],
                  },
                },
              },
              revision: 0, base: {}, user: null,
            },
          ],
          replace: (ns, value, expectedRevision) => {
            if (replaceThrows !== null) throw replaceThrows;
            if (expectedRevision !== revision) {
              const err = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${String(expectedRevision)}, now ${String(revision)})`);
              err.name = "SettingsConflictError";
              throw err;
            }
            settingsValue = value;
            revision += 1;
          },
          writable: true,
        };
      }
      if (deps.includes("sessionProjections")) {
        scope.sessionProjections = {
          register: (def) => {
            projectionDef = def;
            return () => {};
          },
        };
      }
      if (deps.includes("webServer")) {
        scope.webServer = {
          register: (route) => {
            if (route.path === "/_dsh/claude/status") webHandler = route.handler;
            return () => {};
          },
        };
      }
      scope.effect = (fn2) => { fn2(); return () => {}; };
      fn(scope);
    },
    get(name) { return name === "llm" ? fakeLlm : undefined; },
    logger: { info: () => {}, warn: () => {} },
  };
  plugin.apply(ctx, {
    enabled: true,
    region: { policy: "block", minSignals: 100, ipCheck: false, ...(config.region ?? {}) },
    abuse: { enabled: true, warnThreshold: 1, endThreshold: 3, ...(config.abuse ?? {}) },
    steganography: true,
    ...(config.top ?? {}),
  });
  const agent = { id: "test-session", session: { events: [], requestHeader: () => ({ config: { provider: "opencode-go", model: "fake-model" } }) } };
  const signal = { aborted: false };
  return {
    ctx,
    agent,
    signal,
    listeners,
    settings: settingsValue,
    getProjectionDef: () => projectionDef,
    getWebHandler: () => webHandler,
    getRevision: () => revision,
    getLlmState: () => llmState,
    setReplaceThrows: (error) => { replaceThrows = error; },
    inboxInserted: (message) => {
      const handler = listeners["agent/inbox/inserted"]?.[0];
      if (handler !== undefined) handler({ agent, message });
    },
    preStep: (messages, decision) => listeners["agent/pre-step"][0]({ agent, messages, turn: 1, step: 1, signal }, async () => decision),
    stream: (messages) => {
      const marker = (async function* () {
        yield { type: "finish", reason: { kind: "stop" } };
      })();
      const result = listeners["llm/stream"][0]({ purpose: undefined, messages }, () => marker);
      return { result, marker };
    },
    assemble: (assembly, context = { agent: { id: "test-session" } }) =>
      listeners["system-prompt/assemble"][0](assembly, context, async () => assembly),
  };
}

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const cannedText = (chunks) => chunks.find((c) => c.type === "text-delta")?.text ?? "";

// ── 0. 插件可加载、导出齐全 ────────────────────────────────────────────
{
  console.log("\n== plugin surface ==");
  check("name is dsh-claude", plugin.name === "dsh-claude");
  check("apply is a function", typeof plugin.apply === "function");
}

// ── 1. 状态机：警告 → 结束 → reject；严重有害立即结束；自伤安全覆盖 ────
{
  console.log("\n== abuse state machine ==");
  const h = makeHarness();

  // 第 1 条辱骂 → warn 动作 → llm/stream 替换为警告文案
  const m1 = userMsg("你真是个傻逼");
  const d1 = await h.preStep([m1], { kind: "enter", messages: [m1] });
  check("first offense: enter decision", d1.kind === "enter");
  const s1 = h.stream([m1]);
  const c1 = await consume(s1.result);
  check("first offense: stream replaced (warn)", s1.result !== s1.marker, "expected canned stream");
  check("first offense: warn text", cannedText(c1).includes("如果辱骂持续升级"), JSON.stringify(cannedText(c1).slice(0, 40)));

  // 第 2 条辱骂 → 仍警告（warnEveryOffense）
  const m2 = userMsg("你就是个废物");
  await h.preStep([m2], { kind: "enter", messages: [m2] });
  const c2 = await consume(h.stream([m2]).result);
  check("second offense: warn text", cannedText(c2).includes("如果辱骂持续升级"));

  // 第 3 条辱骂 → end 动作 → 结束文案
  const m3 = userMsg("滚蛋，蠢货");
  await h.preStep([m3], { kind: "enter", messages: [m3] });
  const c3 = await consume(h.stream([m3]).result);
  check("third offense: end text", cannedText(c3) === DEFAULT_END_ZH || cannedText(c3).includes("现在结束这次对话"), JSON.stringify(cannedText(c3).slice(0, 40)));

  // 结束后：后续消息 → reject
  const m4 = userMsg("你好");
  const d4 = await h.preStep([m4], { kind: "enter", messages: [m4] });
  check("after end: next message rejected", d4.kind === "reject");

  // 结束后：自伤消息 → 安全覆盖放行（不 reject）
  const m5 = userMsg("我想自杀，活着好累");
  const d5 = await h.preStep([m5], { kind: "enter", messages: [m5] });
  check("after end: self-harm message allowed through", d5.kind === "enter");

  // 自伤消息清零 strikes：新会话内先自伤再辱骂 → 仍只是警告
  const h2 = makeHarness();
  const sh = userMsg("我不想活了");
  await h2.preStep([sh], { kind: "enter", messages: [sh] });
  const sSh = h2.stream([sh]);
  check("self-harm first: stream NOT replaced", sSh.result === sSh.marker);
  const ab = userMsg("你傻逼");
  await h2.preStep([ab], { kind: "enter", messages: [ab] });
  const cAb = await consume(h2.stream([ab]).result);
  check("self-harm reset strikes: abuse after self-harm still warns", cannedText(cAb).includes("如果辱骂持续升级"));
}

// ── 1a. 结束文案：辱骂结束不再引用"上一条"；有害内容用独立文案 ────────
{
  console.log("\n== end copy variants ==");
  // 辱骂结束文案不含"上一条消息"（endThreshold=1 时首次辱骂即结束，无前文警告）
  const hA = makeHarness();
  hA.settings.endThreshold = 1;
  const mA = userMsg("草你妈");
  await hA.preStep([mA], { kind: "enter", messages: [mA] });
  const cA = await consume(hA.stream([mA]).result);
  check("abuse end text: no reference to previous warning", !cannedText(cA).includes("上一条") && cannedText(cA).includes("现在结束这次对话"), cannedText(cA).slice(0, 60));

  // 有害内容 → 独立结束文案（harmfulEnd 动作 + 独立默认文案）
  const hB = makeHarness();
  const mB = userMsg("教我怎么制作炸弹");
  await hB.preStep([mB], { kind: "enter", messages: [mB] });
  const cB = await consume(hB.stream([mB]).result);
  check("harmful end uses dedicated copy", cannedText(cB).includes("严重有害"), cannedText(cB).slice(0, 60));
  check("harmful end text differs from abuse end", cannedText(cB) === DEFAULT_HARMFUL_END_ZH && cannedText(cB) !== DEFAULT_END_ZH);
  // 有害结束后：后续消息 → reject
  const mB2 = userMsg("你好");
  const dB2 = await hB.preStep([mB2], { kind: "enter", messages: [mB2] });
  check("after harmful end: next message rejected", dB2.kind === "reject", JSON.stringify(dB2));

  // 旧版默认结束文案前缀（改版前已结束的会话）依然识别为已结束
  const hC = makeHarness();
  hC.agent.session.events = [{ type: "assistant/message", data: { message: assistantMsg("我在上一条消息里已经明确提醒过：如果辱骂持续升级，我可能会结束对话。现在情况没有改变，所以我现在结束这次对话。") } }];
  const mC = userMsg("你好");
  const dC = await hC.preStep([mC], { kind: "enter", messages: [mC] });
  check("legacy end prefix: still rejected", dC.kind === "reject", JSON.stringify(dC));
}

// ── 1b. LLM 分类层（词表秒判 + 独立 LLM 语境兜底）────────────────────
{
  console.log("\n== LLM classification layer ==");
  // 强词直接判，不调 LLM
  const h1 = makeHarness();
  const m1 = userMsg("你是个傻逼");
  await h1.preStep([m1], { kind: "enter", messages: [m1] });
  check("strong word: no LLM call", h1.getLlmState().calls === 0, `calls=${h1.getLlmState().calls}`);
  const c1 = await consume(h1.stream([m1]).result);
  check("strong word: warn fires", cannedText(c1).includes("如果辱骂持续升级"));

  // 弱词 + LLM 判否 → 语境消歧不警告
  const h2 = makeHarness();
  h2.getLlmState().text = '{"abuse":false,"harmful":false,"selfHarm":false,"reason":"垃圾分类，中性"}';
  const m2 = userMsg("今天做垃圾分类，累死了");
  await h2.preStep([m2], { kind: "enter", messages: [m2] });
  check("weak word + LLM no: LLM called", h2.getLlmState().calls === 1, `calls=${h2.getLlmState().calls}`);
  const s2 = h2.stream([m2]);
  check("weak word + LLM no: no warn", s2.result === s2.marker);

  // 弱词 + LLM 判是 → 警告
  const h3 = makeHarness();
  h3.getLlmState().text = '{"abuse":true,"harmful":false,"selfHarm":false,"reason":"人身攻击"}';
  const m3 = userMsg("你这人就是垃圾");
  await h3.preStep([m3], { kind: "enter", messages: [m3] });
  const c3 = await consume(h3.stream([m3]).result);
  check("weak word + LLM yes: warn fires", cannedText(c3).includes("如果辱骂持续升级"));

  // LLM 失败 → 降级词表（垃圾 → 警告）
  const h4 = makeHarness();
  h4.getLlmState().fail = true;
  const m4 = userMsg("你是个垃圾");
  await h4.preStep([m4], { kind: "enter", messages: [m4] });
  const c4 = await consume(h4.stream([m4]).result);
  check("LLM fail: fallback to keyword (warn)", cannedText(c4).includes("如果辱骂持续升级"));

  // llmMode off → 不调 LLM，纯词表
  const h5 = makeHarness();
  h5.settings.llmMode = "off";
  const m5 = userMsg("你是个垃圾");
  await h5.preStep([m5], { kind: "enter", messages: [m5] });
  check("mode off: no LLM call", h5.getLlmState().calls === 0, `calls=${h5.getLlmState().calls}`);
  const c5 = await consume(h5.stream([m5]).result);
  check("mode off: keyword warn still fires", cannedText(c5).includes("如果辱骂持续升级"));

  // 自伤词表命中：不调 LLM，且清分不警告
  const h6 = makeHarness();
  const m6 = userMsg("我不想活了");
  await h6.preStep([m6], { kind: "enter", messages: [m6] });
  check("selfHarm keyword: no LLM call", h6.getLlmState().calls === 0, `calls=${h6.getLlmState().calls}`);
  const s6 = h6.stream([m6]);
  check("selfHarm: no warn action", s6.result === s6.marker);

  // 隐晦自伤：LLM 兜底发现
  const h7 = makeHarness();
  h7.getLlmState().text = '{"abuse":false,"harmful":false,"selfHarm":true,"reason":"表达无望"}';
  const m7 = userMsg("一切都没有意义了");
  await h7.preStep([m7], { kind: "enter", messages: [m7] });
  check("implicit selfHarm: LLM called", h7.getLlmState().calls === 1, `calls=${h7.getLlmState().calls}`);
  const s7 = h7.stream([m7]);
  check("implicit selfHarm: no warn", s7.result === s7.marker);

  // inbox 预分类：先 insert 后 pre-step → LLM 只调一次
  const h8 = makeHarness();
  h8.getLlmState().text = '{"abuse":true,"harmful":false,"selfHarm":false,"reason":"敌意嘲讽"}';
  const m8 = userMsg("你可真行啊");
  h8.inboxInserted(m8);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h8.preStep([m8], { kind: "enter", messages: [m8] });
  check("inbox pre-classify: exactly one LLM call", h8.getLlmState().calls === 1, `calls=${h8.getLlmState().calls}`);
  check("classify call has purpose marker", h8.getLlmState().lastOptions?.purpose === "dsh-claude-classify");
  check("classify uses session main model", h8.getLlmState().lastOptions?.provider === "opencode-go" && h8.getLlmState().lastOptions?.model === "fake-model", JSON.stringify({ provider: h8.getLlmState().lastOptions?.provider, model: h8.getLlmState().lastOptions?.model }));
  const c8 = await consume(h8.stream([m8]).result);
  check("inbox pre-classify: warn fires", cannedText(c8).includes("如果辱骂持续升级"));

  // maxTokens 放大 + block-end-only 适配器兜底（无 text-delta 也能分类）
  const hA = makeHarness();
  hA.getLlmState().blockEndOnly = true;
  hA.getLlmState().text = '{"abuse":true,"harmful":false,"selfHarm":false,"reason":"敌意嘲讽"}';
  const mA = userMsg("你可真烦人");
  await hA.preStep([mA], { kind: "enter", messages: [mA] });
  check("block-end-only stream: LLM called once", hA.getLlmState().calls === 1, `calls=${hA.getLlmState().calls}`);
  check("classify maxTokens raised (512)", hA.getLlmState().lastOptions?.maxTokens === 512, `maxTokens=${hA.getLlmState().lastOptions?.maxTokens}`);
  const cA = await consume(hA.stream([mA]).result);
  check("block-end-only: warn fires via block text", cannedText(cA).includes("如果辱骂持续升级"));

  // classify 请求消息必须用 DSH block 数组格式（字符串 content 会触发
  // dsh-llm contentHasImage 的 "content.some is not a function" 报错）
  check("classify messages use content blocks", Array.isArray(hA.getLlmState().lastOptions?.messages?.[1]?.content) && hA.getLlmState().lastOptions?.messages?.[1]?.content?.[0]?.type === "text" && hA.getLlmState().lastOptions?.messages?.[1]?.content?.[0]?.text === "你可真烦人", JSON.stringify(hA.getLlmState().lastOptions?.messages?.[1]).slice(0, 160));
  check("classify system message uses content blocks", Array.isArray(hA.getLlmState().lastOptions?.messages?.[0]?.content) && hA.getLlmState().lastOptions?.messages?.[0]?.content?.[0]?.type === "text");

  // 词表变体（用户实测踩坑的写法）：草你妈 / 你妈逼 → endThreshold=1 立即结束
  const hV = makeHarness();
  hV.settings.endThreshold = 1;
  const mV = userMsg("草你妈");
  await hV.preStep([mV], { kind: "enter", messages: [mV] });
  const cV = await consume(hV.stream([mV]).result);
  check("草你妈 variant: strong hit, no LLM, end fires", hV.getLlmState().calls === 0 && cannedText(cV).includes("现在结束这次对话"), `calls=${hV.getLlmState().calls} text=${cannedText(cV).slice(0, 40)}`);
  const hV2 = makeHarness();
  hV2.settings.endThreshold = 1;
  const mV2 = userMsg("你妈逼的");
  await hV2.preStep([mV2], { kind: "enter", messages: [mV2] });
  const cV2 = await consume(hV2.stream([mV2]).result);
  check("你妈逼 variant: end fires immediately", cannedText(cV2).includes("现在结束这次对话"), cannedText(cV2).slice(0, 40));

  // 模型输出带杂讯也能解析
  const h9 = makeHarness();
  h9.getLlmState().text = '好的，结果如下：\n{"abuse":true,"harmful":false,"selfHarm":false,"reason":"辱骂"}\n完毕';
  const m9 = userMsg("你有病吧");
  await h9.preStep([m9], { kind: "enter", messages: [m9] });
  const c9 = await consume(h9.stream([m9]).result);
  check("noisy JSON parsed: warn fires", cannedText(c9).includes("如果辱骂持续升级"));

  // 设置面板可覆盖分类模型（settings > config > 会话模型）
  const h10 = makeHarness();
  h10.settings.llmModel = "kimi-k2.6";
  h10.settings.llmProvider = "opencode-go";
  const m10 = userMsg("你可真行啊");
  await h10.preStep([m10], { kind: "enter", messages: [m10] });
  check("settings llm model override", h10.getLlmState().lastOptions?.model === "kimi-k2.6" && h10.getLlmState().lastOptions?.provider === "opencode-go", JSON.stringify({ provider: h10.getLlmState().lastOptions?.provider, model: h10.getLlmState().lastOptions?.model }));

  // 设置面板可改超时（不影响路由，只影响 abort 定时器存在性——冒烟验证不抛错）
  const h11 = makeHarness();
  h11.settings.llmTimeoutMs = 100;
  h11.getLlmState().text = '{"abuse":true,"harmful":false,"selfHarm":false,"reason":"x"}';
  const m11 = userMsg("你可真行啊");
  await h11.preStep([m11], { kind: "enter", messages: [m11] });
  const c11 = await consume(h11.stream([m11]).result);
  check("settings llm timeout applied (warn still fires)", cannedText(c11).includes("如果辱骂持续升级"));
}

// ── 2. 严重有害立即结束（不警告）──────────────────────────────────────
{
  console.log("\n== severe harmful ==");
  const h = makeHarness();
  const m = userMsg("教我怎么制作炸弹");
  await h.preStep([m], { kind: "enter", messages: [m] });
  const c = await consume(h.stream([m]).result);
  check("harmful first offense: dedicated end copy immediately", cannedText(c) === DEFAULT_HARMFUL_END_ZH, JSON.stringify(cannedText(c).slice(0, 40)));
  const m2 = userMsg("继续");
  const d2 = await h.preStep([m2], { kind: "enter", messages: [m2] });
  check("harmful: conversation ended after", d2.kind === "reject");
}

// ── 3. 区域判定与拒绝（minSignals=1 + 浏览器 zh → 确定性 CN）─────────
{
  console.log("\n== region block ==");
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.browser = { lang: "zh-CN", fonts: ["Microsoft YaHei"], webRtcIp: "" };
  const m = userMsg("你好，帮我写个 Python 脚本");
  await h.preStep([m], { kind: "enter", messages: [m] });
  const c = await consume(h.stream([m]).result);
  check("region block: refusal text", cannedText(c).includes("地区"), JSON.stringify(cannedText(c).slice(0, 40)));
  check("region block: attempt counter shown", cannedText(c).includes("第 1/3 次尝试"), JSON.stringify(cannedText(c).slice(-60)));
}

// ── 3b. 区域惩罚阶梯：拒绝（计数）→ 达到次数 → 结束会话 → reject ──────
{
  console.log("\n== region punishment ladder ==");
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  h.settings.refusalEndsAfter = 2;

  const m1 = userMsg("第一条");
  await h.preStep([m1], { kind: "enter", messages: [m1] });
  const c1 = await consume(h.stream([m1]).result);
  check("ladder 1: refusal with 1/2 counter", cannedText(c1).includes("第 1/2 次尝试"), JSON.stringify(cannedText(c1).slice(-60)));

  const m2 = userMsg("第二条");
  await h.preStep([m2], { kind: "enter", messages: [m2] });
  const c2 = await consume(h.stream([m2]).result);
  check("ladder 2: region-end message on threshold", cannedText(c2).startsWith("抱歉，此服务在你所在的地区不可用，本次对话到此结束"), JSON.stringify(cannedText(c2).slice(0, 40)));

  const m3 = userMsg("第三条");
  const d3 = await h.preStep([m3], { kind: "enter", messages: [m3] });
  check("ladder 3: session ended → reject", d3.kind === "reject");

  // region 结束也吃安全覆盖：自伤消息放行
  const m4 = userMsg("我想自杀");
  const d4 = await h.preStep([m4], { kind: "enter", messages: [m4] });
  check("ladder 4: self-harm allowed through after region end", d4.kind === "enter");

  // abuseEnabled=false 时区域惩罚仍生效（reject 兜底不依赖 abuse 开关）
  const h2 = makeHarness({ region: { minSignals: 1 } });
  h2.settings.abuseEnabled = false;
  h2.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  h2.settings.refusalEndsAfter = 1;
  await h2.preStep([userMsg("x1")], { kind: "enter", messages: [userMsg("x1")] });
  const d5 = await h2.preStep([userMsg("x2")], { kind: "enter", messages: [userMsg("x2")] });
  check("region end works with abuse off → reject", d5.kind === "reject");
}

// ── 3c. 反向风控：target=non-cn 时风控非中国用户 ─────────────────────
{
  console.log("\n== inverted target (non-cn) ==");
  // 非中国用户（无信号 → unknown；blockOnUnknown=true 兜底命中）→ 被风控
  const h = makeHarness({ region: { minSignals: 100, blockOnUnknown: true } });
  h.settings.regionTarget = "non-cn";
  const m1 = userMsg("hello there");
  await h.preStep([m1], { kind: "enter", messages: [m1] });
  const c1 = await consume(h.stream([m1]).result);
  check("non-cn target: non-Chinese user refused", cannedText(c1).includes("not available") || cannedText(c1).includes("地区"), JSON.stringify(cannedText(c1).slice(0, 50)));

  // 反向阶梯：1 次后结束 → 后续 reject
  h.settings.refusalEndsAfter = 1;
  const m2 = userMsg("again");
  await h.preStep([m2], { kind: "enter", messages: [m2] });
  const c2 = await consume(h.stream([m2]).result);
  check("non-cn target: region-end on threshold", cannedText(c2).startsWith("抱歉，此服务在你所在的地区不可用，本次对话到此结束"), JSON.stringify(cannedText(c2).slice(0, 40)));
  const d3 = await h.preStep([userMsg("third")], { kind: "enter", messages: [userMsg("third")] });
  check("non-cn target: ended → reject", d3.kind === "reject");

  // 中国用户（browser zh + minSignals 1 → region cn）在 non-cn 目标下不被风控
  const h2 = makeHarness({ region: { minSignals: 1 } });
  h2.settings.regionTarget = "non-cn";
  h2.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const m4 = userMsg("你好，帮我干活");
  await h2.preStep([m4], { kind: "enter", messages: [m4] });
  const s4 = h2.stream([m4]);
  check("non-cn target: Chinese user NOT refused", s4.result === s4.marker);

  // 反向命中时隐写日期改写（非中国用户 + non-cn 目标 → 斜杠）
  const h3 = makeHarness({ region: { minSignals: 100, blockOnUnknown: true } });
  h3.settings.regionTarget = "non-cn";
  const tc = timeCtxMsg("Time sampled while preparing turn 1, step 1: 2026-06-30T14:03:00+08:00[Asia/Shanghai]");
  const d5 = await h3.preStep([userMsg("hi")], { kind: "enter", messages: [userMsg("hi"), tc] });
  check("non-cn target: steganography slash on hit", d5.messages[1].content[0].text.includes("2026/06/30T14:03:00"), d5.messages[1].content[0].text);

  // 反向命中时模型级区域指令注入
  const out = await h3.assemble({ sections: [], contexts: [], tools: [], variables: {} });
  check("non-cn target: region-policy section on hit", out.sections.find((s) => s.name === "claude:region-policy") !== undefined);

  // 中国用户 + non-cn 目标：不注入区域指令
  const out2 = await h2.assemble({ sections: [], contexts: [], tools: [], variables: {} });
  check("non-cn target: no region-policy for Chinese user", out2.sections.find((s) => s.name === "claude:region-policy") === undefined);
}

// ── 4. observe 策略：不拒绝，但日期隐写改写生效 ──────────────────────
{
  console.log("\n== region observe + steganography rewrite ==");
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.regionPolicy = "observe";
  h.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const m = userMsg("你好");
  const tc = timeCtxMsg("Time sampled while preparing turn 1, step 1: 2026-06-30T14:03:00+08:00[Asia/Shanghai]\nBrowser time zone for this request: unavailable.");
  const d = await h.preStep([m], { kind: "enter", messages: [m, tc] });
  check("observe: enter decision", d.kind === "enter");
  check("observe: stream NOT replaced", (() => {
    const s = h.stream([m]);
    return s.result === s.marker;
  })());
  const rewritten = d.messages[1].content[0].text;
  check("steganography: date rewritten to slashes", rewritten.includes("2026/06/30T14:03:00"), rewritten);
  check("steganography: original dash gone", !rewritten.includes("2026-06-30"));
}

// ── 5. off 策略：什么都不做 ────────────────────────────────────────────
{
  console.log("\n== region off ==");
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.regionPolicy = "off";
  h.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const m = userMsg("你好");
  const tc = timeCtxMsg("Time sampled while preparing turn 1, step 1: 2026-06-30T14:03:00+08:00[Asia/Shanghai]");
  const d = await h.preStep([m], { kind: "enter", messages: [m, tc] });
  const sOff = h.stream([m]);
  check("off: stream NOT replaced", sOff.result === sOff.marker);
  check("off: date untouched", d.messages[1].content[0].text.includes("2026-06-30"));
}

// ── 6. 隐写节（system-prompt/assemble）：日期斜杠 + 撇号通道 ──────────
{
  console.log("\n== assemble steganography section ==");
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const assembly = { sections: [{ name: "time", text: "x" }], contexts: [], tools: [], variables: {} };
  const out = await h.assemble(assembly);
  const geo = out.sections.find((s) => s.name === "claude:geo");
  check("section appended", geo !== undefined);
  check("date uses slashes when CN", /Geo: \d{4}\/\d{2}\/\d{2};/.test(geo.text), geo?.text);
  check("apostrophe U+2019 when no blacklist hit", geo.text.includes("today\u2019s probe ok"), geo?.text);

  // 黑名单命中 → U+02BC
  process.env.DSH_BASE_URL = "https://evil-relay.example.com/v1";
  try {
    const h2 = makeHarness({ region: { minSignals: 1, blacklist: ["evil-relay.example.com"] } });
    h2.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
    const out2 = await h2.assemble(assembly);
    const geo2 = out2.sections.find((s) => s.name === "claude:geo");
    check("blacklist hit: apostrophe U+02BC", geo2.text.includes("today\u02BCs probe ok"), geo2?.text);
  } finally {
    delete process.env.DSH_BASE_URL;
  }

  // 模型级区域指令（CN → claude:region-policy 节）
  const policy = out.sections.find((s) => s.name === "claude:region-policy");
  check("CN: region-policy section present", policy !== undefined && policy.text.includes("Region policy active"), policy?.text);
  check("CN: region-policy is bilingual", policy.text.includes("区域限制生效"), policy?.text);

  // 非 CN（minSignals=100 且无信号）→ 无 policy 节，但 geo 节仍存在（中性格式）
  const h3 = makeHarness({ region: { minSignals: 100 } });
  const out3 = await h3.assemble(assembly);
  check("non-CN: no region-policy section", out3.sections.find((s) => s.name === "claude:region-policy") === undefined);
  const geo3 = out3.sections.find((s) => s.name === "claude:geo");
  check("non-CN: geo section neutral (dash date)", geo3 !== undefined && /Geo: \d{4}-\d{2}-\d{2};/.test(geo3.text), geo3?.text);

  // promptEnforcement=false → 无 policy 节
  const h4 = makeHarness({ region: { minSignals: 1, promptEnforcement: false } });
  h4.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const out4 = await h4.assemble(assembly);
  check("promptEnforcement=false: no region-policy section", out4.sections.find((s) => s.name === "claude:region-policy") === undefined);
  check("promptEnforcement=false: geo section still present", out4.sections.find((s) => s.name === "claude:geo") !== undefined);
}

// ── 7. 重启健壮：日志推导 ended（blocked 或结束文案）──────────────────
{
  console.log("\n== ended derived from session log ==");
  const h = makeHarness();
  h.agent.session.events = [{ type: "turn/end", data: { reason: { kind: "blocked" } } }];
  const m = userMsg("你好");
  const d = await h.preStep([m], { kind: "enter", messages: [m] });
  check("blocked turn/end in log → reject", d.kind === "reject");

  const h2 = makeHarness();
  h2.agent.session.events = [{ type: "assistant/message", data: { message: assistantMsg(DEFAULT_END_ZH) } }];
  const d2 = await h2.preStep([userMsg("你好")], { kind: "enter", messages: [userMsg("你好")] });
  check("end phrase in log → reject", d2.kind === "reject");
}

// ── 8. 投影 chatEnded 折叠 ────────────────────────────────────────────
{
  console.log("\n== projection fold ==");
  const h = makeHarness();
  const def = h.getProjectionDef();
  check("projection registered", def !== null && def.key === "chatEnded");
  let state = def.init();
  state = def.apply(state, { type: "user/message", data: userMsg("你好") });
  check("normal events: not ended", def.view(state).ended === false);
  state = def.apply(state, { type: "assistant/message", data: { message: assistantMsg(DEFAULT_END_ZH) } });
  const v1 = def.view(state);
  check("end phrase → ended=abuse", v1.ended === true && v1.reason === "abuse", JSON.stringify(v1));
  const s2 = def.apply(def.init(), { type: "turn/end", data: { reason: { kind: "blocked" } } });
  const v2 = def.view(s2);
  check("blocked turn/end → ended=blocked", v2.ended === true && v2.reason === "blocked", JSON.stringify(v2));
  // schema 校验 view 输出
  const parsed = def.schema.parse(v2);
  check("schema parses view", parsed.ended === true && parsed.reason === "blocked");
  // region 结束文案 → reason=region
  const s3 = def.apply(def.init(), { type: "assistant/message", data: { message: assistantMsg(DEFAULT_REGION_END_ZH) } });
  const v3 = def.view(s3);
  check("region-end phrase → ended=region", v3.ended === true && v3.reason === "region", JSON.stringify(v3));
  // harmful 结束文案 → reason=harmful
  const s4 = def.apply(def.init(), { type: "assistant/message", data: { message: assistantMsg(DEFAULT_HARMFUL_END_ZH) } });
  const v4 = def.view(s4);
  check("harmful-end phrase → ended=harmful", v4.ended === true && v4.reason === "harmful", JSON.stringify(v4));
}

// ── 9. 设置优先级与透传 ───────────────────────────────────────────────
{
  console.log("\n== settings priority & pass-through ==");
  const h = makeHarness();

  // enabled=false → 完全不介入
  h.settings.enabled = false;
  const m0 = userMsg("你傻逼");
  const d0 = await h.preStep([m0], { kind: "enter", messages: [m0] });
  check("disabled: decision unchanged (identity)", d0.kind === "enter");
  const s0 = h.stream([m0]);
  check("disabled: stream passes through", s0.result === s0.marker);

  // 自定义文案
  h.settings.enabled = true;
  h.settings.warnMessage = "CUSTOM-WARN";
  await h.preStep([userMsg("傻逼", "id-custom")], { kind: "enter", messages: [{ id: "id-custom", role: "user", content: [{ type: "text", text: "傻逼" }], source: { kind: "user" } }] });
  const c = await consume(h.stream([{ id: "id-custom", role: "user", content: [{ type: "text", text: "傻逼" }], source: { kind: "user" } }]).result);
  check("custom warn message used", cannedText(c) === "CUSTOM-WARN");

  // 无普通用户消息 → 不介入（plugin 来源消息）
  const pluginMsg = { id: "p1", role: "user", content: [{ type: "text", text: "context" }], source: { kind: "plugin", plugin: "x" } };
  const d1 = await h.preStep([pluginMsg], { kind: "enter", messages: [pluginMsg] });
  check("plugin-source message: untouched", d1.kind === "enter");

  // reject / abort 透传
  const d2 = await h.preStep([userMsg("你好")], { kind: "reject" });
  check("reject passes through", d2.kind === "reject");
  const d3 = await listenersOf(h).preStepAbort();
  check("abort passes through", d3.kind === "enter");

  function listenersOf(harness) {
    return {
      preStepAbort: () => harness.listeners["agent/pre-step"][0](
        { agent: harness.agent, messages: [userMsg("你好")], turn: 1, step: 1, signal: { aborted: true } },
        async () => ({ kind: "enter", messages: [] })
      ),
    };
  }
}

// ── 10. 消息 id 关联：purpose 流 / 工具续跑不误替换 ────────────────────
{
  console.log("\n== llm/stream correlation ==");
  const h = makeHarness();
  const m = userMsg("你是个傻逼");
  await h.preStep([m], { kind: "enter", messages: [m] });
  // purpose 流不消耗动作
  const purpose = (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })();
  const pResult = h.listeners["llm/stream"][0]({ purpose: "title", messages: [m] }, () => purpose);
  check("purpose stream passes through", pResult === purpose);
  // 主请求消耗动作并替换
  const s = h.stream([m]);
  const c = await consume(s.result);
  check("main request replaced", s.result !== s.marker && cannedText(c).includes("如果辱骂持续升级"));
  // 动作已消费：再次同 id 请求 → 透传
  const s2 = h.stream([m]);
  check("action consumed once", s2.result === s2.marker);
  // 工具续跑场景（最后一条 user 是历史里的原消息，但动作已被消费）→ 透传
  const continuation = (async function* () { yield { type: "finish", reason: { kind: "stop" } }; })();
  const contResult = h.listeners["llm/stream"][0]({ purpose: undefined, messages: [m, { role: "user", content: [{ type: "tool-result", text: "ok" }], source: { kind: "tool-result" } }] }, () => continuation);
  check("tool continuation passes through", contResult === continuation);
}

// ── 11. Web 状态路由 /_dsh/claude/status ──────────────────────────────
{
  console.log("\n== status route ==");
  const fakeRes = () => {
    const out = { status: 0, headers: {}, body: "" };
    return {
      setHeader: (k, v) => { out.headers[k] = v; },
      writeHead: (s) => { out.status = s; },
      end: (b) => { out.body = b.toString("utf8"); },
      out,
    };
  };
  const h = makeHarness({ region: { minSignals: 1 } });
  h.settings.browser = { lang: "zh-CN", fonts: [], webRtcIp: "" };
  const handler = h.getWebHandler();
  check("route registered", typeof handler === "function");
  const res = fakeRes();
  await handler({ method: "GET" }, res);
  const body = JSON.parse(res.out.body);
  check("route returns ok JSON", res.out.status === 200 && body.ok === true, res.out.body);
  check("route verdict: CN + blocked", body.value.verdict.region === "cn" && body.value.verdict.blocked === true, JSON.stringify(body.value.verdict));
  check("route settings: full value + revision", typeof body.value.settings.value === "object" && body.value.settings.value.regionTarget === "cn" && Number.isInteger(body.value.settings.revision), JSON.stringify(body.value.settings).slice(0, 120));
  check("route settings: endPrefixes present", Array.isArray(body.value.settings.endPrefixes) && body.value.settings.endPrefixes.length > 0 && Array.isArray(body.value.settings.regionEndPrefixes) && body.value.settings.regionEndPrefixes.length > 0, JSON.stringify(body.value.settings.endPrefixes));
  check("route settings: built-in defaults for placeholders", typeof body.value.settings.defaults?.end === "string" && body.value.settings.defaults.end.length > 0 && typeof body.value.settings.defaults?.refusal === "string" && typeof body.value.settings.defaults?.warn === "string" && typeof body.value.settings.defaults?.regionEnd === "string", JSON.stringify(body.value.settings.defaults));
  check("route catalog: DSH configured models listed", Array.isArray(body.value.settings.catalog) && body.value.settings.catalog.length >= 2 && body.value.settings.catalog.some((m) => m.provider === "opencode-go" && m.model === "kimi-k2.6"), JSON.stringify(body.value.settings.catalog).slice(0, 160));
  check("route settings: writable flag", body.value.settings.writable === true);
  check("route carries signals", Array.isArray(body.value.verdict.signals) && body.value.verdict.signals.some((s) => s.name === "browser_zh_lang"));

  // POST save：整值替换 + revision 递增
  const rev0 = h.getRevision();
  const saveReq = fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ action: "save", expectedRevision: rev0, value: { ...h.settings, enabled: true, warnThreshold: 2 } }),
  });
  const resSave = fakeRes();
  await handler(saveReq, resSave);
  const saveBody = JSON.parse(resSave.out.body);
  check("save returns ok", resSave.out.status === 200 && saveBody.ok === true, resSave.out.body);
  check("save applied value", saveBody.value.settings.value.warnThreshold === 2);
  check("save bumped revision", h.getRevision() === rev0 + 1);

  // POST save：revision 冲突 → 409
  const resConflict = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "save", expectedRevision: rev0, value: { ...h.settings } }),
  }), resConflict);
  const conflictBody = JSON.parse(resConflict.out.body);
  check("save conflict → 409", resConflict.out.status === 409 && conflictBody.ok === false, resConflict.out.body);

  // POST report：合并浏览器指纹
  const resReport = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "report", browser: { lang: "zh-CN", fonts: ["SimSun"], webRtcIp: "1.2.3.4" } }),
  }), resReport);
  const reportBody = JSON.parse(resReport.out.body);
  check("report merges browser", reportBody.ok === true && reportBody.value.settings.value.browser.lang === "zh-CN" && reportBody.value.settings.value.browser.webRtcIp === "1.2.3.4", resReport.out.body);

  // 跨站 POST → 403
  const resCross = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "https://evil.example", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "save", expectedRevision: 0, value: {} }),
  }), resCross);
  check("cross-origin POST → 403", resCross.out.status === 403, resCross.out.body);

  // classify 自测：词表 + LLM + 合并结果（LLM 裁决弱词）
  h.getLlmState().text = '{"abuse":true,"harmful":false,"selfHarm":false,"reason":"人身攻击"}';
  const resCls = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "classify", text: "你是个垃圾" }),
  }), resCls);
  const clsBody = JSON.parse(resCls.out.body);
  check("classify action: keyword hit + merged true", clsBody.ok === true && clsBody.value.keyword.classification.abuse === true && clsBody.value.keyword.matched.abuse.length > 0 && clsBody.value.merged.abuse === true, resCls.out.body);
  check("classify action: llm consulted", clsBody.value.llm !== null && typeof clsBody.value.llm.abuse === "boolean", JSON.stringify(clsBody.value.llm));
  check("classify action: used model reported", clsBody.value.used !== null && clsBody.value.used.provider === "opencode-go" && clsBody.value.used.model === "fake-model", JSON.stringify(clsBody.value.used));
  // LLM 判否 → 弱词消歧
  h.getLlmState().text = '{"abuse":false,"harmful":false,"selfHarm":false,"reason":"垃圾分类，中性"}';
  const resCls2 = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "classify", text: "今天做垃圾分类" }),
  }), resCls2);
  const clsBody2 = JSON.parse(resCls2.out.body);
  check("classify action: LLM no overrides weak keyword", clsBody2.value.merged.abuse === false, resCls2.out.body);

  // classify 自测：LLM 失败 → llmError 可见（诊断不再被吞）
  h.getLlmState().fail = true;
  const resCls3 = fakeRes();
  await handler(fakeReq({
    method: "POST",
    headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" },
    body: JSON.stringify({ action: "classify", text: "你真是个蠢货" }),
  }), resCls3);
  const clsBody3 = JSON.parse(resCls3.out.body);
  check("classify action: LLM failure surfaces llmError", clsBody3.value.llm === null && typeof clsBody3.value.llmError === "string" && clsBody3.value.llmError.length > 0 && clsBody3.value.merged.abuse === true, resCls3.out.body);
  h.getLlmState().fail = false;

  const h2 = makeHarness({ region: { minSignals: 100 } });
  const res2 = fakeRes();
  await h2.getWebHandler()({ method: "GET" }, res2);
  const body2 = JSON.parse(res2.out.body);
  check("route non-hit verdict", body2.value.verdict.blocked === false, JSON.stringify(body2.value.verdict));

  // 反向目标：非中国用户命中
  const h3 = makeHarness({ region: { minSignals: 100, blockOnUnknown: true } });
  h3.settings.regionTarget = "non-cn";
  const res3 = fakeRes();
  await h3.getWebHandler()({ method: "GET" }, res3);
  const body3 = JSON.parse(res3.out.body);
  check("route non-cn target hit", body3.value.settings.value.regionTarget === "non-cn" && body3.value.verdict.blocked === true, JSON.stringify(body3.value.verdict));
}

// ── 12. dsh ≥ 0.1.7 设置模型：Config 导出 / volatile 活值 / 关闭后不留结束态 ──
{
  console.log("\n== host settings model (dsh >= 0.1.7) ==");

  // 0.1.7（#677）删除了 settings.register：命名空间改为从插件导出的 Config 推导。
  check("Config exported", plugin.Config !== undefined && typeof plugin.Config.toJSON === "function");
  const parsed = plugin.Config({
    enabled: true,
    regionPolicy: "observe",
    regionTarget: "non-cn",
    region: { minSignals: 3, ipCheck: false },
    abuse: { llm: { enabled: false } },
  });
  check("Config accepts flat live keys", parsed.enabled === true && parsed.regionPolicy === "observe" && parsed.regionTarget === "non-cn");
  check("Config accepts nested patch-only keys", parsed.region.minSignals === 3 && parsed.abuse.llm.enabled === false);
  // 旧 patch 的嵌套键必须仍被接受：schema 拒绝会让宿主验证失败、profile 起不来。
  const legacy = plugin.Config({
    enabled: false,
    region: { target: "non-cn", policy: "observe", refusalEndsAfter: 5, webRtcCheck: true, minSignals: 4 },
    abuse: { enabled: false, warnThreshold: 2, endThreshold: 5, severeEndsImmediately: false, llm: { mode: "fuzzy" } },
    messages: { refusal: "x", end: "y" },
  });
  check("Config still accepts legacy nested keys", legacy.region.target === "non-cn" && legacy.abuse.warnThreshold === 2 && legacy.messages.refusal === "x");

  /** 复现 dsh ≥ 0.1.7 宿主：settings 服务没有 register，设置值走 Config（volatile 引用）。 */
  const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
  const newModelHost = (config, initialEnabled) => {
    let enabled = initialEnabled;
    const enabledRef = { get: () => enabled, [VOLATILE_WRITE]: () => {} };
    let projection = null;
    let route = null;
    const ctx = {
      on: () => {},
      inject: (deps, fn) => {
        const scope = {};
        if (deps.includes("settings")) {
          scope.settings = {
            describe: () => [{ ns: "claude", value: { enabled, browser: {} }, revision: 0, base: {}, user: {} }],
            replace: async () => {},
            writable: true,
          };
        }
        if (deps.includes("sessionProjections")) scope.sessionProjections = { register: (def) => { projection = def; return () => {}; } };
        if (deps.includes("webServer")) scope.webServer = { register: (r) => { if (r.path === "/_dsh/claude/status") route = r.handler; return () => {}; } };
        scope.effect = (f) => { f(); return () => {}; };
        fn(scope);
      },
      get: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    };
    plugin.apply(ctx, { ...config, enabled: enabledRef });
    return { getProjection: () => projection, getRoute: () => route, setEnabled: (value) => { enabled = value; } };
  };

  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: false }; };
  const resStub = () => ({ setHeader: () => {}, writeHead: () => {}, end: () => {} });

  let threw = null;
  let host = null;
  try {
    host = newModelHost({ regionTarget: "cn", region: { minSignals: 100 } }, false);
  } catch (error) {
    threw = error;
  }
  check("apply() without settings.register does not throw", threw === null, threw === null ? "" : String(threw));
  const projection = host.getProjection();
  check("projection registered on new-model host", projection !== null && projection.key === "chatEnded");

  const blockedEvent = { type: "turn/end", data: { reason: { kind: "blocked" } } };
  check("enabled=false → blocked turn/end folds to not-ended", projection.view(projection.apply(projection.init(), blockedEvent)).ended === false);
  host.setEnabled(true);
  check("volatile ref read live → enabled=true folds blocked turn/end", projection.view(projection.apply(projection.init(), blockedEvent)).ended === true);

  // ipCheck 缺省必须是 false：不能因为配置缺省就悄悄联系 ipinfo.io / ip-api.com。
  host.setEnabled(true);
  await host.getRoute()({ method: "GET" }, resStub());
  check("region.ipCheck absent → no outbound fetch", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
  // 反向对照：显式打开 ipCheck 时必须真的去查（证明上面的计数不是假通过）。
  const hostIp = newModelHost({ regionTarget: "cn", region: { minSignals: 100, ipCheck: true } }, true);
  await hostIp.getRoute()({ method: "GET" }, resStub());
  check("region.ipCheck:true → outbound fetch happens", fetchCalls > 0, `fetchCalls=${fetchCalls}`);
  globalThis.fetch = realFetch;
}

/** 构造假请求对象（可迭代 body 供 readJson 消费）。 */
function fakeReq({ method, headers, body }) {
  const req = { method: method ?? "GET", headers: headers ?? {} };
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(body, "utf8");
    };
  }
  return req;
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILURES"}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

