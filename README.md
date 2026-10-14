# dsh-claude-ux

Claude 式「区域风控 + 自主结束对话」插件 —— 适用于 DeepSeek Harness 的 web profile。

复刻 Anthropic/Claude 的两类行为，**除两个默认关闭的可选外部调用外全部本地判定**（详见 [docs/PRIVACY.md](docs/PRIVACY.md)）：

- **区域风控（可反向）**：检测目标用户（时区、系统/浏览器语言、中文字体、代理、代理/中转域名黑名单、公网 IP 归属、WebRTC IP 一致性）。`regionTarget` 选 `cn` = 风控中国用户（Claude 原版行为），选 `non-cn` = **反向风控**（检测到不是中国人就风控）。命中后按惩罚阶梯处置：拒绝文案（带尝试计数）→ 达到 `refusalEndsAfter` 次数后结束会话（Chat ended 面板 + 服务端持续拒绝，重启后依然生效）→ 系统提示词注入模型级区域指令。
- **自主性**：用户持续辱骂或反复要求严重有害内容时，先警告、再主动结束对话；自伤/他伤风险消息永不触发结束（对齐 Claude 的公开限制）。辱骂结束与严重有害结束使用**独立文案**（均可在设置页自定义，空值灰字显示内置默认）。辱骂判定采用**词表秒判 + LLM 语境兜底**：强词（傻逼/fuck 等）直接判；弱词（垃圾/闭嘴等）与未命中消息由独立 LLM 请求做语境裁决（`purpose` 标记，**不进会话日志与模型上下文**；消息入队即异步预分类，近零额外延迟）。分类模型可直接从 **DSH 已配置的模型目录**下拉选择，或留空跟随会话主模型。
- **隐写通道**：系统提示词日期格式（`2026-06-30` ↔ `2026/06/30`）编码区域判定，Unicode 撇号变体（U+2019 ↔ U+02BC）编码黑名单命中。

## 截图

### 设置页（独立标签栏，与视觉工具插件同款）

![设置页「Claude 风控」标签全貌](docs/assets/settings-page.png)

*「Claude 风控」标签页：右上总开关、检测状态卡（风控目标 / 主机判定 / 命中 / 信号分 / 公网 IP）、区域风控面板（反向目标下拉、策略、隐写标记、WebRTC）、分类 LLM 面板（判定模式、模型下拉、消息分类自测）、自主性面板（警告 / 结束阈值）与文案面板（留空灰字显示内置默认）。*

### 区域风控：拒绝阶梯 → 结束会话

![区域惩罚阶梯：拒绝文案（带尝试计数）→ 达到次数后结束会话](docs/assets/region-ladder.png)

*目标命中时每条消息回复拒绝文案并附「第 N/M 次尝试——继续将结束本次对话」；达到 `refusalEndsAfter` 次数后以区域结束文案终止会话，服务端对后续消息持续拒绝。*

### 自主性：辱骂结束对话

![辱骂升级 → 警告 → 主动结束对话](docs/assets/abuse-end.png)

*持续辱骂先警告、再以独立结束文案主动结束对话（不引用"上一条消息"，阈值可设为 1）；结束后同会话消息全部被服务端拒绝。*

### 自主性：严重有害内容立即结束

![严重有害请求 → 立即结束对话](docs/assets/harmful-end.png)

*未成年性内容 / 恐怖主义 / 大规模暴力等严重有害内容不警告、直接以独立文案结束对话；自伤 / 他伤风险消息则永不触发结束。*

## 安装（一条命令）

```bash
npx -y @deepseek-ai/dsh plugin --profile <profile> add github:eri64/dsh-claude-ux
```

`<profile>` 填你实际在用的 profile（`~/.dsh/profiles/` 下的目录名，例如 `web` 或官方桌面端的 `desktop`）——装到别的 profile 不会有任何效果。

包内自带注册条目（`dsh.bundle`），`dsh plugin` 安装后**自动注册**，无需手动改任何配置文件。
更新（升级到最新版）也是同一条命令。

### 启用

1. 重启该 profile，浏览器硬刷新（宿主插件与客户端 bundle 都在启动时装载）。
2. 设置页左侧标签栏出现 **「Claude 风控」** 独立标签（与视觉工具插件同款）：
   总开关、风控目标（中国/非中国用户反向开关）、区域策略、实时检测状态
   （`/_dsh/claude/status`）、阈值与文案。
3. **默认关闭**（`enabled: false`，避免把自己锁在外面）；打开总开关并「保存并应用」后即时生效，无需重启。

> 校验安装是否成功：浏览器访问本机 dsh web 的 `/_dsh/claude/status`
> （端口以实例实际监听为准，例如 `http://127.0.0.1:3080/_dsh/claude/status`），返回 `{"ok":true,...}` 即主机插件已加载。

### 关掉之后会怎样

总开关关闭（或在插件市场停用）后，插件不再介入任何消息，且**不再判定/保留「会话已结束」**：
被风控结束过的旧会话在关闭后会立刻恢复可输入。这是有意为之——「结束态跨重启保持」是为了
模拟服务端封禁，而不是把用户锁在插件外面。

唯一不可撤销的痕迹是被拒绝的那轮对话本身写在会话历史里（`turn/end` blocked + 拒绝文案）；
新会话不受影响。想体验建议开一个临时会话。

### 自定义默认配置（可选）

