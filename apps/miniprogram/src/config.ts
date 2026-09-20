/**
 * 小程序端配置 —— 三个环境，按运行形态**自动分流**。
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  模拟器（开发者工具）       → local  → 本机 Docker           │
 *   │  真机调试 / 预览（开发版）   → dev    → 云托管 dev 环境       │
 *   │  体验版                     → dev    → 云托管 dev 环境       │
 *   │  正式版（release）          → prod   → 云托管 prod 环境      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * ⚠️⚠️ 本文件里**不允许出现任何字面量部署坐标**（环境 ID / 服务名 / 地址）。
 *     它们全部由 esbuild 在**构建时**注入，来源是根目录 .env 的 MP_* 变量
 *     （或 CI 里的同名环境变量），见 apps/miniprogram/build.mjs 的 define。
 *
 *     为什么不能硬编码：小程序**没有运行时环境变量**（没有 process.env），
 *     值必须在构建时烘进包里 —— 但「必须构建时确定」不等于「必须写在源码里」。
 *     硬编码的代价是：改环境要改源码、局域网 IP 会绑死在某个人的机器上、
 *     也无法在多环境 CI 里复用同一份代码。
 *
 * ⚠️ 本地调试最常见的坑：**系统代理**。
 *     开发者工具是 Chromium 内核会走系统代理；而 Clash 这类规则代理
 *     **能转发外网、却拒绝转发本地地址**（回 empty reply），
 *     表现为「curl 能通、工具连不上」。
 *     查法：scutil --proxy
 *     修法：开发者工具 → 设置 → 代理设置 → 不使用代理
 *     ⚠️ curl 默认不读 macOS 系统代理，所以「curl 能通」不能作为证据。
 */

// ----------------------------------------------------------------
// 构建时注入的配置（值来自根目录 .env，见 build.mjs）
// ⚠️ 这些 declare 只参与类型检查，运行时早被 esbuild 替换成字面量了。
//    不要 import 它们，也不要给它们赋值。
// ----------------------------------------------------------------
declare const __MP_LOCAL_API_URL__: string
declare const __MP_LAN_API_URL__: string
declare const __MP_DEV_ENV_ID__: string
declare const __MP_PROD_ENV_ID__: string
declare const __MP_CLOUD_SERVICE__: string
declare const __MP_BUILD_TIME__: string

export type EnvName = 'local' | 'dev' | 'prod'

export interface EnvConfig {
  /** API 传输通道：'http' = wx.request 打 httpUrl；'container' = wx.cloud.callContainer */
  transport: 'http' | 'container'
  /** http 通道的基地址；container 通道为空（那条通道不拼 url） */
  httpUrl: string
  /**
   * ⚠️ 这里**曾经**有过一个 mediaUrl（标准音的媒体域名），已经删掉。
   *    原因是它解决错了问题：container 模式下 API 不拼 URL，
   *    但那不代表要走「给服务端配一个域名」这条路 ——
   *    标准音进了**云开发对象存储**，客户端用 wx.cloud.getTempFileURL 换地址即可，
   *    连 downloadFile 合法域名都不用配。
   *    见 apps/miniprogram/src/lib/audio/standard.ts。
   */
  /**
   * 云托管环境 ID。
   * ⭐ 它同时服务两件事：① callContainer 的通道 ② 对象存储（wx.cloud.init + uploadFile）。
   *    所以即使是 local 模式（API 打本机）也要有值 —— 否则音频直传不可用。
   */
  cloudEnvId: string
}

/**
 * 云托管服务名 —— 三个环境**同名**（各环境内独立）。
 * 必须与控制台「服务管理 → 服务列表」里的名字完全一致，否则报 -601031。
 */
export const CLOUD_SERVICE = __MP_CLOUD_SERVICE__

/**
 * 真机走局域网的逃生通道（云环境全挂时手动切）。
 * ⚠️ 机器相关，默认为空表示不启用 —— 不要把它绑死在某个人的 IP 上。
 */
