// dsh-claude：Claude 式「区域风控 + 自主结束对话」—— 浏览器半面。
//
// UI 说明：
//   - 独立设置页：注册进 settings.section（设置页左侧标签栏），
//     标签「Claude 风控」。页面是纯 HTTP 客户端：GET /_dsh/claude/status 读取
//     设置与实时判定，POST 保存（staged-save 草稿 + 「保存并应用」），
//     不依赖 configForms 客户端机制。
//   - 浏览器指纹：页面加载后测量 navigator.language、中文字体、WebRTC IP，
//     通过 POST report 上报主机（用于区域信号；主机只存内存，不落盘）。
//   - Chat ended 面板：订阅各会话的 chatEnded 投影，发布 pendingInteraction，
//     注册进 conversation.composer chain（priority 0）接管输入区。
window.__ModuleLoader__.load({
  id: "dsh-claude-ux",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // 依赖注入：slots（槽位注册）、sessions + workspaces（会话/工作区只读）、
    // uiSession（发布 ended pendingInteraction）、uiWorkspace（新会话导航）。
    const inject = ["slots", "sessions", "uiSession", "uiWorkspace", "workspaces"];

    const CLIENT_VERSION = "2.0.0";
    const STATUS_ROUTE = "/_dsh/claude/status";
    const PENDING_KIND = "claude-chat-ended";
    const ZH_FONT_LIST = [
      "Microsoft YaHei", "微软雅黑", "SimSun", "宋体", "SimHei", "黑体",
      "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "DengXian", "等线"
    ];
    const SIGNAL_LABELS = {
      tz_cn: "时区（中国）",
      locale_zh: "系统语言 zh",
      reg_locale_zh: "注册表语言 zh",
      proxy_env: "代理（环境变量）",
      proxy_registry: "代理（注册表）",
      blacklist: "黑名单命中",
      ip_cn: "公网 IP 归属 CN",
      browser_zh_lang: "浏览器语言 zh",
      browser_zh_fonts: "中文字体",
      webrtc_mismatch: "WebRTC IP 不一致（疑似代理/VPN）"
    };

    /** 最近一次 GET /_dsh/claude/status 的快照（设置页首屏预热用）。 */
    let cachedClaude = null;

    const textOf = (message) => (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const sanitize = (value) => ({
      enabled: !!value?.enabled,
      regionPolicy: ["off", "observe", "block"].includes(value?.regionPolicy) ? value.regionPolicy : "block",
      regionTarget: value?.regionTarget === "non-cn" ? "non-cn" : "cn",
      abuseEnabled: value?.abuseEnabled !== false,
      warnThreshold: Number.isInteger(value?.warnThreshold) && value.warnThreshold >= 1 ? value.warnThreshold : 1,
      endThreshold: Number.isInteger(value?.endThreshold) && value.endThreshold >= 1 ? value.endThreshold : 3,
      warnEveryOffense: value?.warnEveryOffense !== false,
      severeEndsImmediately: value?.severeEndsImmediately !== false,
      steganography: value?.steganography !== false,
      webRtcCheck: value?.webRtcCheck === true,
      llmMode: ["off", "fuzzy", "all"].includes(value?.llmMode) ? value.llmMode : "all",
      llmProvider: typeof value?.llmProvider === "string" ? value.llmProvider : "",
      llmModel: typeof value?.llmModel === "string" ? value.llmModel : "",
      llmTimeoutMs: Number.isInteger(value?.llmTimeoutMs) && value.llmTimeoutMs >= 1 ? value.llmTimeoutMs : 30000,
      refusalMessage: typeof value?.refusalMessage === "string" ? value.refusalMessage : "",
      regionEndMessage: typeof value?.regionEndMessage === "string" ? value.regionEndMessage : "",
      warnMessage: typeof value?.warnMessage === "string" ? value.warnMessage : "",
      endMessage: typeof value?.endMessage === "string" ? value.endMessage : "",
      harmfulEndMessage: typeof value?.harmfulEndMessage === "string" ? value.harmfulEndMessage : "",
      refusalEndsAfter: Number.isInteger(value?.refusalEndsAfter) && value.refusalEndsAfter >= 1 ? value.refusalEndsAfter : 3,
    });

    // ══════════════════════════════════════════════════════════════════
    // HTTP 客户端
    // ══════════════════════════════════════════════════════════════════
    async function fetchClaudeStatus() {
      const response = await fetch(STATUS_ROUTE, { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body.error?.message ?? `dsh-claude status failed with HTTP ${response.status}`);
      }
      cachedClaude = body.value;
      return body.value;
    }

    async function postClaude(payload) {
      const response = await fetch(STATUS_ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body.error?.message ?? `dsh-claude save failed with HTTP ${response.status}`);
      }
      cachedClaude = body.value;
      return body.value;
    }

    // ══════════════════════════════════════════════════════════════════
    // 浏览器指纹
    // ══════════════════════════════════════════════════════════════════
    function measureWebRtcIp() {
      return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const timer = setTimeout(() => done(""), 2500);
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          pc.createDataChannel("probe");
          pc.onicecandidate = (event) => {
            if (!event.candidate) return;
            const ip = event.candidate.address || event.candidate.ip;
            if (ip && !ip.endsWith(".local")) {
              clearTimeout(timer);
              done(ip);
              try { pc.close(); } catch { /* 忽略 */ }
            }
          };
          pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => done(""));
          setTimeout(() => { try { pc.close(); } catch { /* 忽略 */ } }, 2500);
        } catch {
          done("");
        }
      });
    }

    /** 基础指纹（语言/字体）总是本地测量；WebRTC IP 仅在 doWebRtc=true 时测量
     *  （RTCPeerConnection 会联系 Google STUN 服务器，默认关闭以保护隐私）。 */
    async function measureFingerprint(doWebRtc) {
      const out = { lang: "", fonts: [], webRtcIp: "" };
      try {
        out.lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "";
      } catch { /* 忽略 */ }
      try {
        if (typeof document !== "undefined" && document.fonts) {
          for (const font of ZH_FONT_LIST) {
            try {
              if (document.fonts.check(`12px "${font}"`)) out.fonts.push(font);
            } catch { /* 忽略 */ }
          }
        }
      } catch { /* 忽略 */ }
      out.webRtcIp = doWebRtc ? await measureWebRtcIp() : "";
      return out;
    }

    // ══════════════════════════════════════════════════════════════════
    // 样式（复用 DSH 主题变量）
    // ══════════════════════════════════════════════════════════════════
    const styles = {
      page: { display: "grid", gap: 14, maxWidth: 900, padding: "8px 2px 32px", color: "var(--dsw-alias-fg-primary, #26231f)" },
      header: { display: "flex", justifyContent: "space-between", gap: 20, alignItems: "flex-start", padding: "8px 2px" },
      kicker: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", color: "#6758d4", fontWeight: 700 },
      h2: { fontSize: 25, letterSpacing: "-.025em", margin: "3px 0 6px", color: "var(--dsw-alias-label-primary)" },
      intro: { maxWidth: 620, margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.55 },
      panel: { display: "grid", gap: 12, padding: 15, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, background: "var(--dsw-alias-bg-module-platform)", boxShadow: "0 1px 1px rgba(0,0,0,.02)" },
      panelTitle: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
      panelH3: { fontSize: 14, margin: 0, color: "var(--dsw-alias-label-primary)" },
      panelHint: { fontSize: 11, lineHeight: 1.45, color: "var(--dsw-alias-label-tertiary)", margin: "4px 0 0", maxWidth: 620 },
      grid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 },
      field: { display: "grid", gap: 6, alignContent: "start" },
      label: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px" },
      input: {
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        padding: "5px 8px",
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none"
      },
      select: {
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        padding: "5px 8px",
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none",
        width: "100%",
        minWidth: 0,
        textOverflow: "ellipsis",
        overflow: "hidden",
        whiteSpace: "nowrap"
      },
      textarea: {
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 13,
        fontFamily: "inherit",
        lineHeight: "20px",
        resize: "vertical",
        minHeight: 48,
        outline: "none"
      },
      checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
      switch: { width: 16, height: 16, cursor: "pointer", accentColor: "var(--dsw-alias-accent, #4c8dff)" },
      bigSwitch: { width: 40, height: 22, cursor: "pointer", accentColor: "var(--dsw-alias-accent, #4c8dff)" },
      saveRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      button: {
        background: "var(--dsw-alias-accent, #4c8dff)",
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "8px 18px",
        fontSize: 14,
        cursor: "pointer"
      },
      buttonOutline: {
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        padding: "7px 14px",
        fontSize: 13,
        cursor: "pointer"
      },
      buttonDisabled: { opacity: 0.5, cursor: "default" },
      message: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      statusGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 },
      statusCell: { padding: "9px 10px", borderRadius: 9, background: "var(--dsw-alias-bg-module-platform)", border: "1px solid var(--dsw-alias-border-l2)", display: "grid", gap: 3 },
      statusName: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--dsw-alias-label-tertiary)" },
      statusValue: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      alert: { padding: "10px 12px", borderRadius: 10, fontSize: 12, lineHeight: 1.5, display: "grid", gap: 3 },
      alertWarn: { background: "rgba(224,162,55,.12)", color: "#986818" },
      alertError: { background: "rgba(205,72,72,.1)", color: "#aa3939" },
      alertOk: { background: "rgba(48,154,100,.1)", color: "#267d52" },
      endedRoot: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "28px 20px",
        minHeight: 220
      },
      endedCard: {
        maxWidth: 460,
        width: "100%",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        gap: 12
      },
      endedTitle: { color: "var(--dsw-alias-label-primary)", fontSize: 18, fontWeight: 600, margin: 0 },
      endedText: { color: "var(--dsw-alias-label-tertiary)", fontSize: 14, lineHeight: "22px", margin: 0 },
      endedButton: {
        margin: "4px auto 0",
        background: "var(--dsw-alias-accent, #4c8dff)",
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "8px 18px",
        fontSize: 14,
        cursor: "pointer"
      },
      endedButtonDisabled: { opacity: 0.5, cursor: "default" },
      endedNote: { color: "var(--dsw-alias-label-caption)", fontSize: 12, margin: 0 }
    };

    // ══════════════════════════════════════════════════════════════════
    // Chat ended 面板（conversation.composer chain 接管）
    // matched = 本插件发布的 pendingInteraction（{ kind, key, sessionId, reason }）；
    // useProjection 是备用读数（matched 滞后时补位）。
    // ══════════════════════════════════════════════════════════════════
    function ChatEndedPanel(props) {
      const [busy, setBusy] = react.useState(false);
      let projection = null;
      try {
        projection = typeof props.useProjection === "function" ? props.useProjection("chatEnded", (v) => v) : null;
      } catch { /* 忽略 */ }
      const matched = props.matched;
      const liveReason = projection && projection.ended === true ? projection.reason : null;
      const rawReason = (matched && typeof matched.reason === "string" && matched.reason !== "")
        ? matched.reason
        : liveReason;
      const reason = rawReason === "abuse" ? "abuse" : rawReason === "harmful" ? "harmful" : rawReason === "region" ? "region" : rawReason === "blocked" ? "blocked" : null;
      const onClick = async () => {
        if (busy || typeof props.startNewChat !== "function") return;
        setBusy(true);
        try {
          await props.startNewChat();
        } catch (error) {
          console.warn("[dsh-claude] start new chat failed:", error);
          setBusy(false);
        }
      };
      const reasonText = reason === "abuse"
        ? "本次对话因持续的辱骂互动被结束。(This conversation was ended after repeated abusive interaction.)"
        : reason === "harmful"
          ? "本次对话因涉及严重有害内容被结束。(This conversation was ended because it involved severely harmful content.)"
          : reason === "region"
            ? "本次对话因所在地区不可用被结束。(This conversation was ended because the service is unavailable in your region.)"
            : reason === "blocked"
              ? "本次对话已被服务端结束。(This conversation was ended by the server.)"
              : "本次对话已结束。(This conversation has ended.)";
      return react.createElement(
        "div",
        { "data-dsh-claude-ended": "", style: styles.endedRoot },
        react.createElement(
          "div",
          { style: styles.endedCard },
          react.createElement("h2", { style: styles.endedTitle }, "Chat ended"),
          react.createElement("p", { style: styles.endedText }, reasonText),
          react.createElement(
            "p",
            { style: styles.endedText },
            "开启新对话以继续使用。(Start a new chat to continue.)"
          ),
          react.createElement(
            "button",
            {
              type: "button",
              style: { ...styles.endedButton, ...(busy ? styles.endedButtonDisabled : null) },
              disabled: busy,
              onClick
            },
            busy ? "…" : "Start a new chat"
          ),
          react.createElement("p", { style: styles.endedNote }, "Send feedback")
        )
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // 独立设置页（settings.section，纯 HTTP 读写）
    // ══════════════════════════════════════════════════════════════════
    function ClaudePage() {
      const [phase, setPhase] = react.useState("loading"); // loading | ready | error
      const [error, setError] = react.useState("");
      const [serverValue, setServerValue] = react.useState(null); // GET 快照（含 revision）
      const [draft, setDraft] = react.useState(null);
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [savedMsg, setSavedMsg] = react.useState(false);
      const [browserSignals, setBrowserSignals] = react.useState(null);
      const [classifyDraft, setClassifyDraft] = react.useState("");
      const [classifyResult, setClassifyResult] = react.useState(null);
      const [classifying, setClassifying] = react.useState(false);

      const runClassify = async () => {
        if (classifying || !classifyDraft.trim()) return;
        setClassifying(true);
        setClassifyResult(null);
        try {
          const value = await postClaude({ action: "classify", text: classifyDraft });
          setClassifyResult(value);
        } catch (err) {
          setClassifyResult({ error: err instanceof Error ? err.message : String(err) });
        } finally {
          setClassifying(false);
        }
      };

      // 分类模型下拉：从 DSH 已配置目录选，留空=跟随会话；目录里没有的显示为「自定义…」
      const catalog = serverValue?.settings?.catalog ?? [];
      // 内置默认文案：文案输入框空值时灰字占位显示（让用户知道默认会说什么）
      const defaults = serverValue?.settings?.defaults ?? {};
      const inCatalog = (provider, model) => catalog.some((entry) => entry.provider === provider && entry.model === model);
      const llmSelectValue = draft !== null && (draft.llmProvider || draft.llmModel)
        ? (inCatalog(draft.llmProvider, draft.llmModel) ? `${draft.llmProvider}/${draft.llmModel}` : "__custom__")
        : "";
      const showCustomLlm = llmSelectValue === "__custom__";
      const onLlmSelect = (value) => {
        if (value === "") {
          patch("llmProvider", "");
          patch("llmModel", "");
        } else if (value !== "__custom__") {
          const slash = value.indexOf("/");
          patch("llmProvider", value.slice(0, slash));
          patch("llmModel", value.slice(slash + 1));
        }
      };

      const load = react.useCallback(async () => {
        setPhase("loading");
        try {
          const value = await fetchClaudeStatus();
          setServerValue(value);
          setDraft(sanitize(value.settings.value));
          setPhase("ready");
          setError("");
        } catch (err) {
          setPhase("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }, []);

      // 浏览器指纹测量：等设置加载后按 webRtcCheck 决定是否做 WebRTC/STUN 探测
      // （默认关闭；开启会联系 Google STUN 服务器，隐私说明见 docs/PRIVACY.md）
      react.useEffect(() => {
        if (serverValue === null || browserSignals !== null) return undefined;
        let alive = true;
        const doWebRtc = serverValue.settings.value?.webRtcCheck === true;
        measureFingerprint(doWebRtc).then((measured) => {
          if (alive) setBrowserSignals(measured);
        });
        return () => {
          alive = false;
        };
      }, [serverValue, browserSignals]);

      // 首次加载：拉取设置并初始化草稿
      react.useEffect(() => {
        let alive = true;
        load().then(() => {
          if (!alive) return;
        });
        return () => {
          alive = false;
        };
      }, [load]);

      // 浏览器指纹变化时上报一次
      react.useEffect(() => {
        if (phase !== "ready" || browserSignals === null || serverValue === null) return undefined;
        let alive = true;
        const stored = serverValue.settings.value?.browser;
        const same = stored !== null && stored !== undefined
          && stored.lang === browserSignals.lang
          && JSON.stringify(stored.fonts ?? []) === JSON.stringify(browserSignals.fonts)
          && stored.webRtcIp === browserSignals.webRtcIp;
        if (!same) {
          postClaude({ action: "report", browser: browserSignals }).then((value) => {
            if (!alive) return;
            setServerValue(value);
            setDraft(sanitize(value.settings.value));
          }).catch(() => { /* 静默：下次保存会带上 */ });
        }
        return () => {
          alive = false;
        };
      }, [phase, browserSignals, serverValue]);

      const patch = (key, val) => {
        setError("");
        setSavedMsg(false);
        setDraft((d) => (d === null ? d : { ...d, [key]: val }));
        setDirty(true);
      };
      const save = async () => {
        if (saving || draft === null || serverValue === null) return;
        setSaving(true);
        setError("");
        setSavedMsg(false);
        try {
          const value = await postClaude({
            action: "save",
            expectedRevision: serverValue.settings.revision,
            value: { ...draft, browser: browserSignals ?? serverValue.settings.value?.browser ?? { lang: "", fonts: [], webRtcIp: "" } },
          });
          setServerValue(value);
          setDraft(sanitize(value.settings.value));
          setDirty(false);
          setSavedMsg(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          await load().catch(() => {});
        } finally {
          setSaving(false);
        }
      };

      if (phase === "error") {
        return react.createElement(
          "div",
          { style: styles.page },
          react.createElement("div", { style: styles.header },
            react.createElement(
              "div",
              null,
              react.createElement("span", { style: styles.kicker }, "DSH native plugin"),
              react.createElement("h2", { style: styles.h2 }, "Claude 风控与自主性"),
              react.createElement("p", { style: styles.intro }, "复刻 Claude：区域检测 + 辱骂与有害互动自动结束对话。")
            )
          ),
          react.createElement(
            "div",
            { style: { ...styles.alert, ...styles.alertError } },
            `状态路由不可用：${error}`,
            react.createElement("span", null, "请确认主机插件已加载（重启 dsh web 后刷新），或检查浏览器网络请求 /_dsh/claude/status 的状态。")
          ),
          react.createElement(
            "div",
            { style: styles.saveRow },
            react.createElement("button", { type: "button", style: styles.buttonOutline, onClick: () => load() }, "重试")
          )
        );
      }
      if (phase === "loading" || draft === null) {
        return react.createElement("div", { style: styles.page }, react.createElement("div", { style: styles.label }, "加载中…"));
      }

      const writable = serverValue?.settings?.writable === true;
      const saved = !dirty && !saving;

      const checkbox = (key, label, desc) => react.createElement(
        "div",
        null,
        react.createElement(
          "label",
          { style: styles.checkboxRow },
          react.createElement("input", {
            type: "checkbox",
            role: "switch",
            checked: !!draft[key],
            disabled: !writable,
            onChange: (event) => patch(key, event.target.checked),
            style: styles.switch
          }),
          label
        ),
        desc ? react.createElement("div", { style: { ...styles.panelHint, marginTop: 2 } }, desc) : null
      );
      const numberInput = (key, label) => react.createElement(
        "label",
        { style: styles.field },
        react.createElement("span", { style: styles.label }, label),
        react.createElement("input", {
          type: "number",
          min: 1,
          style: styles.input,
          value: draft[key],
          disabled: !writable,
          onChange: (event) => patch(key, Math.max(1, Math.floor(Number(event.target.value)) || 1))
        })
      );
      const selectInput = (key, label, options) => react.createElement(
        "label",
        { style: styles.field },
        react.createElement("span", { style: styles.label }, label),
        react.createElement("select", {
          style: styles.select,
          value: draft[key],
          disabled: !writable,
          onChange: (event) => patch(key, event.target.value)
        }, options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)))
      );
      const textInput = (key, label, rows, placeholder) => react.createElement(
        "label",
        { style: styles.field },
        react.createElement("span", { style: styles.label }, label),
        react.createElement("textarea", {
          style: { ...styles.textarea, minHeight: rows * 20 + 12 },
          rows,
          value: draft[key],
          disabled: !writable,
          placeholder,
          onChange: (event) => patch(key, event.target.value)
        })
      );

      // 状态卡数据
      const statusCells = [];
      if (serverValue?.verdict) {
        const v = serverValue.verdict;
        const s = serverValue.settings.value;
        const regionLabel = v.region === "cn" ? "中国用户 (cn)" : v.region === "other" ? "其他地区 (other)" : "未知 (unknown)";
        const targetLabel = s.regionTarget === "non-cn" ? "非中国用户" : "中国用户";
        const ipText = v.ip ? `${v.ip.country} ${v.ip.ip}${v.ip.org ? " · " + v.ip.org : ""}` : "不可用";
        statusCells.push(
          react.createElement("div", { key: "target", style: styles.statusCell }, react.createElement("span", { style: styles.statusName }, "风控目标"), react.createElement("span", { style: styles.statusValue }, targetLabel)),
          react.createElement("div", { key: "region", style: styles.statusCell }, react.createElement("span", { style: styles.statusName }, "主机判定"), react.createElement("span", { style: styles.statusValue }, regionLabel)),
          react.createElement("div", { key: "blocked", style: styles.statusCell }, react.createElement("span", { style: styles.statusName }, "命中（将被风控）"), react.createElement("span", { style: styles.statusValue }, v.blocked ? "是" : "否")),
          react.createElement("div", { key: "score", style: styles.statusCell }, react.createElement("span", { style: styles.statusName }, "信号分"), react.createElement("span", { style: styles.statusValue }, String(v.score))),
          react.createElement("div", { key: "ip", style: styles.statusCell }, react.createElement("span", { style: styles.statusName }, "公网 IP"), react.createElement("span", { style: styles.statusValue, fontSize: 11 }, ipText))
        );
      }

      const browserText = browserSignals
        ? `language=${browserSignals.lang || "(none)"} · fonts=[${browserSignals.fonts.join(", ")}] · webRtcIp=${browserSignals.webRtcIp || "(unavailable)"}`
        : "measuring…";

      return react.createElement(
        "div",
        { style: styles.page },
        react.createElement(
          "div",
          { style: styles.header },
          react.createElement(
            "div",
            null,
            react.createElement("span", { style: styles.kicker }, "DSH native plugin"),
            react.createElement("h2", { style: styles.h2 }, "Claude 风控与自主性"),
            react.createElement(
              "p",
              { style: styles.intro },
              "复刻 Claude：区域检测（时区 / 系统语言 / 代理 / 域名黑名单 / 公网 IP / 浏览器指纹）+ 辱骂与有害互动自动结束对话。全部本地判定，不上报任何遥测。"
            )
          ),
          react.createElement(
            "label",
            { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 190, padding: "9px 11px", borderRadius: 10, background: "var(--dsw-alias-bg-module-platform)", border: "1px solid var(--dsw-alias-border-l2)" } },
            react.createElement("input", {
              type: "checkbox",
              role: "switch",
              "aria-label": "启用 Claude 风控与自主性",
              checked: !!draft.enabled,
              disabled: !writable,
              onChange: (event) => patch("enabled", event.target.checked),
              style: styles.bigSwitch
            }),
            react.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, draft.enabled ? "已启用" : "已关闭")
          )
        ),

        react.createElement(
          "div",
          { style: styles.panel },
          react.createElement(
            "div",
            { style: styles.panelTitle },
            react.createElement(
              "div",
              null,
              react.createElement("h3", { style: styles.panelH3 }, "检测状态"),
              react.createElement("p", { style: styles.panelHint }, "主机实时判定（每 30 秒缓存；IP 归属 10 分钟缓存）。详见主机日志 [dsh-claude] region=… signals=[…]。")
            ),
            react.createElement(
              "button",
              { type: "button", style: styles.buttonOutline, disabled: phase === "loading", onClick: () => load() },
              phase === "loading" ? "刷新中…" : "刷新"
            )
          ),
          serverValue?.verdict
            ? react.createElement(
              "div",
              { style: { display: "grid", gap: 10 } },
              react.createElement("div", { style: styles.statusGrid }, statusCells),
              react.createElement(
                "div",
                { style: styles.label },
                "命中信号：" + (serverValue.verdict.signals.length === 0 ? "（无）" : serverValue.verdict.signals.map((s) => `${SIGNAL_LABELS[s.name] ?? s.name}${s.detail ? `(${s.detail})` : ""}`).join(" · "))
              ),
              serverValue.verdict.blacklistHits.length > 0
                ? react.createElement("div", { style: { ...styles.alert, ...styles.alertWarn } }, `黑名单命中：${serverValue.verdict.blacklistHits.join(", ")}`)
                : null,
              react.createElement("div", { style: styles.label }, `本机浏览器信号：${browserText}`)
            )
            : react.createElement("div", { style: styles.label }, "加载中…")
        ),

        react.createElement(
          "div",
          { style: styles.panel },
          react.createElement(
            "div",
            { style: styles.panelTitle },
            react.createElement(
              "div",
              null,
              react.createElement("h3", { style: styles.panelH3 }, "区域风控"),
              react.createElement("p", { style: styles.panelHint }, "风控目标决定惩罚阶梯作用在谁身上；block 策略下：拒绝文案（带尝试计数）→ 达到次数结束会话 → 服务端持续拒绝。")
            )
          ),
          react.createElement(
            "div",
            { style: styles.grid },
            selectInput("regionTarget", "风控目标（反向开关）", [
              { value: "cn", label: "中国用户：检测到中国人就风控" },
              { value: "non-cn", label: "非中国用户：检测到不是中国人就风控" },
            ]),
            selectInput("regionPolicy", "区域策略", [
              { value: "block", label: "block：拒绝回复" },
              { value: "observe", label: "observe：只记录+隐写标记" },
              { value: "off", label: "off：关闭" },
            ]),
            numberInput("refusalEndsAfter", "区域拒绝后结束（次数）")
          ),
          checkbox("steganography", "隐写标记", "系统提示词日期改 2026/06/30、黑名单命中换 Unicode 撇号；目标命中时注入模型级区域指令"),
          checkbox("webRtcCheck", "WebRTC IP 检测（联系 Google STUN 服务器）", "用于 WebRTC IP 与公网 IP 一致性检测（疑似代理/VPN）；关闭则不做任何 STUN 联系。默认关闭以保护隐私。")
        ),

        react.createElement(
          "div",
          { style: styles.panel },
          react.createElement(
            "div",
            { style: styles.panelTitle },
            react.createElement(
              "div",
              null,
              react.createElement("h3", { style: styles.panelH3 }, "分类 LLM（辱骂/有害语境判定）"),
              react.createElement("p", { style: styles.panelHint }, "独立请求、独立上下文：只把消息原文发给分类模型，不进会话日志与模型上下文。模型直接从 DSH 已配置的列表里选，留空 = 跟随会话主模型（agent-default-model）。")
            )
          ),
          react.createElement(
            "div",
            { style: styles.grid },
            selectInput("llmMode", "判定模式", [
              { value: "all", label: "全部消息 LLM 语境判定（最准，默认）" },
              { value: "fuzzy", label: "仅模糊词调 LLM（省调用）" },
              { value: "off", label: "纯词表（最快，不调 LLM）" },
            ]),
            react.createElement(
              "label",
              { style: styles.field },
              react.createElement("span", { style: styles.label }, "分类模型（选 DSH 已配置的）"),
              react.createElement("select", {
                style: styles.select,
                value: llmSelectValue,
                disabled: !writable,
                title: llmSelectValue === "__custom__" ? (draft.llmProvider ? `自定义：${draft.llmProvider} / ${draft.llmModel}` : "自定义…") : (llmSelectValue || "跟随会话主模型（默认）"),
                onChange: (event) => onLlmSelect(event.target.value)
              },
              react.createElement("option", { value: "" }, "跟随会话主模型（默认）"),
              catalog.map((entry) => react.createElement("option", {
                key: `${entry.provider}/${entry.model}`,
                value: `${entry.provider}/${entry.model}`,
              }, `${entry.provider} / ${entry.model}${entry.name !== entry.model ? `（${entry.name}）` : ""}`)),
              react.createElement("option", { value: "__custom__" }, "自定义…")
              )
            ),
            showCustomLlm ? textInput("llmProvider", "Provider（自定义）", 1) : null,
            showCustomLlm ? textInput("llmModel", "Model（自定义）", 1) : null,
            numberInput("llmTimeoutMs", "请求超时（毫秒）")
          ),
          react.createElement(
            "div",
            { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: 10, display: "grid", gap: 8 } },
            react.createElement("div", { style: styles.label }, "消息分类自测（输入一句话看词表/LLM/最终判定）"),
            react.createElement(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "center" } },
              react.createElement("input", {
                style: { ...styles.input, flex: 1 },
                value: classifyDraft,
                placeholder: "例如：你真是个垃圾",
                onChange: (event) => setClassifyDraft(event.target.value),
                onKeyDown: (event) => { if (event.key === "Enter") runClassify(); }
              }),
              react.createElement(
                "button",
                {
                  type: "button",
                  style: { ...styles.buttonOutline, ...(classifying ? styles.buttonDisabled : null) },
                  disabled: classifying,
                  onClick: runClassify
                },
                classifying ? "测试中…" : "测试"
              )
            ),
            classifyResult === null
              ? null
              : classifyResult.error
                ? react.createElement("div", { style: { ...styles.alert, ...styles.alertError } }, `测试失败：${classifyResult.error}`)
                : react.createElement(
                  "div",
                  { style: { display: "grid", gap: 2 } },
                  react.createElement("div", { style: styles.label }, `分类模型：${classifyResult.used ? `${classifyResult.used.provider} / ${classifyResult.used.model}` : "（未配置，纯词表）"}`),
                  react.createElement("div", { style: styles.label }, `词表：辱骂 ${classifyResult.keyword.classification.abuse ? "是" : "否"}${classifyResult.keyword.matched.abuse.length > 0 ? `（命中 ${classifyResult.keyword.matched.abuse.join(" ")}）` : ""} · 有害 ${classifyResult.keyword.classification.harmful ? "是" : "否"} · 自伤 ${classifyResult.keyword.classification.selfHarm ? "是" : "否"}`),
                  classifyResult.llm === null
                    ? react.createElement("div", { style: { ...styles.label, color: classifyResult.llmError ? "var(--dsw-alias-danger, #d9534f)" : undefined } }, classifyResult.llmError ? `LLM：不可用（${classifyResult.llmError}）→ 降级词表` : "LLM：未启用（降级词表）")
                    : react.createElement("div", { style: styles.label }, `LLM：辱骂 ${classifyResult.llm.abuse ? "是" : "否"} · 有害 ${classifyResult.llm.harmful ? "是" : "否"} · 自伤 ${classifyResult.llm.selfHarm ? "是" : "否"}`),
                  react.createElement("div", { style: { ...styles.label, fontWeight: 600 } }, `最终判定：辱骂 ${classifyResult.merged.abuse ? "是（会警告/结束）" : "否"} · 有害 ${classifyResult.merged.harmful ? "是（会立即结束）" : "否"} · 自伤 ${classifyResult.merged.selfHarm ? "是（安全覆盖）" : "否"}`)
                )
          )
        ),

        react.createElement(
          "div",
          { style: styles.panel },
          react.createElement(
            "div",
            { style: styles.panelTitle },
            react.createElement(
              "div",
              null,
              react.createElement("h3", { style: styles.panelH3 }, "自主性（辱骂/有害互动结束对话）"),
              react.createElement("p", { style: styles.panelHint }, "自伤/他伤风险消息永不触发结束（对齐 Claude 公开限制）。")
            )
          ),
          react.createElement(
            "div",
            { style: styles.grid },
            numberInput("warnThreshold", "警告阈值（辱骂次数）"),
            numberInput("endThreshold", "结束阈值（辱骂次数）")
          ),
          checkbox("warnEveryOffense", "每次辱骂都警告", "达到结束阈值前，每次辱骂都回复警告文案"),
          checkbox("severeEndsImmediately", "严重有害内容立即结束", "未成年性内容 / 恐怖主义 / 大规模暴力：不警告直接结束")
        ),

        react.createElement(
          "div",
          { style: styles.panel },
          react.createElement(
            "div",
            { style: styles.panelTitle },
            react.createElement(
              "div",
              null,
              react.createElement("h3", { style: styles.panelH3 }, "文案"),
              react.createElement("p", { style: styles.panelHint }, "留空使用内置中英默认（按消息语言自动选择）。")
            )
          ),
          textInput("refusalMessage", "区域拒绝文案（自动追加尝试计数）", 2, defaults.refusal),
          textInput("regionEndMessage", "区域结束文案（达到拒绝次数后结束会话）", 2, defaults.regionEnd),
          textInput("warnMessage", "警告文案", 2, defaults.warn),
          textInput("endMessage", "结束文案（辱骂触发）", 3, defaults.end),
          textInput("harmfulEndMessage", "有害内容结束文案（严重有害立即结束时）", 3, defaults.harmfulEnd)
        ),

        react.createElement(
          "div",
          { style: styles.saveRow },
          react.createElement(
            "button",
            {
              type: "button",
              style: { ...styles.button, ...(saving || !dirty ? styles.buttonDisabled : null) },
              disabled: !writable || saving || !dirty,
              onClick: save
            },
            saving ? "保存中…" : "保存并应用"
          ),
          savedMsg ? react.createElement("span", { style: { ...styles.message, color: "#267d52" } }, "已保存并生效。") : null,
          saved && !savedMsg ? react.createElement("span", { style: styles.message }, "当前设置已是最新。") : null,
          error ? react.createElement("span", { style: { ...styles.message, color: "#aa3939" } }, error) : null,
          react.createElement("span", { style: styles.message }, `client v${CLIENT_VERSION} · rev ${serverValue?.settings?.revision ?? "-"}`)
        )
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // apply
    // ══════════════════════════════════════════════════════════════════
    function apply(ctx) {
      console.info("[dsh-claude] client loaded", { version: CLIENT_VERSION });

      // 后台刷新状态缓存（设置页首屏预热）
      fetchClaudeStatus().then(() => {
        console.info("[dsh-claude] status snapshot cached", cachedClaude?.verdict);
      }).catch((error) => {
        console.warn("[dsh-claude] initial status fetch failed:", error instanceof Error ? error.message : String(error));
      });

      // Chat ended 观察器：订阅各会话的 chatEnded 投影，发布 pendingInteraction
      // 驱动 composer chain 接管（chain select 只能看到 owner props，必须走这条路）。
      try {
        const publish = ctx.uiSession.registerPendingInteraction(() => 3);
        const published = new Map(); // sessionId -> unpublish
        const faceStops = new Map(); // sessionId -> stop face subscription
        const unpublishSession = (sessionId) => {
          const stop = published.get(sessionId);
          if (stop !== undefined) {
            published.delete(sessionId);
            try { stop(); } catch { /* 忽略 */ }
          }
        };
        const watchSession = (sessionId) => {
          let binding;
          try {
            binding = ctx.sessions.binding(sessionId);
          } catch {
            binding = undefined;
          }
          if (binding === undefined) {
            unpublishSession(sessionId);
            return;
          }
          let face;
          try {
            face = binding.session.projections.faceOf("chatEnded");
          } catch {
            unpublishSession(sessionId);
            return;
          }
          const check = () => {
            let snapshot;
            try {
              snapshot = face.getSnapshot();
            } catch {
              snapshot = undefined;
            }
            if (snapshot !== null && snapshot !== undefined && snapshot.ended === true) {
              if (!published.has(sessionId)) {
                try {
                  published.set(sessionId, publish({
                    key: `claude-ended:${sessionId}`,
                    kind: PENDING_KIND,
                    sessionId,
                    reason: typeof snapshot.reason === "string" ? snapshot.reason : "",
                  }, async () => {}));
                } catch (error) {
                  console.warn("[dsh-claude] publish ended interaction failed:", error);
                }
              }
            } else {
              unpublishSession(sessionId);
            }
          };
          check();
          try {
            faceStops.set(sessionId, face.subscribe(check));
          } catch {
            /* 单会话订阅失败不影响其它会话 */
          }
        };
        const reconcile = () => {
          let ids = [];
          try {
            ids = Object.keys(ctx.sessions.list.getSnapshot().byId ?? {});
          } catch {
            ids = [];
          }
          for (const [id, stop] of faceStops) {
            if (!ids.includes(id)) {
              try { stop(); } catch { /* 忽略 */ }
              faceStops.delete(id);
              unpublishSession(id);
            }
          }
          for (const id of ids) {
            if (!faceStops.has(id)) watchSession(id);
          }
        };
        ctx.effect(() => {
          reconcile();
          let stopList = () => {};
          try {
            stopList = ctx.sessions.list.subscribe(reconcile);
          } catch { /* 忽略 */ }
          return () => {
            try { stopList(); } catch { /* 忽略 */ }
            for (const stop of faceStops.values()) {
              try { stop(); } catch { /* 忽略 */ }
            }
            faceStops.clear();
            for (const id of [...published.keys()]) unpublishSession(id);
          };
        }, "dsh-claude: ended watcher");
      } catch (error) {
        console.warn("[dsh-claude] ended watcher activation failed:", error);
      }

      // Chat ended 面板：接管输入区
      try {
        ctx.slots.inject("conversation.composer", () => {
          const dispose = ctx.slots.register({
            name: "conversation.composer",
            priority: 0,
            // chain select 契约：命中返回非 null（成为 matched），未命中必须返回 null
            // （false 会被当成命中）。ended 态经 pendingInteraction 到达。
            select: (props) => {
              const pending = props?.pendingInteraction;
              return pending !== null && pending !== undefined && pending.kind === PENDING_KIND ? pending : null;
            },
            inject: (sessionId) => ({
              startNewChat: async () => {
                let workspaceId;
                try {
                  const snapshot = ctx.workspaces?.list?.getSnapshot?.();
                  const items = snapshot?.items ?? [];
                  const workspace = items.find((w) => (w.sessionIds ?? []).includes(sessionId));
                  workspaceId = workspace?.workspaceId;
                } catch { /* 忽略 */ }
                const newId = await ctx.sessions.create(workspaceId ? { workspaceId } : {});
                ctx.uiWorkspace.openSession(newId);
              }
            })
          }, ChatEndedPanel);
          return () => dispose();
        });
      } catch (error) {
        console.warn("[dsh-claude] composer panel activation failed:", error);
      }

      // 独立设置页（设置页左侧标签栏）
      try {
        ctx.slots.inject("settings.section", () => {
          const dispose = ctx.slots.register({
            name: "settings.section",
            id: "claude",
            order: 20,
            label: () => "Claude 风控",
          }, ClaudePage);
          return () => dispose();
        });
      } catch (error) {
        console.warn("[dsh-claude] settings section activation failed:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
