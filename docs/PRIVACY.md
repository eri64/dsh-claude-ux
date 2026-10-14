# 隐私与信息暴露审查（dsh-claude-ux v1.0.0）

> 审查日期：2026-08-15。审查对象：`lib/index.js`（主机）、`lib/client.js`（浏览器）。

## 结论

- 插件**不含任何遥测、统计、崩溃上报代码**；不读取账号信息、支付信息、手机号、身份证件、浏览历史、cookie、localStorage 或其它站点的数据。
- 默认配置（`enabled: false`、`ipCheck: false`、`webRtcCheck: false`）下，**插件不与任何外部服务通信**——所有检测均在本机完成。
- 需要用户知情的信息暴露点共 3 类，全部为**可选项或设计使然**，默认关闭/可控：
  1. 可选的公网 IP 查询（ipinfo.io / ip-api.com）——**默认关闭**；
  2. 可选的 WebRTC STUN 探测（Google stun.l.google.com）——**默认关闭**；
  3. 设计使然的隐写标记——随系统提示词发送给 LLM 提供方（正常请求本就包含提示词）。

## 数据流向清单

| 数据 | 流向 | 外部? |
|---|---|---|
| 时区 / 系统语言 / 注册表语言 / 代理环境变量 / 代理注册表 | 本机读取 → 本地判定 | 否 |
| 代理/BaseURL 域名黑名单匹配 | 本机（env 值与内置名单做包含匹配） | 否 |
| 公网 IP 归属 | `https://ipinfo.io/json` → 失败回退 `http://ip-api.com/json` | **是（`ipCheck`，默认关）** |
| 浏览器语言 / 中文字体 | 浏览器 → 本机 web server（127.0.0.1 loopback） | 否 |
| WebRTC 公网 IP | `RTCPeerConnection` + Google STUN | **是（`webRtcCheck`，默认关）** |
| 消息文本分类（辱骂/有害/自伤） | 本机正则匹配 | 否 |
| 隐写标记（日期格式 / Unicode 撇号） | 注入系统提示词 → 随请求发送给 LLM 提供方 | 是（设计使然） |
| 设置与浏览器指纹 | 持久化到 profile 的 `cordis.patch.yml` 的 `claude` 条目（旧宿主为 `~/.dsh/settings.yaml`） | 否 |
| 判定/信号明细 | 本机日志 + `/_dsh/claude/status`（loopback） | 否 |

## 逐项说明

### 1. 公网 IP 查询（可选，默认关闭）
- 触发条件：`region.ipCheck: true`；结果缓存 10 分钟；判定失败 fail-open（不影响正常使用）。
- 发送内容：本机公网 IP + User-Agent `dsh-claude/1.0`。响应只用于读取国家代码，不存储、不上报。
- 说明：`https://ipinfo.io/json` 为主，`http://ip-api.com/json` 为明文 HTTP 回退——回退链路理论上可被中间人篡改响应，但影响仅限于本机区域判定（非数据泄露）；介意者可保持 `ipCheck: false`。

### 2. WebRTC STUN 探测（可选，默认关闭）
- 触发条件：`region.webRtcCheck: true`（设置页可开关）。
- 说明：STUN 协议的工作方式决定了**公网 IP 会发送给 STUN 服务器**（Google stun.l.google.com:19302）。仅在开启时发生；默认关闭。

### 3. 隐写标记（设计使然）
- 复刻 Claude 的"把检测结果编进系统提示词"手法：CN 判定 → 日期格式 `2026-06-30` 变 `2026/06/30`；黑名单命中 → 撇号 U+2019 变 U+02BC。
- 标记随系统提示词发送给 LLM 提供方（DeepSeek / opencode 等）——但提示词本身就在每次请求中发送，插件**没有增加任何新的传输内容**；标记只含两个 bit（是否命中目标 / 是否命中黑名单），不含账号、路径、消息正文或其它个人信息。
- 若你导出/分享会话或提示词，标记会暴露"该会话被判定为目标用户"这一事实。

### 4. 本地持久化
- 全局键（阈值、文案、浏览器指纹：语言/字体/WebRTC IP）由 DSH 的设置服务写入当前 profile 的
  `cordis.patch.yml` 的 `claude` 条目；dsh ≤ 0.1.6 落在 `~/.dsh/settings.yaml` 的 `claude` 段。
  两条路径都是本地文件，内容相同。全部本地。
- 若你把 `~/.dsh` 纳入版本控制，建议在 gitignore 中加入 `.dsh/`（该目录还包含 `.credentials.yaml` 等敏感文件）。

### 5. 进程与系统访问
- `reg query` 只读两个注册表键（`Control Panel\International` 的语言、`Internet Settings` 的代理开关/服务器）；参数为静态常量，无命令注入面。
- 读取 env（LANG/LC_*/代理变量/BaseURL 变量）仅用于本地匹配；黑名单命中明细只进本机日志。

### 6. 浏览器侧
- 不访问 `localStorage` / `sessionStorage` / `document.cookie` / `indexedDB`。
- `fetch` 仅指向本机 `/_dsh/claude/status`（同源 loopback）。
- 语言/字体测量为纯本地 API。

### 7. 状态路由攻击面
- `GET /_dsh/claude/status`：返回设置值 + 判定明细（含公网 IP 与 org，若启用了 IP 查询）。无鉴权——**任何能访问 3080 端口的人可读取**。
- `POST /_dsh/claude/status`：同源校验（origin/host 比对）+ settings revision 冲突检测；写入经 schemastery schema 校验。
- 建议保持 dsh web 仅监听 loopback（默认如此）；不要将 3080 暴露到局域网/公网。

### 8. 供应链
- 唯一运行时依赖 `schemastery@3.18.0`（npm，固定版本）。发布时建议保留锁文件。

## 发布前核查（已完成）

- [x] `lib/` 内无绝对路径 / 用户名 / 机器名
- [x] 仓库不含 `~/.dsh/settings.yaml`、profile 的 `cordis.patch.yml`（其中含 credential 引用）、`.credentials.yaml`、会话数据
- [x] 测试脚本相对导入（`../lib/*`），不引用本机路径
- [x] `package.json` 的 `repository.url` 为真实仓库地址
- [x] 提交使用 `users.noreply.github.com` 邮箱，LICENSE 保留「contributors」署名

## 变更记录

- v1.0.0：`ipCheck` 与 `webRtcCheck` 默认改为 `false`（此前为 `true`）；新增 `webRtcCheck` 设置项与设置页开关；新增本审查文档。
