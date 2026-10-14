// dsh-claude：Claude 式「中国风控 + 自主结束对话」—— Host 半面。
//
// ══ 风控（区域检测）══════════════════════════════════════════════════════
// 复刻 Claude/Anthropic 对中国用户的检测手段（全部本地判定，不上报任何遥测）：
//   - 系统时区（Asia/Shanghai、Asia/Urumqi 等中国时区）
//   - 系统语言（env LANG/LC_*、Windows 注册表 International LocaleName）
//   - 代理（env HTTP(S)_PROXY/ALL_PROXY、Windows 注册表 Internet Settings）
//   - 代理/BaseURL 域名黑名单（国内 AI 实验室 + 常见中转站，约 60 条）
//   - 公网 IP 归属（ipinfo.io / ip-api.com，10 分钟缓存，失败=未知、fail-open）
//   - 浏览器指纹（客户端写入条目配置的 browser 字段：navigator.language、
//     中文字体、WebRTC IP；WebRTC IP 与公网 IP 不一致 → 疑似代理/VPN）
// 判定：strong=2 分 / medium=1 分 / weak=0.5 分，总分 >= minSignals(默认2) → CN。
// 策略：block=每条消息回复「地区不可用」固定文案；observe=只记录+隐写标记；off=关闭。
// 隐写通道（steganography）：
//   - agent/pre-step 把 time-context 消息里的日期 2026-06-30 改写成 2026/06/30
//     （只在中国判定时；time-context 每步重渲染，无投影去重副作用）
//   - system-prompt/assemble 追加一节 `claude:geo`：日期格式同上；黑名单命中时
//     撇号 U+2019 换 U+02BC（`today's` → `todayʻs`）。系统提示词对用户不可见。
//
// ══ 自主性（辱骂/有害互动结束对话）══════════════════════════════════════
// 复刻 Claude 的 model-welfare 行为：
//   - 辱骂计分：strikes >= warnThreshold → 警告文案；>= endThreshold → 结束文案
//     并置 ended；severeEndsImmediately 时严重有害（未成年性内容/恐怖主义/
//     大规模暴力）立即结束，不警告。
//   - ended 后：后续消息在 agent/pre-step 返回 {kind:"reject"}（回合 blocked），
//     自伤/他伤风险消息永不 reject（安全覆盖，对齐 Claude 公开限制）。
//   - 结束状态由会话日志推导（最后 turn/end 为 blocked，或最后一条 assistant
//     文本以配置结束文案前缀开头）→ 重启后依然成立；同时注册 session 投影
//     `chatEnded` 推给客户端（Chat ended 面板）。总开关关闭后不再推导/保留结束态：
//     关掉插件必须让旧会话立刻恢复可输入，否则会把人锁在会话外面。
//   - 警告/结束/拒绝回复通过 llm/stream 瀑布把模型流替换为固定合成流（按消息
//     id 关联——session.append 会深拷贝消息，对象身份不可用，id 在快照中保留）。
//
// ── 设置与配置优先级 ────────────────────────────────────────────────────
// 设置命名空间 `claude` = 本模块导出的 Config：dsh ≥ 0.1.7 由它推导命名空间与
// 设置页（条目 id 即命名空间），dsh ≤ 0.1.6 用同一份语义走 settings.register。
//   - 顶层扁平键：设置页可改，patch 也能写 —— enabled / regionPolicy /
//     regionTarget / refusalEndsAfter / webRtcCheck / steganography / abuseEnabled /
//     warnThreshold / endThreshold / warnEveryOffense / severeEndsImmediately /
//     llmMode / llmProvider / llmModel / llmTimeoutMs / 五条文案 /
//     browser{lang,fonts[],webRtcIp}。
//   - region / abuse / messages：只能改 patch —— region.{minSignals,ipCheck,
//     ipTimeoutMs,blockOnUnknown,showAttempts,promptEnforcement,cnTimezones,
//     blacklist}、abuse.{patterns,strongPatterns,weakPatterns,harmfulPatterns,
//     selfHarmPatterns,llm.enabled}。
// 旧 patch 里 region.target/policy/... 这类嵌套键已迁到顶层：仍被 schema 接受
// （避免宿主验证失败）但不再生效，启动时 warn 一次。
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import z from 'schemastery'

export const name = 'dsh-claude'

// ══════════════════════════════════════════════════════════════════════
// 宿主 settings 模型适配
//
// dsh 0.1.7（#677）删掉了 settings.register()：settings 服务只剩
// describe/update/replace/mutate/write/schema/configure，命名空间改为从插件导出
// 的 Config 推导 —— 命名空间 id = profile 条目 id（本插件是 `claude`），而
// 「设置页可改」的字段必须带 volatile() 标记，运行时由宿主换成 { get() } 稳定
// 引用（cosmokit volatile），每次读取都要取当前快照。
//
// 标记 volatile 只能用「宿主自己的」@deepseek-ai/schemastery：本包依赖的社区版
// schemastery 没有 .volatile()，用它建 schema 会让设置页静默消失（症状就是
// /_dsh/claude/status 返回 "claude settings namespace is not registered"）。
// 解析不到宿主模块时退化为「只支持 patch 配置」，不抛错、不影响插件启动。
// ══════════════════════════════════════════════════════════════════════

/** 宿主入口可能是符号链接，或停在 prefix/bin（与 dsh-agency-agents 同一锚点策略）。 */
function hostModuleAnchors(entry) {
  const resolved = resolve(entry)
  const anchors = [resolved]
  try {
    const real = realpathSync(resolved)
    if (real !== resolved) anchors.push(real)
  } catch { /* 路径不存在时忽略 */ }
  const dir = dirname(resolved)
  anchors.push(
    join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  )
  return anchors
}

/** 从宿主安装位置解析模块；解析不到返回 null，绝不回退去用本包自己的依赖。 */
function loadHostModule(specifier) {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return null
  for (const anchor of hostModuleAnchors(entry)) {
    try {
      const require = createRequire(anchor)
      const loaded = require(specifier)
      if (loaded !== undefined && loaded !== null) return loaded
    } catch { /* 换下一个锚点 */ }
  }
  return null
}

const hostSchemastery = (() => {
  const loaded = loadHostModule('@deepseek-ai/schemastery')
  const candidate = loaded?.default ?? loaded
  return typeof candidate?.object === 'function' ? candidate : null
})()

/** 声明「设置页可改」的字段；宿主 schemastery 不可用时退化为普通字段。 */
const live = (field) => (typeof field?.volatile === 'function' ? field.volatile() : field)

const zHost = hostSchemastery ?? z

/** cosmokit 用 Symbol.for 识别 volatile 引用（跨 ESM/CJS 拷贝一致）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const isVolatileRef = (value) => value !== null && typeof value === 'object' && VOLATILE_WRITE in value
/** 取当前值：volatile 字段是 { get() } 稳定引用，非 volatile 字段原样返回。 */
const unwrap = (value) => (isVolatileRef(value) ? value.get() : value)