内置默认值开箱即用；需要覆盖 patch 级选项（`blacklist` / `cnTimezones` / 词表等）时，
在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加 id 定向覆盖，或参考
[examples/cordis.patch.yml](examples/cordis.patch.yml)（设置页可改的项优先用设置页）。

## 兼容性

命名空间注册在两代宿主 API 上都工作：

| 宿主 | settings 服务 | 命名空间来源 |
|---|---|---|
| dsh ≤ 0.1.6 | 有 `register(ns, schema, {base})` | 插件调用 `register` |
| dsh ≥ 0.1.7（#677） | 无 `register`，只有 `describe/update/replace/mutate/write` | 插件导出的 `Config`（条目 id 即命名空间，设置页字段需 `volatile()` 标记） |

已在 **dsh 0.2.0-rc.2**（官方桌面端）实测：`/_dsh/claude/status` 返回 `{"ok":true,...}`，
设置页保存后运行时不重启即读到新值。

`volatile()` 由宿主自己的 `@deepseek-ai/schemastery` 提供；本包依赖的社区版 `schemastery`
没有该方法，所以标记 volatile 必须用宿主模块（解析不到时退化为「只支持 patch 配置」，
不影响插件启动）。

## 配置

键分两层：**顶层扁平键**设置页可改、patch 也能写；**`region` / `abuse` / `messages`** 只能改 patch。

### 顶层键（设置页可改）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `regionTarget` | `cn` | 风控谁：`cn`=中国用户 \| `non-cn`=非中国用户（反向） |
| `regionPolicy` | `block` | `block`=拒绝回复 \| `observe`=只记录+隐写标记 \| `off`=关闭 |
| `refusalEndsAfter` | `3` | 拒绝 N 次后结束会话（区域「封号」阶梯） |
| `webRtcCheck` | `false` | WebRTC IP 探测（联系 Google STUN，**默认关闭**） |
| `steganography` | `true` | 隐写标记 |
| `abuseEnabled` | `true` | 辱骂/有害自主结束总开关 |
| `warnThreshold` | `1` | 警告阈值（strikes） |
| `endThreshold` | `3` | 结束阈值（strikes） |
| `warnEveryOffense` | `true` | 每次越线都警告 |
| `severeEndsImmediately` | `true` | 严重有害内容立即结束（不警告） |
| `llmMode` | `all` | 辱骂判定模式：`all`=全部消息 LLM 语境判定（最准）\| `fuzzy`=仅弱词调 LLM \| `off`=纯词表 |
| `llmProvider` / `llmModel` | 空=跟随会话 | 分类请求的模型（缺省复用会话主模型 / agent-default-model） |
| `llmTimeoutMs` | `5000` | 分类请求超时 |
| `refusalMessage` / `regionEndMessage` / `warnMessage` / `endMessage` / `harmfulEndMessage` | 空=内置默认 | 四类文案（设置页留空时灰字显示内置默认） |

### patch 键（只能改 `cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `region.minSignals` | `2` | 信号分阈值（strong=2 / medium=1 / weak=0.5） |
| `region.ipCheck` | `false` | 公网 IP 归属查询（联系 ipinfo.io / ip-api.com，**默认关闭**） |
| `region.ipTimeoutMs` | `3000` | IP 查询超时 |
| `region.blockOnUnknown` | `false` | 完全无信号时是否视为目标命中（fail-closed） |
| `region.showAttempts` | `true` | 拒绝文案追加「第 N/M 次尝试」 |
| `region.promptEnforcement` | `true` | 目标命中时注入模型级区域指令 |
| `region.cnTimezones` / `region.blacklist` | 内置 | 中国时区表 / 代理中转域名黑名单（可整体替换） |
| `abuse.llm.enabled` | `true` | LLM 分类层总开关 |
| `abuse.patterns` / `strongPatterns` / `weakPatterns` / `harmfulPatterns` / `selfHarmPatterns` | 内置 | 词表（正则，可整体替换） |

其中分类模型**下拉直接列出 DSH 已配置的模型**（扫描 settings 的 providers 命名空间），留空=跟随会话主模型，「自定义…」可手填目录外的模型。

> **从旧版升级**：`region.target` / `region.policy` / `region.refusalEndsAfter` /
> `region.webRtcCheck` / `abuse.enabled` / `abuse.warnThreshold` / `abuse.endThreshold` /
> `abuse.warnEveryOffense` / `abuse.severeEndsImmediately` / `abuse.llm.*` / `messages.*`
> 已迁到上表的顶层键。旧键仍被接受（避免宿主验证失败导致 profile 起不来）但**不再生效**，
> 启动时会在宿主日志里列出被忽略的键。

## 隐私

默认配置下（`ipCheck: false`、`webRtcCheck: false`）**插件不与任何外部服务通信**：所有检测（时区、语言、代理、黑名单、浏览器语言/字体）都在本机完成，不上报任何遥测。完整的数据流向与暴露点分析见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 开发

```bash
npm test   # 运行主机（125 项）与客户端（22 项）单元测试，无需 dsh 实例
```

测试覆盖：分类器（词表分级 + LLM 语境裁决/消歧/失败降级/异步预分类）、区域判定（含反向目标）、
状态机、llm/stream 合成流替换、ended reject、日期隐写改写、投影折叠、状态路由
（GET/POST/冲突/同源校验/模型目录/分类自测）、客户端 select 契约、两代 settings 模型
（无 `register` 宿主上的 Config 导出 / volatile 活值读取 / 关闭后不留结束态 / ipCheck 默认不外呼）。

## 许可证

[MIT](LICENSE)