export const LAN_FALLBACK_URL = __MP_LAN_API_URL__

const ENVS: Record<EnvName, EnvConfig> = {
  // 本机 Docker。API 走 wx.request；文件仍走 dev 的对象存储。
  // 本机 Docker。API 走 wx.request；文件仍走 dev 的对象存储。
  local: { transport: 'http', httpUrl: __MP_LOCAL_API_URL__, cloudEnvId: __MP_DEV_ENV_ID__ },

  // 云托管 dev 环境。开发版（真机调试 / 预览）与体验版用这个。
  dev: { transport: 'container', httpUrl: '', cloudEnvId: __MP_DEV_ENV_ID__ },

  // 云托管 prod 环境。正式版用这个。
  prod: { transport: 'container', httpUrl: '', cloudEnvId: __MP_PROD_ENV_ID__ },
}

// ----------------------------------------------------------------
// 自动分流
// ----------------------------------------------------------------

/** 运行平台：模拟器里是 'devtools'，真机是 'ios' / 'android' */
function detectPlatform(): string {
  try {
    const info = wx.getDeviceInfo?.()
    if (info?.platform) return info.platform
  } catch {
    /* 老基础库没有 getDeviceInfo，退回下面 */
  }
  try {
    return wx.getSystemInfoSync().platform
  } catch {
    return 'unknown'
  }
}

/**
 * 小程序版本形态（基础库 1.9.6+）：
 *   'develop' 开发版 —— 真机调试、预览
 *   'trial'   体验版
 *   'release' 正式版
 */
function detectEnvVersion(): string {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion
  } catch {
    return 'develop'
  }
}

/**
 * ⭐ 自动分流规则。
 *
 * ⚠️ 体验版**刻意也指向 dev**：
 *    体验版是给测试者的，如果把测试成绩写进**正式榜单**，
 *    用户看到的排名就是脏的 —— 对一个以「竞技场排名」为核心的产品，这是硬伤。
 *    要改成指向 prod，把下面的 'trial' 从 dev 挪到 prod 即可。
 */
function resolveEnv(): EnvName {
  // 模拟器一律打本机
  if (detectPlatform() === 'devtools') return 'local'

  const version = detectEnvVersion()
  if (version === 'release') return 'prod'
  // develop（真机调试 / 预览）与 trial（体验版）都走 dev
  return 'dev'
}

/**
 * 手动强制指定环境。
 * 默认 null = 按上面的规则自动分流。
 * 需要临时验证某个环境时改这里，例如强制 'prod'。
 */
export const ENV_OVERRIDE: EnvName | null = null

export const ENV: EnvName = ENV_OVERRIDE ?? resolveEnv()

/** 展示用：当前环境的中文说明 */
export const ENV_LABEL: Record<EnvName, string> = {
  local: 'local（本机 Docker）',
  dev: 'dev（云托管开发环境）',
  prod: 'prod（云托管正式环境）',
}

// ----------------------------------------------------------------
// 派生值（其余模块只 import 这些）
// ----------------------------------------------------------------

const active = ENVS[ENV]

export const TRANSPORT = active.transport
export const BASE_URL = active.httpUrl
export const CLOUD_ENV_ID = active.cloudEnvId


// ----------------------------------------------------------------
// 诊断信息（自检页展示，避免「到底连的哪儿」靠猜）
// ----------------------------------------------------------------

export const PLATFORM = detectPlatform()
export const ENV_VERSION = detectEnvVersion()

/** 本次构建的时刻（ISO 字符串）—— 报告里带上，避免分不清跑的是哪一版 */
export const BUILD_TIME = __MP_BUILD_TIME__

/** 当前请求实际打到哪儿，一句话说清 */
export const TARGET =
  TRANSPORT === 'container'
    ? `callContainer → ${CLOUD_ENV_ID} / ${CLOUD_SERVICE}`
    : BASE_URL