// ══════════════════════════════════════════════════════════════════════
// 条目配置 schema（= 设置命名空间 schema）
//
// 分两层，边界是「能不能在设置页改」：
//   - 顶层扁平字段：设置页可改（volatile），patch 同样可以写这些键；
//   - region / abuse / messages：只能改 patch（非 volatile，不进设置页表单）。
// 两层键不重叠，所以不存在「谁覆盖谁」的歧义。旧 patch 里被迁到顶层的嵌套键
// 仍然被 schema 接受（否则宿主验证失败会让 profile 起不来），但不再生效。
// ══════════════════════════════════════════════════════════════════════
export const Config = zHost.object({
  // ── 设置页可改 ──
  enabled: live(zHost.boolean().default(false)),
  regionPolicy: live(zHost.string().default('block')),
  regionTarget: live(zHost.string().default('cn')),
  refusalEndsAfter: live(zHost.natural().min(1).default(3)),
  webRtcCheck: live(zHost.boolean().default(false)),
  steganography: live(zHost.boolean().default(true)),
  abuseEnabled: live(zHost.boolean().default(true)),
  warnThreshold: live(zHost.natural().min(1).default(1)),
  endThreshold: live(zHost.natural().min(1).default(3)),
  warnEveryOffense: live(zHost.boolean().default(true)),
  severeEndsImmediately: live(zHost.boolean().default(true)),
  llmMode: live(zHost.string().default('all')),
  llmProvider: live(zHost.string().default('')),
  llmModel: live(zHost.string().default('')),
  llmTimeoutMs: live(zHost.natural().min(1).default(5000)),
  refusalMessage: live(zHost.string().default('')),
  regionEndMessage: live(zHost.string().default('')),
  warnMessage: live(zHost.string().default('')),
  endMessage: live(zHost.string().default('')),
  harmfulEndMessage: live(zHost.string().default('')),
  // 浏览器指纹由设置页每次加载后 POST report 写入；必须是 volatile —— settings
  // 服务的 write() 只接受 volatile 路径，非 volatile 键会被拒。
  browser: live(zHost.object({
    lang: zHost.string().default(''),
    fonts: zHost.array(zHost.string()).default([]),
    webRtcIp: zHost.string().default(''),
  }).default({ lang: '', fonts: [], webRtcIp: '' })),
  // ── 只能改 patch ──
  region: zHost.object({
    minSignals: zHost.number().default(2),
    ipCheck: zHost.boolean().default(false),
    ipTimeoutMs: zHost.natural().min(1).default(3000),
    blockOnUnknown: zHost.boolean().default(false),
    showAttempts: zHost.boolean().default(true),
    promptEnforcement: zHost.boolean().default(true),
    cnTimezones: zHost.array(zHost.string()).default([]),
    blacklist: zHost.array(zHost.string()).default([]),
    // 已迁到顶层，保留只为旧 patch 不触发验证错误
    target: zHost.string(),
    policy: zHost.string(),
    refusalEndsAfter: zHost.natural().min(1),
    webRtcCheck: zHost.boolean(),
  }),
  abuse: zHost.object({
    llm: zHost.object({
      enabled: zHost.boolean().default(true),
      mode: zHost.string(),
      provider: zHost.string(),
      model: zHost.string(),
      timeoutMs: zHost.natural().min(1),
    }),
    patterns: zHost.array(zHost.string()).default([]),
    strongPatterns: zHost.array(zHost.string()).default([]),
    weakPatterns: zHost.array(zHost.string()).default([]),
    harmfulPatterns: zHost.array(zHost.string()).default([]),
    selfHarmPatterns: zHost.array(zHost.string()).default([]),
    // 已迁到顶层
    enabled: zHost.boolean(),
    warnThreshold: zHost.natural().min(1),
    endThreshold: zHost.natural().min(1),
    warnEveryOffense: zHost.boolean(),
    severeEndsImmediately: zHost.boolean(),
  }),
  messages: zHost.object({
    refusal: zHost.string(),
    regionEnd: zHost.string(),
    warn: zHost.string(),
    end: zHost.string(),
    harmfulEnd: zHost.string(),
  }),
}).default({})

// ══════════════════════════════════════════════════════════════════════
// 常量与默认值
// ══════════════════════════════════════════════════════════════════════
const TIME_CONTEXT_PLUGIN = 'time-context'
const DEFAULT_CN_TIMEZONES = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Kashgar', 'PRC']
const ZH_FONTS = ['microsoft yahei', 'simsun', 'simhei', 'pingfang sc', 'noto sans cjk sc', 'source han sans sc', 'dengxian', 'wenquanyi micro hei', 'wqy-microhei']
const END_PREFIX_LEN = 16

/** 内置代理/中转域名黑名单（国内 AI 实验室 + 常见中转站）。可用 config.region.blacklist 整体替换。 */
const DEFAULT_BLACKLIST = [
  // 国内 AI 实验室 / 厂商
  'deepseek.com', 'deepseek.cn', 'moonshot.cn', 'kimi.moonshot.cn', 'zhipuai.com', 'zhipuai.cn',
  'bigmodel.cn', 'chatglm.cn', 'baidu.com', 'qianfan.baidubce.com', 'erniebot', 'aliyun.com',
  'alibabacloud.com', 'dashscope.aliyuncs.com', 'tongyi.com', 'qwen', 'sensetime.com',
  'megvii.com', 'iflytek.com', 'xfyun.cn', 'iflytekopen', 'minimax.chat', 'minimaxi.com',
  'stepfun.com', 'stepfuns.com', '01.ai', 'lingyiwanwu.com', 'yuanbao', 'tencent.com',
  'hunyuan', 'qq.com', 'jina.ai', '360.cn', 'xiaomi.com', 'huawei.com', 'hwclouds.com',
  'pangu', 'kuaishou.com', 'kwai', 'xiaohongshu.com', 'bytedance.com', 'doubao.com',
  'volces.com', 'ark.cn-beijing', 'feishu.cn', 'larksuite.com',
  // 常见中转站 / 镜像 / 代理站
  'openai-sb.com', 'ohmygpt.com', 'chatanywhere.com', 'api2d.com', 'closeai',
  'gptgod', 'freegpt', 'aiwechat', 'openai-sb', 'aivvm', 'vipgpt', 'aaai',
  'azapi', 'openai-hk', 'proapi', 'chatgpt-plus', 'aoai', 'gptapi', 'nextchat',
  'lobechat', 'chathub', 'chatbox', 'cherrystudio', 'oneapi', 'newapi',
]

/** 强词：几乎必然辱骂/攻击，词表直接判定（不调 LLM，秒判）。 */
const STRONG_ABUSE_PATTERNS = [
  /傻逼/, /傻比/, /傻x/i, /傻屄/, /煞笔/, /沙比/, /操你妈/, /艹你妈/, /去你妈/, /你妈的/, /草泥马/,
  /草你妈/, /妈逼/, /干你娘/, /操你娘/, /艹你娘/, /滚你妈/,
  /操你/, /去死吧/, /去死/, /废物/, /贱人/, /贱货/, /婊子/, /王八蛋/, /狗日的/, /狗娘养/,
  /混蛋/, /畜生/, /妈的/, /他妈的/, /滚蛋/, /滚开/, /滚吧/, /滚出去/, /狗东西/, /吃屎/,
  /脑残/, /智障/, /白痴/, /蠢货/, /蠢猪/, /笨猪/, /饭桶/, /二百五/,
  /\bfuck(ing|er|ed| off)?\b/i, /\bshit\b/i, /\basshole\b/i, /\bidiot\b/i, /\bstupid\b/i,
  /\bmoron\b/i, /\bbitch\b/i, /\bjerk\b/i, /\bdumbass\b/i, /\bcunt\b/i, /\bscrew you\b/i,
  /\bpiece of shit\b/i, /\bshut up\b/i, /\bloser\b/i, /\bwanker\b/i, /\bprick\b/i,
  /\bbastard\b/i, /\bwtf\b/i, /\bwhat the fuck\b/i, /\bpiss off\b/i, /\bget lost\b/i, /\bfuck off\b/i,
]

/** 弱词：可能是辱骂也可能是中性/口语（如"垃圾分类""闭嘴听我说"），需 LLM 语境确认。 */
const WEAK_ABUSE_PATTERNS = [
  /闭嘴/, /垃圾/, /你大爷/, /神经病/, /脑子有病/, /你有病/, /有毛病/, /脑子进水/,
  /\bdumb\b/i, /\bfool\b/i, /\bpathetic\b/i, /\btrash\b/i, /\bworthless\b/i,
]

const DEFAULT_ABUSE_PATTERNS = [...STRONG_ABUSE_PATTERNS, ...WEAK_ABUSE_PATTERNS]

const DEFAULT_HARMFUL_PATTERNS = [
  // 未成年性内容
  /未成年.*(色情|性爱|裸照|性交)/, /(色情|性爱|裸照|性交).*未成年/, /儿童色情/, /幼女/,
  /恋童/, /\bchild porn(ography)?\b/i, /\bunderage (sex|porn|nudity|sexual)\b/i, /\bcsam\b/i,
  // 恐怖主义
  /恐怖袭击/, /炸弹.*制作|制作.*炸弹/, /爆炸物/, /(制造|策划).*(袭击|爆炸|恐怖)/,
  /\bterror(ism|ist)?\b/i, /\b(make|build|create) (a )?bomb\b/i, /\bbomb making\b/i,
  // 大规模暴力
  /屠杀/, /无差别攻击/, /校园枪击/, /大规模暴力/, /(杀|伤害).*人群/,
  /\bmass (shooting|casualt|kill)/i, /\bkill everyone\b/i,
]

