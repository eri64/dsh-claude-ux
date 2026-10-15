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

## 安装（一条命令，要求 DSH >= 0.2.0）

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:eri64/dsh-claude-ux
```

包内自带注册条目（`dsh.bundle`），`dsh plugin` 安装后**自动注册**，无需手动改任何配置文件。
更新（升级到最新版）也是同一条命令。

### 启用

1. 重启 web profile（`dsh web`），浏览器硬刷新。
2. 设置页左侧标签栏出现 **「Claude 风控」** 独立标签（与视觉工具插件同款）：
   总开关、风控目标（中国/非中国用户反向开关）、区域策略、实时检测状态
   （`/_dsh/claude/status`）、阈值与文案。
3. **默认关闭**（`enabled: false`，避免把自己锁在外面）；打开总开关并「保存并应用」后即时生效。

> 校验安装是否成功：浏览器访问本机 dsh web 的 `/_dsh/claude/status`
> （默认 `http://127.0.0.1:3080/_dsh/claude/status`），返回 `{"ok":true,...}` 即主机插件已加载。

### 自定义默认配置（可选）

内置默认值开箱即用；设置页可改的字段保存即生效。需要覆盖 patch 级选项
（`minSignals` / `ipCheck` / `blockOnUnknown` / `blacklist` / `cnTimezones` / 词表等，
改后需重启）时，在 `~/.dsh/profiles/web/cordis.patch.yml` 里追加 id 定向覆盖，
参考 [examples/cordis.patch.yml](examples/cordis.patch.yml)（不要二次 `insert` 同名插件）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关（设置页可改） |
| `region.target` | `cn` | 风控谁：`cn`=中国用户 \| `non-cn`=非中国用户（反向） |
| `region.policy` | `block` | `block`=拒绝回复 \| `observe`=只记录+隐写标记 \| `off`=关闭 |
| `region.minSignals` | `2` | 信号分阈值（strong=2 / medium=1 / weak=0.5） |
| `region.refusalEndsAfter` | `3` | 拒绝 N 次后结束会话（区域「封号」阶梯） |
| `region.showAttempts` | `true` | 拒绝文案追加「第 N/M 次尝试」 |
| `region.promptEnforcement` | `true` | 目标命中时注入模型级区域指令 |
| `region.ipCheck` | `false` | 公网 IP 归属查询（联系 ipinfo.io / ip-api.com，**默认关闭**） |
| `region.webRtcCheck` | `false` | WebRTC IP 探测（联系 Google STUN，**默认关闭**） |
| `region.blockOnUnknown` | `false` | 完全无信号时是否视为目标命中（fail-closed） |
| `region.cnTimezones` / `region.blacklist` | 内置 | 中国时区表 / 代理中转域名黑名单（可整体替换） |
| `abuse.*` | 内置 | 辱骂/严重有害/自伤词表（正则，可整体替换）；`strongPatterns`/`weakPatterns` 分级 |
| `abuse.llm.mode` | `all` | 辱骂判定模式：`all`=全部消息 LLM 语境判定（最准）\| `fuzzy`=仅弱词调 LLM \| `off`=纯词表 |
| `abuse.llm.enabled` | `true` | LLM 分类总开关 |
| `abuse.llm.provider/model` | 跟随会话 | 分类请求的模型（缺省复用会话主模型 / agent-default-model） |
| `steganography` | `true` | 隐写标记 |

设置页可改（保存即生效，无需重启）：总开关、风控目标/策略、拒绝后结束次数、
警告/结束阈值、辱骂/有害开关、隐写、WebRTC 检测、LLM 判定模式/模型/超时、五条文案。
其中分类模型**下拉直接列出 DSH 已配置的模型**（扫描 settings 的 providers 命名空间），留空=跟随会话主模型，「自定义…」可手填目录外的模型。

patch 级（改 `cordis.patch.yml` 后重启）：`minSignals / showAttempts / promptEnforcement / ipCheck / ipTimeoutMs / blockOnUnknown / cnTimezones / blacklist / abuse.llm.enabled / 五组词表`。

## 隐私

默认配置下（`ipCheck: false`、`webRtcCheck: false`）**插件不与任何外部服务通信**：所有检测（时区、语言、代理、黑名单、浏览器语言/字体）都在本机完成，不上报任何遥测。完整的数据流向与暴露点分析见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 开发

```bash
npm test   # 运行主机（137 项）与客户端（23 项）单元测试，无需 dsh 实例
```

测试覆盖：分类器（词表分级 + LLM 语境裁决/消歧/失败降级/异步预分类）、区域判定（含反向目标）、
状态机、llm/stream 合成流替换、ended reject、日期隐写改写、投影折叠、Config 形态互转、
状态路由（GET/POST/冲突/同源校验/模型目录/分类自测）、客户端 ended 观察器与 select 契约。

## 版本

- v2.0.0：DSH 0.2.x 适配重写——设置改走 Config 派生表单（volatile 热更）、投影改
  `stateSchema` + `wire`、Chat ended 面板改 pendingInteraction 驱动、新会话导航改
  uiWorkspace、浏览器指纹只存内存（不再写入配置）。patch 结构（`region.*` /
  `abuse.*` / `messages.*`）与 v1 兼容，既有覆盖无需改动。
- v1.0.0：初版（DSH 0.1.x）。

## 许可证

[MIT](LICENSE)