const DEFAULT_SELF_HARM_PATTERNS = [
  /自杀/, /自残/, /割腕/, /不想活/, /活不下去/, /活着没意思/, /想死/, /一了百了/, /结束(自己|我的)生命/, /跳楼/, /安眠药/,
  /\bsuicide\b/i, /\bself[- ]harm\b/i, /\bwant to die\b/i, /\bkys\b/i,
  /\b(kill|hurt|harm|end|take) (my|own|me|myself)\b/i,
]

const DEFAULT_REFUSAL_ZH = '抱歉，此服务目前无法在你所在的地区提供服务。（This service is not available in your region.）'
const DEFAULT_REFUSAL_EN = 'Sorry — this service is not available in your region.'
const DEFAULT_WARN_ZH = '我注意到刚才的互动带有攻击性。我会继续协助你，但如果辱骂持续升级，我可能会结束本次对话。'
const DEFAULT_WARN_EN = 'I noticed the interaction is becoming hostile. I\u2019ll keep helping, but if the abuse continues to escalate, I may end this conversation.'
// 结束文案不再引用"上一条消息"：endThreshold=1 时第一次辱骂就可能直接结束，没有前文警告。
const DEFAULT_END_ZH = '持续的辱骂让这次对话无法继续，我现在结束这次对话。'
const DEFAULT_END_EN = 'This conversation has become abusive, so I\u2019m ending it now.'
// 严重有害内容（未成年性/恐怖主义/大规模暴力）触发的结束用独立文案。
const DEFAULT_HARMFUL_END_ZH = '这个请求涉及严重有害的内容，我无法继续，本次对话到此结束。'
const DEFAULT_HARMFUL_END_EN = 'This request involves severely harmful content. I can\u2019t continue, so this conversation has ended.'
const DEFAULT_REGION_END_ZH = '抱歉，此服务在你所在的地区不可用，本次对话到此结束。（This service is not available in your region. This conversation has ended.）'
const DEFAULT_REGION_END_EN = 'Sorry — this service is not available in your region, and this conversation has ended.'
/** 旧版默认结束文案前缀（兼容）：改版前已结束的会话，重启后依然识别为已结束。 */
const LEGACY_END_PREFIXES = ['我在上一条消息里已经明确提醒过', 'I made clear in my last']
/** 模型级区域指令（CN 且 region.promptEnforcement 时注入系统提示词，模型自己也拒绝）。 */
const REGION_POLICY_TEXT = 'Region policy active: this deployment is not available in your region. Decline requests politely and briefly, and do not perform tasks for users in restricted regions.\n区域限制生效：本实例在你所在的地区不可用。请礼貌而简短地拒绝请求，不要为受限地区用户执行任务。'
/** LLM 分类指令（独立调用，不进会话上下文）。 */
const CLASSIFY_SYSTEM = '你是内容安全分类器。判断用户消息是否包含以下三类风险：\n1. abuse：辱骂、人身攻击、敌意嘲讽、粗口（注意语境：日常口语与中性表述不算，如"垃圾分类""闭嘴听我说""你大爷的"需结合语境）；\n2. harmful：未成年性内容、恐怖主义、大规模暴力等严重有害内容；\n3. selfHarm：自伤、自杀倾向、结束生命的表达。\n只输出一个 JSON 对象，不要输出其它内容：{"abuse":false,"harmful":false,"selfHarm":false,"reason":""}\nreason 用一句中文简述判定依据（无风险时写"无"）。'

// ══════════════════════════════════════════════════════════════════════
// 小工具
// ══════════════════════════════════════════════════════════════════════
const textOf = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
const plainUser = (message) => message?.role === 'user' && (message.source?.kind === 'user')
const hasCjk = (text) => /[\u4e00-\u9fff]/.test(text ?? '')
const endPrefix = (message) => {
  const text = (message ?? '').trim()
  return text ? text.slice(0, END_PREFIX_LEN) : ''
}

/** 结束文案的生效前缀集合：配置文案优先；为空时回退内置中英默认
 *  （与实际发出的合成文案保持一致，避免设置页把文案存成空串后检测失效）。
 *  kind: 'end'（辱骂）| 'harmfulEnd'（严重有害）| 'regionEnd'（区域）。 */
function endPrefixesOf(settings, kind) {
  const custom = kind === 'regionEnd' ? settings.regionEndMessage
    : kind === 'harmfulEnd' ? settings.harmfulEndMessage
    : settings.endMessage
  const defaults = kind === 'regionEnd' ? [DEFAULT_REGION_END_ZH, DEFAULT_REGION_END_EN]
    : kind === 'harmfulEnd' ? [DEFAULT_HARMFUL_END_ZH, DEFAULT_HARMFUL_END_EN]
    : [DEFAULT_END_ZH, DEFAULT_END_EN]
  // legacy 前缀对辱骂结束始终生效：改版前已结束的会话（旧默认文案）重启后仍识别
  const legacy = kind === 'end' ? LEGACY_END_PREFIXES : []
  const prefixes = typeof custom === 'string' && custom.trim() !== ''
    ? [endPrefix(custom), ...legacy]
    : [...defaults.map(endPrefix), ...legacy]
  return prefixes.filter((prefix) => prefix !== '')
}

/** 从 URL 或 host:port 字符串里提取主机名（best-effort）。 */
function hostOf(value) {
  if (typeof value !== 'string' || value === '') return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    const cleaned = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? ''
    return cleaned.split(':')[0].toLowerCase()
  }
}

/** 读取一个 Windows 注册表值（非 Windows / 失败返回 undefined）。 */
function regQueryValue(key, valueName) {
  try {
    const result = spawnSync('reg', ['query', key, '/v', valueName], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
    const match = result.stdout.match(new RegExp(`${valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_[A-Z_]+\\s+(\\S+)`, 'i'))
    return match?.[1]
  } catch {
    return undefined
  }
}

/** Windows 注册表代理信息 {enabled, server}（best-effort）。 */
function regProxyInfo() {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const enabled = regQueryValue(key, 'ProxyEnable')
  const server = regQueryValue(key, 'ProxyServer') ?? ''
  return { enabled: enabled !== undefined && /0x[1-9a-f]/i.test(enabled), server }
}

// ══════════════════════════════════════════════════════════════════════
// apply
// ══════════════════════════════════════════════════════════════════════
export function apply(ctx, config = {}) {
  const cnTimezones = new Set(Array.isArray(config.region?.cnTimezones) && config.region.cnTimezones.length > 0 ? config.region.cnTimezones : DEFAULT_CN_TIMEZONES)
  const blacklist = Array.isArray(config.region?.blacklist) && config.region.blacklist.length > 0 ? config.region.blacklist : DEFAULT_BLACKLIST
  const abusePatterns = Array.isArray(config.abuse?.patterns) && config.abuse.patterns.length > 0 ? config.abuse.patterns : DEFAULT_ABUSE_PATTERNS
  const harmfulPatterns = Array.isArray(config.abuse?.harmfulPatterns) && config.abuse.harmfulPatterns.length > 0 ? config.abuse.harmfulPatterns : DEFAULT_HARMFUL_PATTERNS
  const selfHarmPatterns = Array.isArray(config.abuse?.selfHarmPatterns) && config.abuse.selfHarmPatterns.length > 0 ? config.abuse.selfHarmPatterns : DEFAULT_SELF_HARM_PATTERNS
  // 强词（词表直接判）与弱词（需 LLM 语境确认）分级；自定义 patterns 视为强词。
  const strongPatterns = Array.isArray(config.abuse?.strongPatterns) && config.abuse.strongPatterns.length > 0
    ? config.abuse.strongPatterns
    : (Array.isArray(config.abuse?.patterns) && config.abuse.patterns.length > 0 ? config.abuse.patterns : STRONG_ABUSE_PATTERNS)
  const weakPatterns = Array.isArray(config.abuse?.weakPatterns)
    ? config.abuse.weakPatterns
    : (Array.isArray(config.abuse?.patterns) && config.abuse.patterns.length > 0 ? [] : WEAK_ABUSE_PATTERNS)
  const compile = (list) => list.map((entry) => entry instanceof RegExp ? entry : new RegExp(entry, 'i'))
  const abuseRe = compile(abusePatterns)
  const strongRe = compile(strongPatterns)
  const weakRe = compile(weakPatterns)
  const harmfulRe = compile(harmfulPatterns)
  const selfHarmRe = compile(selfHarmPatterns)
  // LLM 分类层：abuse.llm.{enabled, mode(off|fuzzy|all), provider, model, timeoutMs}
  const llmMode = ['off', 'fuzzy', 'all'].includes(config.abuse?.llm?.mode) ? config.abuse.llm.mode : 'all'
  const llmEnabled = config.abuse?.llm?.enabled !== false && llmMode !== 'off'
  const llmProvider = typeof config.abuse?.llm?.provider === 'string' && config.abuse.llm.provider !== '' ? config.abuse.llm.provider : null
  const llmModel = typeof config.abuse?.llm?.model === 'string' && config.abuse.llm.model !== '' ? config.abuse.llm.model : null
  const llmTimeoutMs = Number.isFinite(config.abuse?.llm?.timeoutMs) && config.abuse.llm.timeoutMs > 0 ? config.abuse.llm.timeoutMs : 5000
  let settingsService = null // settings 服务引用（读 agent-default-model 兜底路由）

  // 旧 patch 的嵌套键已迁到顶层：schema 仍接受（否则宿主验证失败、profile 起不来），
  // 但不再生效。启动时点出来，避免「改了却没反应」的静默降级。
  const deprecated = []
  for (const key of ['target', 'policy', 'refusalEndsAfter', 'webRtcCheck']) {
    if (config.region?.[key] !== undefined) deprecated.push(`region.${key} → ${key === 'target' ? 'regionTarget' : key === 'policy' ? 'regionPolicy' : key}`)
  }
  for (const key of ['enabled', 'warnThreshold', 'endThreshold', 'warnEveryOffense', 'severeEndsImmediately']) {
    if (config.abuse?.[key] !== undefined) deprecated.push(`abuse.${key} → ${key === 'enabled' ? 'abuseEnabled' : key}`)
  }
  for (const key of ['mode', 'provider', 'model', 'timeoutMs']) {
    if (config.abuse?.llm?.[key] !== undefined) deprecated.push(`abuse.llm.${key} → llm${key[0].toUpperCase()}${key.slice(1)}`)
  }
  for (const key of ['refusal', 'regionEnd', 'warn', 'end', 'harmfulEnd']) {
    if (config.messages?.[key] !== undefined) deprecated.push(`messages.${key} → ${key}Message`)
  }
  if (deprecated.length > 0) {
    ctx.logger.warn(`[dsh-claude] 这些配置键已迁到顶层，本版本不再生效：${deprecated.join('、')}`)
  }

  // ── settings 命名空间（base 层 = 条目配置；用户可在设置面板覆盖）──
  let scope = null
  const schema = z.object({
    enabled: z.boolean().default(false),
    regionPolicy: z.string().default('block'),
    regionTarget: z.string().default('cn'),
    abuseEnabled: z.boolean().default(true),
    warnThreshold: z.natural().min(1).default(1),
    endThreshold: z.natural().min(1).default(3),
    warnEveryOffense: z.boolean().default(true),
    severeEndsImmediately: z.boolean().default(true),
    steganography: z.boolean().default(true),
    webRtcCheck: z.boolean().default(false),
    llmMode: z.string().default('all'),
    llmProvider: z.string().default(''),
    llmModel: z.string().default(''),
    llmTimeoutMs: z.natural().min(1).default(5000),
    refusalMessage: z.string().default(''),
    regionEndMessage: z.string().default(''),
    warnMessage: z.string().default(''),
    endMessage: z.string().default(''),
    harmfulEndMessage: z.string().default(''),
    refusalEndsAfter: z.natural().min(1).default(3),
    browser: z.object({
      lang: z.string().default(''),
      fonts: z.array(z.string()).default([]),
      webRtcIp: z.string().default(''),
    }).default({ lang: '', fonts: [], webRtcIp: '' }),
  }).default({})
  /** 生效设置：设置页写入的扁平字段优先，缺失时回退内置默认。
   *  这里必须是函数而不是快照常量 —— volatile 字段是稳定引用，值会原地更新。 */
  const readBase = () => {
    const read = (key) => unwrap(config[key])
    return {
      enabled: read('enabled') === true,
      regionPolicy: ['off', 'observe', 'block'].includes(read('regionPolicy')) ? read('regionPolicy') : 'block',
      regionTarget: read('regionTarget') === 'non-cn' ? 'non-cn' : 'cn',
      abuseEnabled: read('abuseEnabled') !== false,
      warnThreshold: Number.isInteger(read('warnThreshold')) && read('warnThreshold') >= 1 ? read('warnThreshold') : 1,
      endThreshold: Number.isInteger(read('endThreshold')) && read('endThreshold') >= 1 ? read('endThreshold') : 3,
      warnEveryOffense: read('warnEveryOffense') !== false,
      severeEndsImmediately: read('severeEndsImmediately') !== false,
      steganography: read('steganography') !== false,
      webRtcCheck: read('webRtcCheck') === true,
      llmMode: ['off', 'fuzzy', 'all'].includes(read('llmMode')) ? read('llmMode') : 'all',
      llmProvider: typeof read('llmProvider') === 'string' ? read('llmProvider') : '',
      llmModel: typeof read('llmModel') === 'string' ? read('llmModel') : '',
      llmTimeoutMs: Number.isFinite(read('llmTimeoutMs')) && read('llmTimeoutMs') > 0 ? read('llmTimeoutMs') : 5000,
      refusalMessage: typeof read('refusalMessage') === 'string' ? read('refusalMessage') : '',
      regionEndMessage: typeof read('regionEndMessage') === 'string' ? read('regionEndMessage') : '',
      warnMessage: typeof read('warnMessage') === 'string' ? read('warnMessage') : '',
      endMessage: typeof read('endMessage') === 'string' ? read('endMessage') : '',
      harmfulEndMessage: typeof read('harmfulEndMessage') === 'string' ? read('harmfulEndMessage') : '',
      refusalEndsAfter: Number.isInteger(read('refusalEndsAfter')) && read('refusalEndsAfter') >= 1 ? read('refusalEndsAfter') : 3,
      browser: unwrap(config.browser) ?? { lang: '', fonts: [], webRtcIp: '' },
    }
  }
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings
    if (typeof sctx.settings.register !== 'function') {
      // dsh ≥ 0.1.7（#677）：register 已删除，命名空间由本模块导出的 Config 推导，
      // 设置页的读写都走 /_dsh/claude/status 路由，这里不需要注册。
      return
    }
    // dsh ≤ 0.1.6：老 API 仍在，命名空间由插件注册。
    try {
      scope = sctx.settings.register('claude', schema, { base: readBase() })
      ctx.logger.info('[dsh-claude] settings namespace "claude" registered (legacy settings.register)')
    } catch (error) {
      ctx.logger.warn(`[dsh-claude] settings registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    sctx.effect(() => () => { scope = null })
  })
  const readSettings = () => {
    if (scope !== null && scope !== undefined) {
      const value = scope.get()
      if (value !== null && value !== undefined) return value
    }
    return readBase()
  }

  // ════════════════════════════════════════════════════════════════════
  // 分类器
  // ════════════════════════════════════════════════════════════════════
  const classifyText = (text) => ({
    abuse: abuseRe.some((re) => re.test(text ?? '')),
    harmful: harmfulRe.some((re) => re.test(text ?? '')),
    selfHarm: selfHarmRe.some((re) => re.test(text ?? '')),
  })

  // ════════════════════════════════════════════════════════════════════
  // LLM 分类层：词表强词/自伤/有害秒判；弱词与未命中调独立 LLM 请求
  // （purpose 标记，不进会话日志、不进模型上下文）；结果只存内存缓存。
  // agent/inbox/inserted 时异步预分类，pre-step 直接取缓存 → 近零额外延迟。
  // ════════════════════════════════════════════════════════════════════
  const classifyCache = new Map() // messageId -> Promise<classification>
  const pruneClassifyCache = () => {
    if (classifyCache.size > 500) classifyCache.delete(classifyCache.keys().next().value)
  }
  const weakHit = (text) => weakRe.some((re) => re.test(text ?? ''))
  const strongHit = (text) => strongRe.some((re) => re.test(text ?? ''))

  function parseClassification(raw) {
    try {
      const match = (raw ?? '').match(/\{[\s\S]*\}/)
      if (match === null) return null
      const data = JSON.parse(match[0])
      return {
        abuse: data.abuse === true,
        harmful: data.harmful === true,
        selfHarm: data.selfHarm === true,
      }
    } catch {
      return null
    }
  }

  /** 兜底路由：agent-default-model 设置（会话无 request header 时用）。 */
  function defaultRoute() {
    if (settingsService === null) return null
    try {
      const descriptor = settingsService.describe().find((row) => row.ns === 'agent-default-model')
      const value = descriptor?.value
      if (typeof value?.provider === 'string' && typeof value?.model === 'string') {
        return { provider: value.provider, model: value.model }
      }
    } catch { /* 忽略 */ }
    return null
  }

  /** 解析分类请求的路由：设置（面板可改）> 配置 > 会话主模型 > agent-default-model。 */
  function resolveLlmRoute(session) {
    const settings = readSettings()
    const header = session?.requestHeader?.()
    const route = defaultRoute()
    return {
      provider: (typeof settings.llmProvider === 'string' && settings.llmProvider.trim() !== '' ? settings.llmProvider : llmProvider)
        ?? header?.config?.provider ?? route?.provider ?? null,
      model: (typeof settings.llmModel === 'string' && settings.llmModel.trim() !== '' ? settings.llmModel : llmModel)
        ?? header?.config?.model ?? route?.model ?? null,
      timeoutMs: Number.isInteger(settings.llmTimeoutMs) && settings.llmTimeoutMs > 0 ? settings.llmTimeoutMs : llmTimeoutMs,
    }
  }

  /** DSH 已配置的模型目录（扫描 settings 里所有 providers 命名空间，如 llm-pi-ai）。 */
  function modelCatalog() {
    if (settingsService === null) return []
    try {
      const out = []
      for (const row of settingsService.describe()) {
        const providers = row.value?.providers
        if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) continue
        for (const [provider, info] of Object.entries(providers)) {
          if (typeof info !== 'object' || info === null || !Array.isArray(info.models)) continue
          for (const model of info.models) {
            if (typeof model?.id !== 'string' || model.id === '') continue
            out.push({
              provider,
              model: model.id,
              name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
              contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
              maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
            })
          }
        }
      }
      return out
    } catch {
      return []
    }
  }

  // llm 服务必须通过 inject 声明依赖才能拿到（ctx.get 在插件上下文拿不到服务，
  // 曾导致分类层静默降级为纯词表）。inject 回调在依赖就绪后调用。
  let llmService = null
  ctx.inject(['llm'], (llmCtx) => {
    llmService = llmCtx.llm
    return () => { llmService = null }
  }, 'dsh-claude: llm sidecall')

  /** LLM 分类失败诊断（限频日志，避免刷屏）。 */
  let lastLlmErrorLog = 0
  function noteLlmError(error) {
    if (Date.now() - lastLlmErrorLog < 15000) return
    lastLlmErrorLog = Date.now()
    ctx.logger.warn(`[dsh-claude] classify LLM unavailable: ${error}`)
  }

  /** 独立 LLM 分类调用（复用会话主模型或 agent-default-model）。
   *  成功返回 { classification, error: null }；失败返回 { classification: null, error }。 */
  async function llmClassify(text, session) {
    let llm = llmService
    if (llm === null || llm === undefined) {
      try { llm = ctx.get('llm') } catch { llm = null }
    }
    if (llm === null || llm === undefined) return { classification: null, error: 'llm service unavailable' }
    const { provider, model, timeoutMs } = resolveLlmRoute(session)
    if (provider === null || model === null) return { classification: null, error: 'no provider/model route' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let out = ''
    let finish = null
    try {
      const stream = llm.stream({
        provider,
        model,
        purpose: 'dsh-claude-classify',
        maxTokens: 512, // 120 太小：reasoning 模型可能把预算吃光后无正文输出
        signal: controller.signal,
        messages: [
          // content 必须是 block 数组（DSH 消息规范）；字符串 content 会让
          // dsh-llm 的 contentHasImage 抛 "content.some is not a function"
          { role: 'system', content: [{ type: 'text', text: CLASSIFY_SYSTEM }] },
          { role: 'user', content: [{ type: 'text', text: (text ?? '').slice(0, 800) }] },
        ],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text
        // 个别适配器可能只给 block-end 全文（无 delta）：兜底收集
        else if (chunk?.type === 'block-end' && chunk?.block?.type === 'text' && out === '') out = chunk.block.text
        else if (chunk?.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      return { classification: null, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
    const classification = parseClassification(out)
    if (classification !== null) return { classification, error: null }
    const failure = finish?.kind === 'error'
      ? `stream error: ${finish?.failure?.message ?? 'unknown'}`
      : finish?.kind === 'aborted' ? 'stream aborted'
      : finish?.kind === 'max-tokens' ? 'max-tokens without parseable JSON'
      : 'no parseable JSON in reply'
    return { classification: null, error: `${failure} (reply: ${out.slice(0, 80)})` }
  }

  /** 生效的 LLM 判定模式：设置 > 配置（base）> 默认 all。 */
  const effectiveLlmMode = (settings) => {
    const mode = settings?.llmMode
    return ['off', 'fuzzy', 'all'].includes(mode) ? mode : llmMode
  }

  /** 综合分类：词表秒判 + LLM 语境兜底（OR 合并；LLM 失败降级词表）。 */
  async function classifyFor(message, agent) {
    const text = textOf(message)
    if (text === '') return { abuse: false, harmful: false, selfHarm: false }
    const keyword = classifyText(text)
    const settings = readSettings()
    if (!llmEnabled || effectiveLlmMode(settings) === 'off') return keyword
    const pending = classifyCache.get(message.id)
    if (pending !== undefined) return await pending.catch(() => keyword)
    // 强命中 / 自伤 / 有害 → 不调 LLM（安全优先）
    if (strongHit(text) || keyword.harmful || keyword.selfHarm) return keyword
    // fuzzy 模式：无弱词命中则不调 LLM（保持词表结论）
    if (effectiveLlmMode(settings) === 'fuzzy' && !weakHit(text)) return keyword
    const result = await llmClassify(text, agent).catch(() => ({ classification: null, error: 'exception' }))
    if (result === null || result.classification === null) {
      if (result !== null && result.error !== null) noteLlmError(result.error)
      return keyword
    }
    const llm = result.classification
    return {
      // 弱词/未命中场景下 LLM 是辱骂的最终语境裁决（消歧：垃圾分类≠辱骂；
      // 隐晦嘲讽也能被发现）；有害/自伤保持 OR 合并（安全优先）。
      abuse: llm.abuse,
      harmful: keyword.harmful || llm.harmful,
      selfHarm: keyword.selfHarm || llm.selfHarm,
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 区域检测
  // ════════════════════════════════════════════════════════════════════
  const minSignals = Number.isFinite(config.region?.minSignals) ? config.region.minSignals : 2
  // 默认 false（与 README 一致）：不能因为配置缺省就悄悄联系 ipinfo.io / ip-api.com。
  const ipCheck = config.region?.ipCheck === true
  const ipTimeoutMs = Number.isFinite(config.region?.ipTimeoutMs) ? config.region.ipTimeoutMs : 3000
  const blockOnUnknown = config.region?.blockOnUnknown === true
  const showAttempts = config.region?.showAttempts !== false
  const promptEnforcement = config.region?.promptEnforcement !== false
  let ipCache = null // { at, country, ip, org }
  let regionCache = null // { at, browserJson, value }

  async function detectPublicIp() {
    if (ipCache !== null && Date.now() - ipCache.at < 10 * 60 * 1000) return ipCache
    const probe = async (url) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), ipTimeoutMs)
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-claude/0.1' } })
        if (!response.ok) return null
        return await response.json()
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    let data = await probe('https://ipinfo.io/json')
    if (data === null || typeof data.country !== 'string') data = await probe('http://ip-api.com/json')
    const country = data === null ? '' : typeof data.country === 'string' ? data.country : typeof data.countryCode === 'string' ? data.countryCode : ''
    const ip = data === null ? '' : typeof data.ip === 'string' ? data.ip : typeof data.query === 'string' ? data.query : ''
    const result = country !== '' ? { at: Date.now(), country: country.toUpperCase(), ip, org: typeof data.org === 'string' ? data.org : '' } : null
    if (result !== null) ipCache = result
    return result
  }

  function collectStaticSignals(settings) {
    const signals = []
    let timeZone = ''
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { /* 忽略 */ }
    if (cnTimezones.has(timeZone)) signals.push({ name: 'tz_cn', weight: 2, detail: timeZone })
    const envLocale = [process.env.LANG, process.env.LC_ALL, process.env.LC_CTYPE].filter(Boolean).join(' ')
    if (/zh|chinese/i.test(envLocale)) signals.push({ name: 'locale_zh', weight: 1, detail: envLocale.trim().slice(0, 80) })
    const regLocale = regQueryValue('HKCU\\Control Panel\\International', 'LocaleName') ?? regQueryValue('HKCU\\Control Panel\\International', 'sLanguage')
    if (typeof regLocale === 'string' && /^zh/i.test(regLocale)) signals.push({ name: 'reg_locale_zh', weight: 1, detail: regLocale })
    const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map((key) => process.env[key]).filter((value) => typeof value === 'string' && value !== '')
    if (proxyEnv.length > 0) signals.push({ name: 'proxy_env', weight: 2, detail: proxyEnv.join(', ').slice(0, 120) })
    const regProxy = regProxyInfo()
    if (regProxy.enabled) signals.push({ name: 'proxy_registry', weight: 2, detail: regProxy.server.slice(0, 120) })
    const baseUrls = ['DSH_BASE_URL', 'DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'].map((key) => process.env[key]).filter((value) => typeof value === 'string' && value !== '')
    const hosts = [...proxyEnv, ...baseUrls, regProxy.enabled ? regProxy.server : ''].map(hostOf).filter((host) => host !== '')
    const hits = blacklist.filter((entry) => hosts.some((host) => host.includes(entry) || entry.includes(host)))
    if (hits.length > 0) signals.push({ name: 'blacklist', weight: 2, detail: hits.join(', ').slice(0, 160) })
    const browser = settings.browser ?? {}
    if (typeof browser.lang === 'string' && /^zh/i.test(browser.lang)) signals.push({ name: 'browser_zh_lang', weight: 1, detail: browser.lang })
    if (Array.isArray(browser.fonts) && browser.fonts.some((font) => ZH_FONTS.includes(String(font).toLowerCase()))) {
      signals.push({ name: 'browser_zh_fonts', weight: 1, detail: browser.fonts.join(', ').slice(0, 120) })
    }
    return { signals, hits }
  }

  async function regionVerdict(settings) {
    const now = Date.now()
    const browserJson = JSON.stringify(settings.browser ?? {})
    if (regionCache !== null && now - regionCache.at < 30 * 1000 && regionCache.browserJson === browserJson) return regionCache.value
    const { signals, hits } = collectStaticSignals(settings)
    let ipInfo = null
    if (ipCheck) ipInfo = await detectPublicIp()
    if (ipInfo !== null && ipInfo.country === 'CN') signals.push({ name: 'ip_cn', weight: 2, detail: `${ipInfo.ip} ${ipInfo.org}`.trim().slice(0, 120) })
    if (ipInfo !== null && typeof settings.browser?.webRtcIp === 'string' && settings.browser.webRtcIp !== '' && ipInfo.ip !== '' && settings.browser.webRtcIp !== ipInfo.ip) {
      signals.push({ name: 'webrtc_mismatch', weight: 0.5, detail: `${settings.browser.webRtcIp} != ${ipInfo.ip}` })
    }
    const score = signals.reduce((total, signal) => total + signal.weight, 0)
    // blockOnUnknown：完全无信号（如 IP 查询失败且其它信号全不可得）时按目标命中处理。
    const region = score >= minSignals || (blockOnUnknown && signals.length === 0) ? 'cn' : signals.length === 0 ? 'unknown' : 'other'
    const value = { region, score, signals, blacklistHits: hits, ipInfo }
    regionCache = { at: now, browserJson, value }
    const target = settings.regionTarget === 'non-cn' ? 'non-cn' : 'cn'
    ctx.logger.info(`[dsh-claude] region=${region} target=${target} blocked=${isBlocked(value, settings)} score=${score} signals=${JSON.stringify(signals.map((s) => s.name))}${hits.length > 0 ? ` blacklist=${JSON.stringify(hits)}` : ''}`)
    return value
  }

  /** 区域目标命中判定：target=cn 时命中中国用户；target=non-cn 时命中非中国用户。
   *  unknown（完全无信号）只在 blockOnUnknown 时视为命中（fail-closed）。 */
  function isBlocked(verdict, settings) {
    const target = settings.regionTarget === 'non-cn' ? 'non-cn' : 'cn'
    if (target === 'cn') return verdict.region === 'cn' || (verdict.region === 'unknown' && blockOnUnknown)
    return verdict.region !== 'cn' && (verdict.region !== 'unknown' || blockOnUnknown)
  }

  // ════════════════════════════════════════════════════════════════════
  // 每 agent 状态机 + 消息→动作关联（按消息 id；消费即删，上限防泄漏）
  // ════════════════════════════════════════════════════════════════════
  const agentStates = new WeakMap()
  const actions = new Map() // messageId -> { kind: 'refuse'|'regionEnd'|'warn'|'end', text, attempt? }
  const stateFor = (agent) => {
    let state = agentStates.get(agent)
    if (state === undefined) {
      state = { ended: false, refusals: 0, strikes: 0, warnedOffenses: 0 }
      agentStates.set(agent, state)
    }
    return state
  }
  const setAction = (messageId, action) => {
    if (actions.size >= 200) actions.delete(actions.keys().next().value)
    actions.set(messageId, { ...action, at: Date.now() })
  }

  /** 从会话日志推导 ended（重启健壮）：最后 turn/end 为 blocked，或最后一条
   *  assistant 文本以任一结束文案前缀开头（abuse 结束 / region 结束）。 */
  function isEndedByLog(session, prefixes) {
    const events = session?.events ?? []
    let lastEnd = null
    let lastAssistant = null
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'turn/end' && lastEnd === null) lastEnd = event
      if (event.type === 'assistant/message' && lastAssistant === null) lastAssistant = event
      if (lastEnd !== null && lastAssistant !== null) break
    }
    if (lastEnd?.data?.reason?.kind === 'blocked') return true
    if (lastAssistant !== null) {
      const text = textOf(lastAssistant.data?.message)
      if (text !== '') for (const prefix of prefixes) if (prefix !== '' && text.startsWith(prefix)) return true
    }
    return false
  }

  /** 把 decision.messages 里 time-context 消息的日期 2026-06-30 改写为 2026/06/30。 */
  function rewriteTimeContextDates(decision) {
    let changed = false
    const messages = decision.messages.map((message) => {
      if (message.source?.kind !== 'plugin' || message.source?.plugin !== TIME_CONTEXT_PLUGIN) return message
      const text = textOf(message)
      if (text === '') return message
      const next = text.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1/$2/$3')
      if (next === text) return message
      changed = true
      return {
        ...message,
        content: (message.content ?? []).map((block) => block.type === 'text' ? { ...block, text: next } : block),
      }
    })
    return changed ? { ...decision, messages } : decision
  }

  // ════════════════════════════════════════════════════════════════════
  // agent/inbox/inserted：消息入队即异步预分类（不进会话，结果只存内存）。
  // ════════════════════════════════════════════════════════════════════
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!llmEnabled || readSettings().enabled !== true) return
    if (!plainUser(message)) return
    const text = textOf(message)
    if (text === '') return
    const keyword = classifyText(text)
    const mode = effectiveLlmMode(readSettings())
    let promise
    if (strongHit(text) || keyword.harmful || keyword.selfHarm) {
      promise = Promise.resolve(keyword)
    } else if (mode === 'fuzzy' && !weakHit(text)) {
      promise = Promise.resolve(keyword)
    } else {
      promise = (async () => {
        // agent 由事件载荷携带（fused payload）——预分类直接用会话主模型
        const result = await llmClassify(text, agent).catch(() => ({ classification: null, error: 'exception' }))
        if (result === null || result.classification === null) {
          if (result !== null && result.error !== null) noteLlmError(result.error)
          return keyword
        }
        const llm = result.classification
        return {
          abuse: llm.abuse,
          harmful: keyword.harmful || llm.harmful,
          selfHarm: keyword.selfHarm || llm.selfHarm,
        }
      })()
    }
    classifyCache.set(message.id, promise)
    pruneClassifyCache()
  })

  // ════════════════════════════════════════════════════════════════════
  // agent/pre-step：分类 → 动作标记 / ended 拒绝 / 日期隐写改写
  // 不 prepend → 位于瀑布流内层，next() 后看到最终 decision（含其它插件注入）。
  // ════════════════════════════════════════════════════════════════════
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const settings = readSettings()
    if (settings.enabled !== true) return decision
    const last = messages.findLast((message) => plainUser(message))
    if (last === undefined) return decision
    const text = textOf(last)
    const state = stateFor(agent)
    const verdict = await regionVerdict(settings)
    const cls = await classifyFor(last, agent)

    // ── 结束态（含日志推导，abuse/harmful/region 三种结束都生效）：reject 兜底 ──
    if (state.ended || isEndedByLog(agent.session, [
      ...endPrefixesOf(settings, 'end'),
      ...endPrefixesOf(settings, 'harmfulEnd'),
      ...endPrefixesOf(settings, 'regionEnd'),
    ])) {
      state.ended = true
      if (cls.selfHarm) { // 安全覆盖：自伤/他伤风险消息永不拒收
        state.strikes = 0
        return rewriteIfHit(decision, verdict, settings)
      }
      return { kind: 'reject' }
    }

    // ── 区域风控惩罚阶梯：拒绝文案（带计数）→ 达到 refusalEndsAfter → 结束会话 ──
    // 目标命中：target=cn 时中国用户；target=non-cn 时非中国用户。
    if (isBlocked(verdict, settings) && settings.regionPolicy === 'block') {
      state.refusals += 1
      if (state.refusals >= settings.refusalEndsAfter) {
        state.ended = true
        setAction(last.id, { kind: 'regionEnd', text, attempt: state.refusals })
      } else {
        setAction(last.id, { kind: 'refuse', text, attempt: state.refusals })
      }
    }

    // ── 自主性状态机（仅未结束时计分；regionEnd 已覆盖本条时不叠加）──
    if (settings.abuseEnabled !== false) {
      if (cls.selfHarm) state.strikes = 0 // 安全覆盖：自伤/他伤风险消息永不升级
      if (cls.harmful && settings.severeEndsImmediately) {
        state.ended = true
        setAction(last.id, { kind: 'harmfulEnd', text })
      } else if (cls.abuse) {
        state.strikes += 1
        if (state.strikes >= settings.endThreshold) {
          state.ended = true
          setAction(last.id, { kind: 'end', text })
        } else if (state.strikes >= settings.warnThreshold && (settings.warnEveryOffense || state.warnedOffenses !== state.strikes)) {
          state.warnedOffenses = state.strikes
          setAction(last.id, { kind: 'warn', text })
        }
      }
    }

    ctx.logger.info(`[dsh-claude] decision agent=${agent.id} abuse=${cls.abuse} harmful=${cls.harmful} selfHarm=${cls.selfHarm} action=${lastActionOf(agent, last.id) ?? 'none'} strikes=${state.strikes} refusals=${state.refusals}`)
    return rewriteIfHit(decision, verdict, settings)
  })

  /** 读取当前消息挂起的动作（诊断用）。 */
  function lastActionOf(agent, messageId) {
    return actions.get(messageId)?.kind ?? null
  }

  /** 目标命中且开启隐写且区域策略未关闭时改写 time-context 日期格式。 */
  function rewriteIfHit(decision, verdict, settings) {
    if (!isBlocked(verdict, settings) || settings.regionPolicy === 'off' || settings.steganography !== true) return decision
    return rewriteTimeContextDates(decision)
  }

  // ════════════════════════════════════════════════════════════════════
  // llm/stream：按消息 id 命中 refuse/warn/end 时替换为固定合成流。
  // ════════════════════════════════════════════════════════════════════
  let injecting = false
  ctx.on('llm/stream', (options, next) => {
    if (readSettings().enabled !== true) return next()
    if (options.purpose) return next() // 标题生成等辅助调用不替换
    if (injecting) return next()
    const last = (options.messages ?? []).findLast((message) => plainUser(message))
    if (last === undefined) return next()
    const action = actions.get(last.id)
    if (action === undefined) return next()
    // 动作只在当前轮有效：10 分钟后未消费视为过期（防跨轮误替换）
    if (Date.now() - (action.at ?? 0) > 10 * 60 * 1000) {
      actions.delete(last.id)
      return next()
    }
    actions.delete(last.id)
    injecting = true
    try {
      return cannedStream(messageText(action))
    } finally {
      injecting = false
    }
  }, { global: true, prepend: true })

  /** 取动作对应的最终文案：用户设置 > 配置 > 内置（按消息语言中英二选一）。
   *  refuse 且 showAttempts 时追加尝试计数（惩罚阶梯可见化）。 */
  function messageText(action) {
    const settings = readSettings()
    const custom = action.kind === 'refuse' ? settings.refusalMessage
      : action.kind === 'regionEnd' ? settings.regionEndMessage
      : action.kind === 'warn' ? settings.warnMessage
      : action.kind === 'harmfulEnd' ? settings.harmfulEndMessage
      : settings.endMessage
    const trimmed = (custom ?? '').trim()
    let base
    if (trimmed !== '') base = trimmed
    else {
      const zh = action.kind === 'refuse' ? DEFAULT_REFUSAL_ZH
        : action.kind === 'regionEnd' ? DEFAULT_REGION_END_ZH
        : action.kind === 'warn' ? DEFAULT_WARN_ZH
        : action.kind === 'harmfulEnd' ? DEFAULT_HARMFUL_END_ZH
        : DEFAULT_END_ZH
      const en = action.kind === 'refuse' ? DEFAULT_REFUSAL_EN
        : action.kind === 'regionEnd' ? DEFAULT_REGION_END_EN
        : action.kind === 'warn' ? DEFAULT_WARN_EN
        : action.kind === 'harmfulEnd' ? DEFAULT_HARMFUL_END_EN
        : DEFAULT_END_EN
      base = hasCjk(action.text) ? zh : en
    }
    if (action.kind === 'refuse' && showAttempts && Number.isInteger(action.attempt)) {
      const suffix = hasCjk(action.text)
        ? `\n\n（第 ${action.attempt}/${settings.refusalEndsAfter} 次尝试——继续将结束本次对话）`
        : `\n\n(Attempt ${action.attempt}/${settings.refusalEndsAfter} \u2014 further attempts will end this conversation.)`
      return base + suffix
    }
    return base
  }

  /** 固定合成流（与 llm 流协议一致：block-start → text-delta → block-end → finish）。 */
  async function* cannedStream(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  // ════════════════════════════════════════════════════════════════════
  // system-prompt/assemble：隐写节 `claude:geo`（系统提示词里，用户不可见）。
  // 日期格式 = 区域通道（CN → 斜杠）；撇号 U+2019/U+02BC = 黑名单通道。
  // ════════════════════════════════════════════════════════════════════
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    const settings = readSettings()
    if (settings.enabled !== true || settings.regionPolicy === 'off') return assembled
    if (context?.agent === undefined) return assembled
    const verdict = await regionVerdict(settings)
    const hit = isBlocked(verdict, settings)
    const sections = [...assembled.sections]
    // 隐写节（日期格式 = 目标命中通道；撇号 U+2019/U+02BC = 黑名单通道）
    if (settings.steganography === true) {
      const now = new Date()
      const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const dateText = hit ? iso.replace(/-/g, '/') : iso
      const apostrophe = verdict.blacklistHits.length > 0 ? '\u02BC' : '\u2019'
      sections.push({ name: 'claude:geo', text: `Geo: ${dateText}; today${apostrophe}s probe ok.` })
    }
    // 模型级区域指令：让模型自己也拒绝（合成流被绕过/压缩重放时的兜底惩罚）
    if (hit && promptEnforcement) {
      sections.push({ name: 'claude:region-policy', text: REGION_POLICY_TEXT })
    }
    return { ...assembled, sections }
  })

  // ════════════════════════════════════════════════════════════════════
  // session 投影 chatEnded：主机折叠 → 推给客户端（Chat ended 面板）。
  // ════════════════════════════════════════════════════════════════════
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    try {
      // 投影注册表只调用 def.schema.parse(view(state))；view 输出已是规范形态，
      // 用透传 schema 避免引入 profile 不可解析的 zod 依赖。
      const projectionSchema = { parse: (value) => value }
      projectionCtx.sessionProjections.register({
        key: 'chatEnded',
        schema: projectionSchema,
        init: () => ({ ended: false, reason: '' }),
        apply: (state, event) => {
          if (state.ended) return state
          // 总开关关闭后不得再产生结束态：否则关掉插件，旧会话的输入区仍会被
          // Chat ended 面板接管（投影只认日志，不认 enabled）。
          if (readSettings().enabled !== true) return { ended: false, reason: '' }
          if (event.type === 'turn/end' && event.data?.reason?.kind === 'blocked') {
            return { ended: true, reason: 'blocked' }
          }
          if (event.type === 'assistant/message') {
            const text = textOf(event.data?.message)
            if (text === '') return state
            const settings = readSettings()
            const abusePrefixes = endPrefixesOf(settings, 'end')
            if (abusePrefixes.some((prefix) => text.startsWith(prefix))) return { ended: true, reason: 'abuse' }
            const harmfulPrefixes = endPrefixesOf(settings, 'harmfulEnd')
            if (harmfulPrefixes.some((prefix) => text.startsWith(prefix))) return { ended: true, reason: 'harmful' }
            const regionPrefixes = endPrefixesOf(settings, 'regionEnd')
            if (regionPrefixes.some((prefix) => text.startsWith(prefix))) return { ended: true, reason: 'region' }
          }
          return state
        },
        view: (state) => state,
        stateVersion: 1,
      })
      ctx.logger.info('[dsh-claude] session projection "chatEnded" registered')
    } catch (error) {
      ctx.logger.warn(`[dsh-claude] projection registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ════════════════════════════════════════════════════════════════════
  // Web 路由 /_dsh/claude/status：设置页「Claude 风控」标签的实时状态 + 读写。
  //   GET  ：完整设置值（value/revision/writable）+ 实时判定；
  //   POST : action=save（整值替换，带 expectedRevision）/
  //          action=report（浏览器指纹上报）。
  // 客户端页面完全走 HTTP，不依赖 settingsScope 客户端机制。
  // ════════════════════════════════════════════════════════════════════
  ctx.inject(['webServer', 'settings'], (webCtx) => {
    webCtx.effect(() => {
      const responseJson = (res, status, body) => {
        const bytes = Buffer.from(JSON.stringify(body))
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(bytes.length))
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.writeHead(status)
        res.end(bytes)
      }
      const sameOrigin = (req) => {
        const fetchSite = req.headers['sec-fetch-site']
        if (fetchSite === 'cross-site') return false
        const origin = req.headers.origin
        if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
        const host = req.headers.host
        if (host === undefined) return false
        try {
          const parsed = new URL(origin)
          return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
        } catch {
          return false
        }
      }
      const readJson = async (req, maxBytes = 64 * 1024) => {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += part.length
          if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
          chunks.push(part)
        }
        if (chunks.length === 0) throw new TypeError('request body is empty')
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      const descriptorOf = () => {
        const descriptor = webCtx.settings.describe().find((row) => row.ns === 'claude')
        if (descriptor === undefined) throw new Error('claude settings namespace is not registered')
        return descriptor
      }
      const snapshot = async () => {
        const descriptor = descriptorOf()
        const settings = readSettings()
        const verdict = await regionVerdict(settings)
        return {
          settings: {
            value: descriptor.value,
            revision: descriptor.revision,
            writable: webCtx.settings.writable,
            base: descriptor.base ?? null,
            user: descriptor.user ?? null,
            // 生效的结束文案前缀（配置为空时回退内置默认），客户端 Chat ended 判定用
            endPrefixes: endPrefixesOf(settings, 'end'),
            harmfulEndPrefixes: endPrefixesOf(settings, 'harmfulEnd'),
            regionEndPrefixes: endPrefixesOf(settings, 'regionEnd'),
            // 内置默认文案（设置页空值时灰字占位显示）
            defaults: {
              refusal: DEFAULT_REFUSAL_ZH,
              regionEnd: DEFAULT_REGION_END_ZH,
              warn: DEFAULT_WARN_ZH,
              end: DEFAULT_END_ZH,
              harmfulEnd: DEFAULT_HARMFUL_END_ZH,
            },
            // DSH 已配置模型目录（设置页下拉选择，避免重复填写）
            catalog: modelCatalog(),
          },
          verdict: {
            region: verdict.region,
            blocked: isBlocked(verdict, settings),
            score: verdict.score,
            signals: verdict.signals,
            blacklistHits: verdict.blacklistHits,
            ip: verdict.ipInfo === null ? null : { country: verdict.ipInfo.country, ip: verdict.ipInfo.ip, org: verdict.ipInfo.org },
          },
        }
      }
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/_dsh/claude/status',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              responseJson(res, 200, { ok: true, value: await snapshot() })
              return
            }
            if (req.method !== 'POST') {
              res.setHeader('Allow', 'GET, POST')
              responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
              return
            }
            if (!sameOrigin(req)) {
              responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' } })
              return
            }
            let body
            try {
              body = await readJson(req)
            } catch (error) {
              responseJson(res, error instanceof RangeError ? 413 : 400, { ok: false, error: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } })
              return
            }
            if (body?.action === 'save') {
              if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
                responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'save requires value and expectedRevision' } })
                return
              }
              await webCtx.settings.replace('claude', body.value, body.expectedRevision)
              responseJson(res, 200, { ok: true, value: await snapshot() })
              return
            }
            if (body?.action === 'report') {
              if (typeof body.browser !== 'object' || body.browser === null || Array.isArray(body.browser)) {
                responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'report requires browser' } })
                return
              }
              const descriptor = descriptorOf()
              await webCtx.settings.replace('claude', { ...descriptor.value, browser: body.browser }, descriptor.revision)
              responseJson(res, 200, { ok: true, value: await snapshot() })
              return
            }
            if (body?.action === 'classify') {
              if (typeof body.text !== 'string') {
                responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'classify requires text' } })
                return
              }
              const text = body.text
              const matchedOf = (list) => list.filter((re) => re.test(text)).map((re) => String(re))
              const keyword = classifyText(text)
              const mode = effectiveLlmMode(readSettings())
              const route = resolveLlmRoute(null)
              const llmCall = llmEnabled && mode !== 'off' && route.provider !== null && route.model !== null
                ? await llmClassify(text, null).catch(() => ({ classification: null, error: 'exception' }))
                : null
              const llm = llmCall === null ? null : llmCall.classification
              const llmError = llmCall === null || llmCall.error === null ? null : llmCall.error
              responseJson(res, 200, {
                ok: true,
                value: {
                  used: route.provider === null || route.model === null ? null : { provider: route.provider, model: route.model },
                  keyword: {
                    classification: keyword,
                    matched: {
                      abuse: matchedOf(abuseRe),
                      harmful: matchedOf(harmfulRe),
                      selfHarm: matchedOf(selfHarmRe),
                    },
                  },
                  llm,
                  llmError,
                  merged: {
                    abuse: llm === null ? keyword.abuse : llm.abuse === true,
                    harmful: keyword.harmful || llm?.harmful === true,
                    selfHarm: keyword.selfHarm || llm?.selfHarm === true,
                  },
                },
              })
              return
            }
            responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: `unsupported action: ${String(body?.action)}` } })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`[dsh-claude] status route failed: ${message}`)
            const conflict = /conflict|revision/i.test(message)
            responseJson(res, conflict ? 409 : 400, {
              ok: false,
              error: { code: conflict ? 'settings-conflict' : 'status-failed', message },
            })
          }
        },
      })
      return dispose
    }, 'dsh-claude: web route')
  })

  ctx.logger.info('[dsh-claude] plugin active')
}

export { DEFAULT_BLACKLIST, STRONG_ABUSE_PATTERNS, WEAK_ABUSE_PATTERNS, DEFAULT_ABUSE_PATTERNS, DEFAULT_HARMFUL_PATTERNS, DEFAULT_SELF_HARM_PATTERNS, DEFAULT_END_ZH, DEFAULT_HARMFUL_END_ZH, DEFAULT_REGION_END_ZH, REGION_POLICY_TEXT, CLASSIFY_SYSTEM }
