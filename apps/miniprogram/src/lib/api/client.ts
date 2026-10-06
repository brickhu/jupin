import type {
  ApiResult,
  ArticleParticipationsResponse,
  ArticleStatsResponse,
  ChallengesResponse,
  TagsResponse,
  EnergyResponse,
  MeResponse,
  ParticipationRecord,
  ParticipationsResponse,
  ProfileUpdate,
  ProfileUpdateResponse,
  UserProfileResponse,
  ArticleFavoriteCountsResponse,
  FavoritedResponse,
  ChallengeShareResponse,
  ArticleListResponse,
  LatestCardsResponse,
  UserListResponse,
  FavoritesResponse,
  ParticipationSubmissionsResponse,
  ShopGoodsResponse,
  ShopOrderResponse,
  StreakRecordResponse,
  StreakView,
  SubmissionAudioResponse,
  SubmissionStatusResponse,
  TodayArticleResponse,
} from '@jushuo/shared'

import { BASE_URL, CLOUD_ENV_ID, CLOUD_SERVICE, ENV_VERSION, PLATFORM, SDK_VERSION, TARGET, TRANSPORT } from '../../config'

/**
 * ⭐ 云能力（wx.cloud.init）的结果 —— 由 app.ts 在 onLaunch 里记录。
 *
 * ⚠️⚠️ 为什么要记：云托管通道的失败**有两种长得很像的原因**，
 *    而它们的解法完全不同：
 *      ① 手机微信的**基础库太旧**（callContainer 要 2.23.0+）—— 报「undefined is not an object」；
 *      ② **wx.cloud.init 就没成功**（游客模式 / 未开通云能力）—— 报同一类看不懂的话。
 *    不把 init 的结果留下来，真机上报错时这两者无法区分 —— 而官方指引里
 *    这两个症状被归在同一条（基础库版本），照它去查就可能一路查错方向。
 *
 * ⚠️ 它必须住在**有状态、被外置**的模块里（见 build.mjs 的 SHARED_STATEFUL）：
 *    写在 config.ts 那种会被内联进每个页面的模块里，app.js 写的是它自己那份，
 *    页面读的是另一份 —— 症状是「明明记了，读出来永远是未执行」。
 */
let cloudInit: { ok: boolean; error: string } | null = null

/** app.ts 的 onLaunch 里调它 —— 成功失败都要调（见上面那段说明） */
export function markCloudInit(ok: boolean, err?: unknown): void {
  cloudInit = { ok, error: ok ? '' : String((err as Error)?.message ?? err ?? '未知原因') }
}

/**
 * 云通道失败时**必须一起报出来**的几个事实，拼成一句话。
 *
 * ⚠️ 基础库版本排第一：真机上最常见的那条错（undefined is not an object）
 *    只有对着版本号才有意义 —— 2.23.0 是 callContainer 的门槛。
 */
export function containerDiag(): string {
  const init = cloudInit
    ? cloudInit.ok
      ? 'wx.cloud.init 成功'
      : 'wx.cloud.init 失败：' + cloudInit.error
    : 'wx.cloud.init 未执行'
  return `基础库 ${SDK_VERSION} · ${PLATFORM} / ${ENV_VERSION} 版 · ${TARGET} · ${init}`
}

/** callContainer 这条通道根本不存在时的统一话术（含诊断） */
function noContainerHint(): string {
  return (
    '当前环境没有 wx.cloud.callContainer —— 这条通道要基础库 ≥ 2.23.0，' +
    '或 wx.cloud.init() 没成功。请把手机微信升级到最新，' +
    '并在小程序后台「设置 → 功能设置 → 基础库最低版本设置」填 2.23.0 或更高。' +
    '（' + containerDiag() + '）'
  )
}

/**
 * 「SDK 还没就绪」的判据 —— 官方封装里就是按这个字符串判断并等 300ms 重试的。
 * ⚠️ SDK 自己的原文是 "Cloud API isn't enabled"，但引号在不同版本里出现过
 *    ' 和 ’ 两种，所以用 isn'?t 兜住。
 */
const CLOUD_NOT_READY = /Cloud API isn'?t enabled|Cloud API is not enabled/i

let token = ''

export function setToken(t: string): void {
  token = t
  wx.setStorageSync('token', t)
}

/**
 * ⭐ 当前用户 id —— **上传音频的路径需要它**（audio/{句子id}/{uid}/{ts}.pcm）。
 *
 * 服务端会校验路径里的 uid 必须等于发起请求的人，所以这个值必须来自服务端，
 * 不能由客户端随便编。
 */
let userId = 0

export function setUserId(id: number): void {
  userId = id
  wx.setStorageSync('uid', id)
}

export function getUserId(): number {
  if (!userId) userId = Number(wx.getStorageSync('uid')) || 0
  return userId
}

function restoreToken(): string {
  if (!token) token = (wx.getStorageSync('token') as string) || ''
  return token
}

/**
 * 鉴权 header —— 给 wx.uploadFile 用。
 * ⚠️ wx.uploadFile 不走 request()，所以得把 header 单独暴露出去，
 *    否则本地上传会因为「未登录」被 401（而 API 调用却是好的，很难联想到一起）。
 */
export function authHeader(): Record<string, string> {
  const t = restoreToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/**
 * ⭐ 服务端回「你还没加入句拼」（403 `NOT_REGISTERED`）时的回调 —— 由 lib/auth 注册。
 *
 * ⚠️ 为什么是回调而不是直接 import store：这一层只管**传输**（拼路径 / 分类错误），
 *    不该认识全局状态；而"把本机过期的身份快照清掉"是 auth 的事。
 * ⚠️ 有了它，账号在服务端被删（清库 / 换环境）之后本机不会一直卡在"我加入过"：
 *    任意一次鉴权请求收到这个码，导航栏当场翻回「加入」。
 */
let onNotRegistered: (() => void) | null = null

export function setNotRegisteredHandler(fn: () => void): void {
  onNotRegistered = fn
}

interface RawResponse {
  statusCode: number
  data: unknown
}

/**
 * ⭐ 可重试的错误 —— 与「业务失败」严格区分开。
 *
 * ⚠️⚠️ 这不是"网络抖动的泛泛重试"，而是一个**实测到的确定现象**：
 *    微信云托管**缩容到 0** 之后，第一个请求会撞在实例启动窗口上，
 *    网关直接返回 **503**（nginx 的 HTML，不是我们的 JSON 信封）。
 *
 *    实测（dev 环境）：
 *      第 1 次 8 秒超时 → 拿到 503 HTML
 *      第 2 次 **6.2 秒** → 200，body 正常
 *      第 3 次 **0.2 秒** → 200
 *
 *    没有重试的后果是：**用户第一次打开小程序就是「句子加载失败」**，
 *    刷新一下就好 —— 但用户不会刷新第二次。
 */
class RetryableError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message)
    this.name = 'RetryableError'
  }
}

/**
 * ⭐ 服务端明确回答「这段音频正在打分」—— 它**不是失败**，是让你等一下再问。
 *
 * ⚠️ 为什么必须单独一个类型：它是一个 **4xx + 正常信封** 的响应，
 *    按现有规则会被当成「业务失败」直接抛给页面，于是用户看到「正在打分，请稍候」
 *    被当成错误弹出来 —— 而正确行为是**再等一会儿重试**（分数其实马上就好）。
 *
 *    这条分支之所以存在，是因为打分要 10–20 秒，而云托管 callContainer
 *    单次超时上限只有 15 秒：客户端先超时、服务端后完成是**常态**而非异常。
 */
class StillScoringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StillScoringError'
  }
}

/**
 * ⭐ token 失效（HTTP 401）。
 *
 * ⚠️⚠️ 它必须是一个**能被上层识别并补救**的错误，不能像原来那样直接抛给页面。
 *    原来 401 的处理是「清掉 token + 抛一句『登录已过期』」，而重新登录
 *    只发生在 app.onLaunch —— 结果是**死局**：
 *
 *      · token 一失效，之后每一个请求都 401
 *      · 用户看到的只有一句「登录已过期」，既不知道要重启小程序，也不知道怎么重启
 *      · 除了杀掉小程序重进，没有任何出路
 *
 *    ⚠️ 触发场景通常**不是攻击**，而是服务端把账号重置了：换 token 密钥、
 *       清库、换环境。那时旧 token 里的 userId 在库里已经不存在。
 *       （本项目就真实发生过一次：清测试数据时把开发账号一起删了。）
 */
class AuthExpiredError extends Error {
  /**
   * ⭐ 401 的**错误码** —— 客户端判"服务端明确说认不出我"就靠它
   *    （见 lib/auth.ts 的 isAuthError）。
   *
   * ⚠️ 2026-09 之前这个字段**根本不存在**：auth.ts 判的是 `e.code === 'AUTH_EXPIRED'`，
   *    而这里没赋值、服务端 401 也没给 ⇒ 那条分支是**死代码**：
   *    token 失效时界面画的是「重新连接」而不是「加入」，用户点重试还是失败。
   * ⚠️ 现在两端都给了：服务端 401 带 `code`（AUTH_EXPIRED / AUTH_REQUIRED），
   *    这里兜底成同一个值 —— 只认 401 这一条路径（其余错误码一律当"没问到"）。
   */
  code = 'AUTH_EXPIRED'

  constructor(code?: string) {
    super('登录已过期')
    this.name = 'AuthExpiredError'
    if (code) this.code = code
  }
}

/**
 * ⭐⭐ 重试的**总预算**（毫秒）—— **包含每次请求本身的耗时**，不只是退避延迟。
 *
 * ⚠️⚠️ 这个上限是补一个真实事故：原来只有退避延迟、没有总预算，
 *    于是单次请求的最坏耗时 = 5 次 × 15s 超时 + 19s 退避 ≈ **94 秒**。
 *    启动时有登录 / 健康检查 / 拉内容两三个请求，叠起来就是**好几分钟**，
 *    表现正是「每次加载都卡在环境检测那一步」。
 *
 * ⭐ 12 秒是这么定的：冷启动实测 6.2 秒（第一次撞 503 是**快速**返回的，不占超时），
 *    所以「快速失败 + 退避 + 第二次成功」总共约 7 秒，12 秒留了余量；
 *    而服务真挂了时，12 秒也够让人看出是它坏了、而不是卡死了。
 */
const RETRY_BUDGET_MS = 12_000

/**
 * ⭐ **启动预算** —— 只给"打开小程序时那几个请求"用，比上面那个宽。
 *
 * ⚠️⚠️ 为什么需要它：云托管缩容到 0 之后，**第一个请求是硬等的**，
 *    实测 9.3 秒（早先这里记的"冷启动 6.2 秒"已经偏乐观，而且那时第一次是
 *    快速失败 503、不占超时；现在是请求就那么挂在半路上）。
 *    12 秒的预算会把这一次掐掉，用户看到「服务正在启动中，请再试一次」——
 *    而他其实只需要再等两秒。
 *
 * ⚠️⚠️ 25s 这个值**不够**（2026-09 实测）：缩容到 0 之后第一次请求实测要 30s 级，
 *    而 `callContainer` 单次上限 15s ⇒ 25s 预算在实例起来之前就耗尽，
 *    首屏表现成「连不上服务器，检查网络后重试」—— 其实只是平台在启动实例。
 *    提到 50s：15s + 退避 + 15s + 退避 + 15s 能覆盖 30s 级冷启动，留一倍余量。
 *
 * ⚠️ 只给**入口类**请求用（首屏那几个 + 从首页点进朗读页时的正文那一拉）：
 *    会话中（已经在读句子、在提交、在翻历史）再等 50 秒没有意义，
 *    那时候失败得越快越好 —— 所以那些请求仍然走默认的 12 秒。
 *    ⚠️ 朗读页的正文那一拉算「入口」：它是**用户刚点了一下**、界面上什么都没有的那一刻，
 *      和首屏同一类。见 lib/content/index.ts 的说明（用户 2026-09 报的
 *      「dev 环境 reading 页打不开」就是它吃了 12 秒预算）。
 */
export const LAUNCH_BUDGET_MS = 50_000

/**
 * 重试节奏（毫秒，第 0 项是「立刻试第一次」）。
 * ⚠️ 各项之和要明显小于 RETRY_BUDGET_MS —— 预算是**总量**，延迟只是其中一部分。
 */
const RETRY_DELAYS_MS = [0, 700, 1500, 3000]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 判断 body 是不是我们的统一信封 */
function isEnvelope(body: unknown): boolean {
  return !!body && typeof body === 'object' && 'ok' in (body as Record<string, unknown>)
}

/**
 * 带业务码的接口错误。
 *
 * ⚠️ 为什么需要：服务端有些失败**不是「出错了」，而是正常业务分支** ——
 *    最典型的是额度用完（429 + code:'QUOTA_EXHAUSTED'，今天的挑战次数用完）。
 *    只传 message 的话，页面只能显示「挑战冷却中」，
 *    却没法告诉用户「还有 6 小时 12 分」。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 把两条通道的响应归一成同一种处理。
 *
 * ⚠️ 前提：**所有**接口都用同一个信封 { ok: true, data } / { ok: false, error }。
 *    /health 曾经破例返回扁平结构，导致它每次都被判成失败（报「请求失败」），
 *    而服务端其实返回了 200 —— 前端症状和真实网络状况完全脱节。
 *    新增接口时务必走信封。
 */
function handleResponse<T>(
  res: RawResponse,
  resolve: (v: T) => void,
  reject: (e: Error) => void,
): void {
  const body = res.data as ApiResult<T>
  if (res.statusCode === 401) {
    // ⚠️ 这里仍然清掉 token（它确实没用了），但**不再**直接把错误抛给页面 ——
    //    交给 request() 去重新登录一次（见 AuthExpiredError 的注释）。
    token = ''
    wx.removeStorageSync('token')
    // ⚠️ 把服务端给的 code 带上（它区分"凭据过期"与"没带凭据"，对界面是同一件事，
    //    但排查时能看出是哪一种）；没给就退回默认值
    reject(new AuthExpiredError((body as { code?: string })?.code))
    return
  }
  // ⚠️ 5xx，或者 2xx 但拿到的不是我们的信封 —— 两种都指向「还没打到我们的服务」，
  //    典型就是冷启动期间网关返回的 503 HTML。**只有这两种才重试**，
  //    业务失败（4xx + 正常信封）绝不能重试 —— 比如冷却 429，重试只会白烧额度。
  if (res.statusCode >= 500 || (res.statusCode < 400 && !isEnvelope(body))) {
    reject(new RetryableError(`HTTP ${res.statusCode}（不是本服务的响应）`, res.statusCode))
    return
  }

  if (body && typeof body === 'object' && 'ok' in body && body.ok) {
    resolve(body.data)
  } else {
    const failure = body as { error?: string; code?: string } | undefined
    // ⭐ 「正在打分」走可重试分支，不要报成错误
    if (failure?.code === 'SCORING') {
      reject(new StillScoringError(failure.error ?? '正在打分'))
      return
    }
    reject(
      new ApiError(
        failure?.error ?? '请求失败',
        failure?.code,
        failure as Record<string, unknown> | undefined,
      ),
    )
  }
}

/**
 * 通道 ①：wx.request —— 本地联调用。
 * 需要合法域名（开发时可勾「不校验合法域名」）。
 */
async function httpRequest<T>(path: string, options: RequestOptions): Promise<T> {
  /**
   * ⭐⭐ 鉴权路径在发请求前先确保「登录已经完成」。
   *
   * ⚠️⚠️ 启动时 app.onLaunch 的 login() 与首屏页面的请求是**并发**的：
   *    页面请求往往先跑，这时要么还没有 token、要么还是上一次的旧 token，
   *    于是首屏必然先吃一个 401（再靠自动重登补救）—— 控制台一片红，还白跑一轮。
   *    这里等同一个 loginInFlight，首屏就直接用刚签发的 token。
   * ⚠️ 只等 /api/user/*（鉴权路径）：公开路径（如 /api/articles）不该被登录拖慢。
   * ⚠️ /api/auth/* 自己就是登录，绝不能再等它，否则递归。
   */
  if (path.startsWith('/api/user/')) {
    if (!restoreToken() || loginInFlight) await login()
  }

  const t = restoreToken()
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: options.method ?? 'GET',
      data: options.data as never,
      timeout: Math.max(2_000, options.timeout ?? 60_000),
      header: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      success: (res) => handleResponse<T>(res as unknown as RawResponse, resolve, reject),
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}

/**
 * 通道 ②：wx.cloud.callContainer —— 云托管正式通道。
 *
 * ⭐ 免域名、免备案、不用配服务器域名，而且**不需要 token**：
 *    微信网关会注入 x-wx-openid，后端直接认这个身份（见 server 的 middleware/auth.ts）。
 *
 * ⚠️ 两个硬限制：
 *    ① timeout 上限 15 秒，写大了无效；
 *    ② 请求体上限 100KiB（超限报业务错误码 -606001）——
 *       所以音频必须走对象存储直传，这里只传 fileID。
 */
function containerRequest<T>(path: string, options: RequestOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    // ⚠️ 两个前提，缺一个都会报「is not a function」这种没法排查的错：
    //    ① 基础库 ≥ 2.23.0（旧基础库没有 callContainer）
    //    ② app.onLaunch 里的 wx.cloud.init() 必须成功
    if (typeof wx.cloud?.callContainer !== 'function') {
      reject(new Error(noContainerHint()))
      return
    }

    /**
     * ⚠️⚠️ init 是**异步**的：onLaunch 里调完 wx.cloud.init() 之后立刻发请求，
     *    有那么一小段窗口 SDK 还没就绪，此时失败信息是「Cloud API isn't enabled」。
     *    官方给出的封装对这条**等 300ms 再试，最多 3 次**（见「调用云托管服务 / 微信小程序」的万能封装），
     *    我们照做 —— 否则症状是「首次打开偶发失败，再点一次就好」，
     *    而这会被误当成冷启动、去查完全不相干的方向。
     */
    let readyRetry = 0
    const call = (): void => {
      wx.cloud.callContainer({
        config: { env: CLOUD_ENV_ID },
        path,
        method: options.method ?? 'GET',
        header: {
          'Content-Type': 'application/json',
          'X-WX-SERVICE': CLOUD_SERVICE,
        },
        data: (options.data ?? {}) as Record<string, unknown>,
        // ⚠️ 上限仍是 15 秒（云托管硬限制），但由调用方按剩余预算压小
        timeout: Math.min(15_000, Math.max(2_000, options.timeout ?? 15_000)),
        success: (res) => handleResponse<T>(res as unknown as RawResponse, resolve, reject),
        fail: (err) => {
          // ⚠️ 「还没初始化完」是**时机的错**，不是环境的错 —— 等一会儿再来（见上面 readyRetry 的说明）
          if (CLOUD_NOT_READY.test(err?.errMsg ?? '') && readyRetry < 3) {
            readyRetry++
            setTimeout(call, 300)
            return
          }
          reject(containerFailure(path, err))
        },
      })
    }
    call()
  })
}

/**
 * ⭐⭐ 云托管通道的失败**翻译** —— 把一句没法排查的话变成能动手的话。
 *
 * ⚠️⚠️ 为什么必须做这件事：真机上这条通道失败时，SDK 给的 errMsg 可能是
 *    **「undefined is not an object」** —— 它一个字都没提云托管，也没提版本，
 *    于是页面（index 的 error 卡片）原样把它显示出来，看起来像我们自己的代码炸了。
 *
 *    官方排查指引里这条症状是**成组**出现的（原文照抄）：
 *      「wx.cloud.callContainer is not a function / wx.cloud.connectContainer is not a function /
 *        fail underfined is not an object」→ 错误原因：**基础库版本太低**，
 *      解法是把基础库升到 2.23.0+，并在后台把「基础库最低版本设置」也设成 2.23.0+。
 *    （见 https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/faq.html）
 *
 * ⚠️ 刻意归成 **ApiError（不可重试）**：版本不够这种事重试四次只会白等六秒，
 *    报错却一模一样 —— 见 isTransportFailure 对 ApiError 的豁免。
 *    （其余失败仍然原样抛出，交给上层的冷启动重试去处理，只是把诊断拼在后面。）
 */
function containerFailure(path: string, err: { errMsg?: string }): Error {
  const raw = err?.errMsg || '云托管调用失败'
  if (/undefined is not an object|is not a function|Cloud API isn't enabled|Cloud API is not enabled/i.test(raw)) {
    return new ApiError(
      '云托管通道不可用（底层报错原文「' + raw + '」）—— 多半是手机微信的基础库低于 2.23.0：' +
        '① 把手机微信升级到最新版；' +
        '② 在小程序后台「设置 → 功能设置 → 基础库最低版本设置」填 2.23.0 或更高。' +
        '（' + TARGET + ' · ' + path + ' · ' + containerDiag() + '）',
      'CONTAINER_UNAVAILABLE',
    )
  }
  // ⚠️ 其余失败照旧抛（保留 errMsg 原文，重试判据认的就是它），只把诊断附在后面
  return new Error(raw + '（' + path + ' · ' + containerDiag() + '）')
}

interface RequestOptions {
  /**
   * ⚠️ PUT / DELETE 也在这里（收藏那个开关就用它们）。
   *    wx.request 本身支持任意方法，这里放开类型就够了 ——
   *    上面两处透传（method: options.method ?? 'GET'）不需要改。
   */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: unknown
  /**
   * 本次请求的超时上限（毫秒）。
   * ⚠️ 由 request() 按**剩余预算**动态压小 —— 保证「重试总耗时」不会失控。
   */
  timeout?: number
  /**
   * 整个请求（含全部重试）的时间预算，毫秒。默认 RETRY_BUDGET_MS（12 秒）。
   *
   * ⚠️⚠️ 慢接口**必须**显式调大，否则第一次尝试就会在服务端干完活之前被自己掐断。
   *    这不是理论风险，是真实事故：
   *      · 12 秒这个默认值是**为冷启动定的** —— 网关 503 是**快速返回**的，
   *        所以「快速失败 + 退避 + 重试」总共约 7 秒就够。
   *      · 但**打分是慢操作**：一次讯飞评测实测 9.8 秒（8.8 秒音频），长句要 15 秒以上。
   *      · 于是提交检测永远在「服务端马上要返回」的那一刻超时，
   *        用户看到 request:fail timeout —— 而服务端其实已经把分打好了。
   */
  budgetMs?: number
  /**
   * 内部用：禁止「401 自动重登」。
   * ⚠️ 登录接口自己必须带上它，否则登录失败会递归地再触发一次登录。
   */
  noRelogin?: boolean
}

/**
 * ⭐ 带冷启动重试的请求。所有接口都走这里，所以重试逻辑只有一份。
 *
 * ⚠️ 只重试「没打到我们服务」的情况（见 handleResponse 与 RetryableError）：
 *    · 5xx / 非信封响应 —— 冷启动期间的网关 503
 *    · 传输层失败（超时、连接被拒）—— 冷启动的另一种表现
 *    业务失败（401 / 4xx + 信封）**一次都不重试**，直接抛给调用方。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await requestWithRetries<T>(path, options)
  } catch (err) {
    // ⭐ 只有 token 失效这一种错误值得「重新登录 + 再试一次」。
    //    ⚠️ 重试时带上 noRelogin，保证**同一次请求最多重登一次** ——
    //       否则服务端真挂了（一直 401）会变成客户端疯狂打登录接口。
    if (err instanceof AuthExpiredError && !options.noRelogin) {
      console.warn('[api] 登录已失效，自动重新登录后重试：' + path)
      await relogin()
      return requestWithRetries<T>(path, { ...options, noRelogin: true })
    }
    /**
     * ⭐ 服务端说「库里没有我这一行」—— 本机那份"已加入"的快照已经过期
     *    （清库 / 换环境 / 账号被删）。交给 auth 清身份，界面翻回「加入」。
     *    ⚠️ 这里**不重试**：重试也不会凭空多出一行来 —— 建行只发生在加入页那一次。
     */
    if (err instanceof ApiError && err.code === 'NOT_REGISTERED') onNotRegistered?.()
    throw err
  }
}

/**
 * ⭐ 登录中 —— **并发调用共用同一个 Promise**。
 *
 * ⚠️⚠️ 两件事共用它，所以必须合并：
 *    · app.onLaunch 的启动登录；
 *    · 首屏页面的请求 —— 它们会在登录完成**之前**就发出去（页面 onLoad 不等 onLaunch 的
 *      异步登录）。不合并的话：要么同时打 N 次 wx.login + /api/auth/login（只有最后一次
 *      有效），要么页面拿着还没换上的旧 token 先撞一个 401，再靠自动重登补救。
 *      两者都表现为「控制台一片红、白跑一轮」。
 */
let loginInFlight: Promise<void> | null = null

export function login(): Promise<void> {
  if (!loginInFlight) {
    loginInFlight = doLogin().finally(() => {
      // ⚠️ 稍后才放开：同一次启动里的并发请求都复用这一次登录，别各自再打一遍
      setTimeout(() => {
        loginInFlight = null
      }, 2_000)
    })
  }
  return loginInFlight
}

/** ⭐ 401 的补救入口 —— 与启动登录共用同一个 Promise（见 login 的说明） */
function relogin(): Promise<void> {
  return login()
}

/**
 * ⭐ 把「重试到预算用尽」的底层错误翻译成**用户能动手**的一句话。
 *
 * ⚠️⚠️ 为什么必须抽出来：原来这段翻译只存在于循环体的 `lastAttempt` 分支里，
 *    而预算被掐断时走的是上面的 `break`（预检查）—— 那条路直接 `throw lastErr`，
 *    于是 `callContainer`（单次上限 15s）下请求「挂在半路」，几乎必然从 `break` 出去，
 *    用户看到的是原始 `request:fail timeout`，而这段人话成了**死代码**。
 *    现在两条出口（循环内最后一次失败、预算耗尽 break）都走这里。
 */
function exhaustedError(e: Error, startedAt: number): ApiError {
  // ⚠️ 「重试到预算用尽」有两种完全不同的原因，**不能给同一句话**：
  //    ① 冷启动：请求根本没打到服务（服务端没有任何记录）
  //    ② 打分未完成：服务端正在跑评测，只是还没跑完
  //    把它们都说成「服务正在启动中」会让用户以为服务挂了、去重开小程序，
  //    而这恰恰是唯一不该做的动作（重开也不会更快）。
  const scoring = e instanceof StillScoringError
  return new ApiError(
    scoring
      ? '打分还在进行中（长句要十几秒），再点一次「提交检测」即可拿到结果 —— 不会重复计费'
      : '服务正在启动中（云托管冷启动要十几秒），请再试一次',
    scoring ? 'SCORING' : 'COLD_START',
    {
      attempts: RETRY_DELAYS_MS.length,
      elapsedMs: Date.now() - startedAt,
      target: TARGET,
      lastError: e.message,
    },
  )
}

/** 带冷启动重试的请求主体 —— 401 的补救在 request() 那一层，这里不管 */
async function requestWithRetries<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let lastErr: Error | null = null

  const budget = options.budgetMs ?? RETRY_BUDGET_MS
  const startedAt = Date.now()

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] as number
    if (delay > 0) await sleep(delay)

    /**
     * ⚠️⚠️ **预算检查** —— 这是防「卡几分钟」的关键，且位置很讲究：
     *    放在**发起之前**，并且把剩余预算当作这次的超时上限。
     *    这样总耗时被硬压在 RETRY_BUDGET_MS 附近，而不是各次超时相加
     *    （没有它时的最坏情况是 5 × 15 秒 = 75 秒的白等）。
     */
    const remaining = budget - (Date.now() - startedAt)
    if (remaining <= 2_000) break

    // ⚠️ 只在「还有下一次机会」时才吞掉错误；最后一次必须原样抛出去
    const lastAttempt = attempt === RETRY_DELAYS_MS.length - 1

    /**
     * ⭐ 每一次尝试都记一行「耗时 + 第几次 + 累计 + 实际目标」。
     *
     * ⚠️⚠️ 加它的原因：真机上「慢」这个体感，无法从任何一层单独判断 ——
     *    可能是传输层（callContainer 本身的网关开销）、可能是实例冷启动、
     *    也可能是某个接口服务端确实慢。没有这行日志，只能靠猜。
     *    目标（TARGET）一并打出来，是为了立刻分清「打的是本机 Docker 还是 dev 云」。
     */
    const attemptStartedAt = Date.now()
    try {
      const attemptOptions: RequestOptions = { ...options, timeout: remaining }
      const result = await (TRANSPORT === 'container'
        ? containerRequest<T>(path, attemptOptions)
        : httpRequest<T>(path, attemptOptions))
      console.log(
        `[api] ← ${path} 成功 ${Date.now() - attemptStartedAt}ms（第 ${attempt + 1} 次，累计 ${Date.now() - startedAt}ms）→ ${TARGET}`,
      )
      return result
    } catch (err) {
      const e = err as Error
      const attemptElapsed = Date.now() - attemptStartedAt
      // ⚠️ AuthExpiredError 刻意**不在这里重试** —— 它是 request() 那一层的事，
      //    在那里重试之前会先重新登录。在这里当成普通传输失败重试，
      //    只会在同一个失效 token 上白撞三次。
      if (e instanceof AuthExpiredError) throw e
      const retryable =
        e instanceof RetryableError || e instanceof StillScoringError || isTransportFailure(e)
      if (!retryable || lastAttempt) {
        console.warn(
          `[api] ✗ ${path} 最终失败 ${attemptElapsed}ms（第 ${attempt + 1} 次，累计 ${Date.now() - startedAt}ms）→ ${TARGET}：${e.message}`,
        )
        // ⭐ 翻译成同一句人话 —— 与下面「预算耗尽」那条出口共用，见 exhaustedError()
        if (retryable && lastAttempt) throw exhaustedError(e, startedAt)
        throw err
      }
      lastErr = e
      console.warn(
        `[api] ✗ ${path} 第 ${attempt + 1} 次失败 ${attemptElapsed}ms（累计 ${Date.now() - startedAt}ms）→ ${TARGET}，将重试：${e.message}`,
      )
    }
  }

  /**
   * ⚠️⚠️ 走到这里说明**预算在发起下一次之前就被检查掐断了**（见上面的 break），
   *    而不是「循环正常跑完」。这正是 `callContainer` 冷启动的典型形态：
   *    请求挂在半路直到单次上限，剩余预算不够再发一次 —— 若不在这里翻译，
   *    上面那段人话就永远用不上（见 exhaustedError 的说明）。
   */
  if (
    lastErr &&
    (lastErr instanceof RetryableError || lastErr instanceof StillScoringError || isTransportFailure(lastErr))
  ) {
    throw exhaustedError(lastErr, startedAt)
  }
  throw lastErr ?? new Error('请求失败')
}

/**
 * 传输层失败（不是服务端给的业务错误）。
 *
 * ⚠️ 判据是「我们没有拿到任何 HTTP 响应」——wx.request / callContainer 在这种情况下
 *    走的是 fail 回调，errMsg 形如 "request:fail timeout"。
 *    冷启动期间连接被网关掐断也长这样，所以归入可重试。
 */
function isTransportFailure(e: Error): boolean {
  if (e instanceof ApiError) return false
  return /fail|timeout|超时|ECONN|ENOTFOUND|socket/i.test(e.message)
}

/**
 * ⭐ 打开即登录：wx.login → openid，无注册、无密码、无验证码。
 *
 * ⚠️ cloud 模式下身份由微信网关注入，不需要 token —— 但**仍然要取一次 uid**，
 *    因为上传音频的路径里必须带 uid（服务端会校验）。
 *    （早先这里只探了个健康检查，导致拿不到 uid，见 upload.ts。）
 */
/**
 * ⭐ wx.login 拿 code。
 *
 * ⚠️ 它现在有**两个**用途，所以抽出来：
 *    ① login() 换 token（本地 / 公网通道）
 *    ② 下单前换 session_key —— 虚拟支付的**用户态签名**要它，
 *       而线上主通道 callContainer **拿不到 session_key**（openid 由网关注入）。
 *    两处各写一遍的话，迟早有一处忘了处理失败分支。
 */
export function wxLoginCode(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}

async function doLogin(): Promise<void> {
  if (TRANSPORT === 'container') {
    /**
     * ⚠️⚠️ 云托管通道下**没有"登录"这个动作**：openid 由微信网关在每一个请求上注入，
     *    所以这里不需要、也不该打任何请求。
     *
     *    ✗ 它以前 GET `/api/user/me`，而那一刻服务端会**顺手建号** ——
     *      等于「打开小程序即注册」，用户没有任何选择的机会。
     *      注册现在必须由用户显式发起（加入页 → `register()`），
     *      服务端的 authMiddleware 也改成**只查不建**了（见 middleware/auth.ts）。
     *
     *    ⚠️ uid 也不再由这里设置：它只可能来自一次**成功的** `/me` 或注册响应 ——
     *      未注册的人根本没有 uid（上传路径那块本来也走不到）。
     */
    return
  }

  const code = await wxLoginCode()
  const data = await request<{ token: string; user: { id: number } | null }>('/api/auth/login', {
    method: 'POST',
    data: { code },
    // ⚠️ 必须带：不然登录失败会递归地再触发一次登录，直到栈溢出
    noRelogin: true,
    // ⭐ 启动请求：给冷启动留够时间（见 LAUNCH_BUDGET_MS）
    budgetMs: LAUNCH_BUDGET_MS,
  })
  setToken(data.token)
  // ⚠️⚠️ `user` 可为 **null**：登录 ≠ 注册（2026-09 定）。
  //    还没加入句拼的人也能拿到 token（里面带的是凭据），但没有账号可回 ——
  //    这里**绝不能**再去 /me 或建号，那是回到"自动注册"。
  if (data.user) setUserId(data.user.id)
}

/**
 * ⭐ **最新上线**（`GET /api/articles/latest`）—— 句库里按上线时间倒序的最新 N 句
 *    （首页下半段那一段）。2026-09 从 `/api/articles?latest=N` **独立成一条地址**。
 *
 * ⚠️⚠️ 它与「今天挑战」（`fetchToday`）是**两个接口**（用户 2026-09 明确）：
 *    · 这条：**公开**、对所有人一样，按 `articles.published_at` 倒序；
 *    · today：**按 uid（或匿名随机）**，答「今天适合读哪一句」。
 *    两者原来是同一个 `/api/schedules` 返回的两段 —— 那条接口**整体删除**了，
 *    `schedules` 这个名字（表 / 接口 / 概念）都不该再出现。
 *
 * ⚠️ 首页是**公开页面**：这一份不含任何「我的」字段（我的战绩按句子走
 *    `/api/user/participation/{articleId}`，见 lib/participation.ts）。
 *
 * ⚠️ **带 `date`**（服务端的今天）：端侧拿它判"首屏缓存是不是今天的"（见 store）。
 */
export function fetchLatestCards(limit = 6): Promise<LatestCardsResponse> {
  // ⭐ 首页的第一个请求 —— 冷启动就撞在它身上，给足预算（见 LAUNCH_BUDGET_MS）
  return request<LatestCardsResponse>('/api/articles/latest?limit=' + limit, {
    budgetMs: LAUNCH_BUDGET_MS,
  })
}

/** 通用句库查询的参数（对应 `GET /api/articles` 的 querystring） */
export interface ArticleLibraryQuery {
  /** 逗号分隔也行；数组会被拼成 `a,b`。**任一命中**（OR） */
  tags?: string | string[]
  /**
   * 难度档 0-3；**任一命中**。
   * ⚠️ 单个数字、逗号分隔的字符串、数组都收（实现里统一拼成 `a,b`）——
   *    browse 页只选一档，传单个数字最自然。
   */
  difficulty?: string | number | number[]
  /** `date`（默认，上线时间倒序）| `participants`（参与人数倒序） */
  sort?: 'date' | 'participants'
  /** 1..100，默认 50 */
  limit?: number
  /** 从第几条开始（翻页；默认 0）—— 无限滚动用 */
  offset?: number
}

/**
 * ⭐ **句库查询**（`GET /api/articles`）—— 按标签 / 难度筛选，按日期 / 参与人数排序。
 *
 * ⚠️ 与 `fetchLatestCards` 的分工：这个是**通用查询**（筛选 + 排序 + 数量），
 *    那个是首页那一段的固定口径（最新上线、默认 6 条）。
 * ⚠️ 公开接口：不需要鉴权，返回的也是纯句子数据。
 */
/**
 * ⭐ **全部标签 + 各自几篇**（`GET /api/tags`，公开）—— tags 页的名录。
 *
 * ⚠️ 排序由服务端定死（文章数降序 → 标签升序），端侧**不要**再排。
 * ⚠️ 搜索在端侧做：标签总量是几十个，本地过滤更快，也不用为每个输入字符发请求。
 */
export function fetchTags(): Promise<TagsResponse> {
  return request<TagsResponse>('/api/tags')
}

export function fetchArticleLibrary(q: ArticleLibraryQuery = {}): Promise<ArticleListResponse> {
  const params: string[] = []
  const tags = Array.isArray(q.tags) ? q.tags.join(',') : q.tags
  const difficulty = Array.isArray(q.difficulty) ? q.difficulty.join(',') : q.difficulty
  if (tags) params.push('tags=' + encodeURIComponent(tags))
  if (difficulty !== undefined && difficulty !== '') {
    params.push('difficulty=' + encodeURIComponent(String(difficulty)))
  }
  if (q.sort) params.push('sort=' + q.sort)
  if (q.limit !== undefined) params.push('limit=' + q.limit)
  if (q.offset !== undefined) params.push('offset=' + q.offset)
  return request<ArticleListResponse>('/api/articles' + (params.length ? '?' + params.join('&') : ''))
}

/**
 * ⭐⭐ **今日推荐** —— 首页那张"今日挑战"卡的数据源（公开；**未登录也能拿**）。
 *
 * ⚠️ 与 fetchLatestCards 的分工：那个给「最新上线」（公开、对所有人一样），
 *    这个给「今天适合读哪一句」（按 uid 的参与记录分场，见 services/recommend.ts）。
 *
 * ⚠️⚠️ **uid 可省略**：本地有 uid 就带上（按我的难度档选句，窗口内固定）；
 *    没有就**不带** —— 服务端按匿名给：**初级档**里**随机 + 按参与人数加权**挑一条。
 *    游客的首页也要有这张卡（老接口 `/api/user/today` 是鉴权的，未登录直接 401、卡片永远空着）。
 * ⚠️ 返回 `{ item }`：`item` 是**纯句子数据**（**不带日期** —— 句子类响应一律不带日期，
 *    归哪一天由服务端在受理提交时决定，见 submitReading 的说明）。
 * ⚠️ 首页**不 await 它**（拿不到就少一张今日卡，其余照常画 —— 卡片不能空着整页）。
 */
export function fetchToday(): Promise<TodayArticleResponse> {
  const uid = getUserId()
  const q = uid > 0 ? '?uid=' + uid : ''
  return request<TodayArticleResponse>('/api/articles/today' + q, { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ **我在这条句子上的参与记录**（鉴权）—— 首屏今日卡的「已参与 / 最高分 / 按钮文案」。
 *
 * ⚠️ 服务端在没参与过时给 **data: null**（不是 404、也不是一条全 0 的记录）——
 *    0 分是合法成绩，两者不能混。
 */
export function fetchParticipation(articleId: string): Promise<ParticipationRecord | null> {
  return request<ParticipationRecord | null>('/api/user/participation/' + articleId)
}

/**
 * ⭐ **一条参与记录的详情**（公开）—— 从榜单点某一行进去看。
 *
 * ⚠️ `participationId` 就是 `participations.id`：`sha256(userId + ':' + articleId)` 的前 24 位
 *    （服务端派生，见 db/schema.ts）—— **整表重建后不变**，所以链接可以分享出去。
 * ⚠️ 记录不存在时服务端回 `data: null`（不是 404）。
 */
export function fetchParticipationDetail(
  participationId: string,
): Promise<ParticipationRecord | null> {
  return request<ParticipationRecord | null>('/api/participation/' + participationId)
}

/**
 * ⭐ 「我是谁」—— 昵称 / 头像 / 已征服句子数 / streak。
 *
 * ⚠️ 和 login() 分开，因为它们解决的是两件事：
 *    login()  解决「我凭什么发请求」（拿 token / uid，失败就是不能用）；
 *    fetchMe() 解决「我长什么样、战绩如何」（纯展示，失败只该少一个头像）。
 *    合成一个的后果是把「头像没取到」升级成「整个小程序用不了」。
 *
 * ⚠️ 容器通道下 login() 内部也调了一次同一个接口（它只要 id）——
 *    那一次是**必须**的（uid 拿不到就没法上传），这一次是顺带取展示数据。
 */
/**
 * ⭐ 「连战记录」—— 某个月的日历（哪天读了、哪天的缺口是解冻卡补的）。
 *
 * ⚠️ 日历排版要的三个数（首日 / 天数 / 首日是周几）**全部由服务端给**：
 *    端侧拿 'YYYY-MM-01' 去 new Date() 会按 UTC 解析，星期几可能差一天 ——
 *    而那种错在界面上只表现为"整月的格子整体错位"，很难看出来。
 *
 * @param month 'YYYY-MM'；不给就是服务端的这个月
 */
export function fetchStreakRecord(month?: string): Promise<StreakRecordResponse> {
  const q = month ? '?month=' + encodeURIComponent(month) : ''
  return request<StreakRecordResponse>('/api/user/streak-record' + q, { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 领取待领取的解冻卡。
 * ⚠️ 服务端幂等：没有待领取的就返回 claimed=0，不报错。
 */
export function claimRewards(): Promise<{ claimed: number; streak: StreakView }> {
  return request<{ claimed: number; streak: StreakView }>('/api/user/claim', {
    method: 'POST',
    budgetMs: LAUNCH_BUDGET_MS,
  })
}

/**
 * ⭐ 我的挑战记录（全部，按时间倒序）。
 * ⚠️ 它和 /api/user/me 一样属于「启动路径」—— 从用户面板点进来，
 *    冷启动时同样会等，所以给同一份宽预算。
 */
export function fetchChallenges(): Promise<ChallengesResponse> {
  return request<ChallengesResponse>('/api/user/challenges', { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 参与场次（一句 = 一场，最近参与的在前）。
 * ⚠️ 与 fetchChallenges 的区别：那个是**每一次提交**，这个是**每一句的汇总**
 *    （次数 / 最高 / 最低 / 名次）。两者服务端各一条 SQL，别互相拼。
 */
export function fetchParticipations(): Promise<ParticipationsResponse> {
  return request<ParticipationsResponse>('/api/user/participations', { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 能量：余额 + 流水（me/energy 页）。
 *
 * ⚠️ 余额是服务端**先做过每日补足**再给的，端侧拿到的就是「现在真能用几点」，
 *    所以页面不需要自己算「今天补过了没有」。
 * ⚠️ 流水用**游标**翻页（before = 上一条的 id），不是 offset ——
 *    见服务端 routes/user.ts 的说明。
 *
 * @param before 上一页最后一条的 id；不给就是第一页
 */
export function fetchEnergy(before?: number): Promise<EnergyResponse> {
  const q = before ? '?before=' + before : ''
  return request<EnergyResponse>('/api/user/energy' + q, { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 商店商品（充值卡片）。
 *
 * ⚠️ 价格**只从服务端拿**，端侧一份都不写死：小程序审核要 1–3 天，
 *    把价格绑在发版上，促销 / 调价就废了（见 docs/design/payment-and-purchase.md §2.4）。
 * ⚠️ 每件商品带 `sellable`：没配道具 / 已下架时端侧**置灰**，
 *    而不是让用户点了才失败。
 */
export function fetchShopGoods(): Promise<ShopGoodsResponse> {
  return request<ShopGoodsResponse>('/api/user/shop/goods', { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 下单，拿回签好名的 payData。
 *
 * ⚠️⚠️ 这里**一定要顺手带一个 wx.login 的 code**：
 *    下单需要用户态签名（要 session_key），而线上主通道 callContainer
 *    **根本没有 session_key**（openid 是网关注入的）。
 *    一次带上去，服务端顺手换一次并存库 —— 用户看不到「请重新登录」这种中间态。
 * ⚠️ wx.login 失败也不直接放弃：库里可能已经有可用的 session_key，
 *    让服务端自己判（它回 409 NEED_SESSION 才是真的没有）。
 */
export async function createShopOrder(goodsCode: string): Promise<ShopOrderResponse> {
  const code = await wxLoginCode().catch(() => '')
  return request<ShopOrderResponse>('/api/user/shop/order', {
    method: 'POST',
    data: { goodsCode, code },
    budgetMs: LAUNCH_BUDGET_MS,
  })
}


/** 用户目录的查询参数（对应 `GET /api/users` 的 querystring） */
export interface UserDirectoryQuery {
  /** `joined`（默认，加入时间倒序）| `energy`（能量倒序） */
  sort?: 'joined' | 'energy'
  /** 1..100，默认 50 */
  limit?: number
}

/**
 * ⭐ **用户目录**（`GET /api/users`，公开）。
 *
 * ⚠️ 前缀是**复数** `/api/users`，与鉴权的 `/api/user/*`（单数）不是一回事。
 * ⚠️ 它**含 energy**（用户 2026-09 明确要求公开）—— 别当"能量可以随便给"的先例。
 */
export function fetchUsers(q: UserDirectoryQuery = {}): Promise<UserListResponse> {
  const params: string[] = []
  if (q.sort) params.push('sort=' + q.sort)
  if (q.limit !== undefined) params.push('limit=' + q.limit)
  return request<UserListResponse>('/api/users' + (params.length ? '?' + params.join('&') : ''))
}

/**
 * ⭐ **这一句我收藏了吗** —— `GET /api/user/favorited?articleId=`（鉴权）。
 *
 * ⚠️⚠️ 它与「我在这句上的战绩」**是两条互不相干的查询**（用户 2026-09 定）：
 *    收藏与参与无关 —— **没读过也能收藏**。所以它既不在
 *    `/api/user/participation/{articleId}` 的响应里（那条对"没读过"回 null），
 *    也不该由"战绩"接口顺带回答。
 * ⚠️ 于是一次只问一句（竞技场页的一次性状态，不进 store、不需要缓存）。
 */
export function fetchFavorited(articleId: string): Promise<boolean> {
  return request<FavoritedResponse>(
    '/api/user/favorited?articleId=' + encodeURIComponent(articleId),
    { budgetMs: LAUNCH_BUDGET_MS },
  ).then((r) => r.favorited)
}

/**
 * ⭐ **这几句各被多少人收藏** —— `GET /api/stats/favorite-count?ids=`（**公开**）。
 *
 * ⚠️ 与参与统计（fetchArticleStats）**同形同源**：都是按 ids 批量、都零值补齐 ——
 *    两句话并排放在 `/api/stats` 下（用户 2026-09 定）。
 * ⚠️ 它**不需要身份**（答的是"大家"）—— 别把它和 `fetchFavorited`（答"我"，要身份）混：
 *    那两个连路径前缀都不同（`/api/stats` vs `/api/user`）。
 */
export function fetchFavoriteCounts(ids: string[]): Promise<ArticleFavoriteCountsResponse> {
  const list = [...new Set(ids.filter((id) => !!id))]
  if (list.length === 0) return Promise.resolve({ items: [] })
  return request<ArticleFavoriteCountsResponse>(
    '/api/stats/favorite-count?ids=' + encodeURIComponent(list.join(',')),
    { budgetMs: LAUNCH_BUDGET_MS },
  )
}

/**
 * ⭐ 我在**某一句**上的历史挑战（逐次，最近在前）—— 朗读页下方那一段历史。
 *
 * ⚠️⚠️ **路径挂在"参与"这个资源下面**（2026-09 改）：
 *    一次参与 = (我, 这一句)，它的**子资源**才是逐次提交。
 *    原来这条叫 `/api/user/article-records?article=` —— 那个路径服务端**已经删了**，
 *    改名前端侧漏改过一次，症状是朗读页历史区永远「请求失败」
 *    （契约守门测试 api-contract-guard 专门盯这件事）。
 * ⚠️ 只回**有结论的**那几次（scored / failed，见 shared 的 ParticipationSubmissionItem）。
 */
export function fetchParticipationSubmissions(articleId: string): Promise<ParticipationSubmissionsResponse> {
  return request<ParticipationSubmissionsResponse>(
    '/api/user/participation/' + encodeURIComponent(articleId) + '/submissions',
    { budgetMs: LAUNCH_BUDGET_MS },
  )
}

/**
 * ⭐ 收藏 / 取消收藏**一个句子**（鉴权）。
 *
 * ⚠️ 服务端两头都**幂等**（重复收、取消没收藏过的都算成功）⇒ 端侧可以乐观更新：
 *    先改界面，失败了再翻回来（见竞技场页的 onToggleFavorite）。
 */
export function setFavorite(articleId: string, on: boolean): Promise<{ articleId: string; favorited: boolean }> {
  return request<{ articleId: string; favorited: boolean }>('/api/user/favorites/' + articleId, {
    method: on ? 'PUT' : 'DELETE',
    budgetMs: LAUNCH_BUDGET_MS,
  })
}

/** ⭐ 我的收藏列表（按收藏时间倒序） */
export function listFavorites(): Promise<FavoritesResponse> {
  return request<FavoritesResponse>('/api/user/favorites', { budgetMs: LAUNCH_BUDGET_MS })
}

/** 「这一句的参与记录」查询参数（对应 `GET /api/articles/{id}/participations`） */
export interface ArticleParticipationsQuery {
  /** `time`（默认，最新参与时间倒序）| `score`（最高分倒序 = **榜单**） */
  sort?: 'time' | 'score'
  /** 1..100，默认 20 */
  limit?: number
  /** 非负整数，默认 0；下一页 = `offset + 本页条数`（响应里的 total 是总数） */
  offset?: number
}

/**
 * ⭐⭐ **某一句的参与记录**（`GET /api/article/{id}/participations`，公开）。
 *
 * 用户 2026-09：原来那条"大而全"的 `/api/arenas/:articleId` **已删除**，拆成四条：
 *   · 句子数据 → [fetchArticleContent]（`/api/article/{id}`，端侧做会话级缓存）
 *   · **参与者 / 榜单 → 就是这一条**（`sort=score` 是榜单，`sort=time` 是"最近谁来过"）
 *   · 参与统计 → [fetchArticleStats]（`/api/stats/participation`）
 *   · 我的参与 → [fetchParticipation]（`/api/user/participation/{articleId}`）
 *   · 我的收藏 → [fetchFavorited]（`/api/user/favorited`）
 *
 * ⚠️⚠️ 它挂在**句子的子资源**下（`/api/article/{id}/participations`）—— 2026-09 用户改口径：
 *    一个句子的详情 / 榜单 / 参与者都是一条句子的子集，统一收在**单数根** `/api/article` 下。
 *    （原来它自立根路径，理由是"别把可读性绑在内容行上"；但那条接口从来不校验句子是否存在，
 *     所以那个理由在实现上并不成立。）
 *    ⚠️ **与句子无关的聚合统计**不在这里 —— 那些在 `/api/stats/*`（按 ids 批量、零值补齐）。
 * ⚠️ 每一行都带 `rank`：按最高分算的**全局**名次，**与 sort 无关**。
 *    `total` 是参与者总数（分页判据）。
 */
export function fetchArticleParticipations(
  articleId: string,
  q: ArticleParticipationsQuery = {},
): Promise<ArticleParticipationsResponse> {
  const params: string[] = []
  if (q.sort) params.push('sort=' + q.sort)
  if (q.limit !== undefined) params.push('limit=' + q.limit)
  if (q.offset !== undefined) params.push('offset=' + q.offset)
  const path = '/api/article/' + encodeURIComponent(articleId) + '/participations'
  return request<ArticleParticipationsResponse>(path + (params.length ? '?' + params.join('&') : ''), {
    budgetMs: LAUNCH_BUDGET_MS,
  })
}

/**
 * ⭐⭐ **参与统计**（`GET /api/stats/participation?ids=a,b,c`，公开）—— 批量。
 *
 * 用户 2026-09 定的结构（L1 解耦）：人数 / 最高 / 最低**不挂在句子卡片上** ——
 * 它是 `participations` 的聚合派生值，每次现算。列表页拿这一屏的 id 调**一次**
 * 这个接口，再按 articleId 合并（见 lib/stats.ts 与 store 的 articleStats）。
 *
 * ⚠️ 服务端按请求的 ids **零值补齐**（没人参与 ⇒ `participantCount: 0`），
 *    所以调用方可以直接按 id 取。
 */
export function fetchArticleStats(ids: string[]): Promise<ArticleStatsResponse> {
  const list = [...new Set(ids.filter((id) => !!id))]
  if (list.length === 0) return Promise.resolve({ items: [] })
  return request<ArticleStatsResponse>(
    '/api/stats/participation?ids=' + encodeURIComponent(list.join(',')),
    { budgetMs: LAUNCH_BUDGET_MS },
  )
}

export function fetchMe(): Promise<MeResponse> {
  // ⚠️ 它也承担启动时的「我是谁」（见 lib/join.ts 的 refreshMe），同样给足预算；
  //    用户面板里那次刷新失败只是拿旧数据，多等几秒也无害。
  return request<MeResponse>('/api/user/me', { budgetMs: LAUNCH_BUDGET_MS })
}

/**
 * ⭐ 保存头像 / 昵称 —— 小程序「头像昵称填写能力」的落地口。
 *
 * ⚠️ avatarUrl 传的是**云存储 fileID**（cloud://…/avatars/…），不是临时路径：
 *    临时路径（wxfile:// 或 http://tmp/…）在本机之外根本不存在，
 *    存进库里只会得到一张永远加载不出来的图。
 *    上传由调用方先做（见 pages/join/join.ts），这里只负责落库。
 */
export function saveProfile(input: ProfileUpdate): Promise<ProfileUpdateResponse> {
  return request<ProfileUpdateResponse>('/api/user/profile', {
    method: 'POST',
    data: input,
  })
}

/**
 * ⭐⭐⭐ **注册**（`POST /api/auth/register`）—— 全站**唯一**会创建账号的调用。
 *
 * ⚠️⚠️ 它只能出现在一个地方：用户在「加入句拼」页按下「确认加入」那一下
 *    （见 components/profile-form）。**任何"顺手调一下确保有账号"的用法都是错的** ——
 *    那正是 2026-09 取消掉的「自动注册」（用户原话：注册不能做成自动的）。
 *
 * ⚠️ 它挂在公开前缀 `/api/auth/*` 下（不能挂 `/api/user/*`：那条路上的
 *    authMiddleware 会因为"还没注册"直接 403，注册请求根本到不了）。
 *    所以 http 通道要自带 token：这里先确保登录过一次（容器通道不需要）。
 *
 * ⚠️ 返回**完整的「我是谁」**（与 /me 同一个形状）—— 端侧当场 setUserId + 落 store，
 *    不必"存完再查一次"（那会把"加入成功"又赌一次网络）。
 */
export async function register(input: ProfileUpdate): Promise<MeResponse> {
  if (TRANSPORT !== 'container' && !restoreToken()) await login()
  const me = await request<MeResponse>('/api/auth/register', {
    method: 'POST',
    data: input,
    budgetMs: LAUNCH_BUDGET_MS,
  })
  // ⭐ uid 是上传路径的必需段（audio/{句子}/{uid}/…）—— 注册成功这一刻才第一次有了它
  setUserId(me.id)
  return me
}


/**
 * 提交检测。
 *
 * ⭐ 传的是**音频在对象存储里的路径**，不是音频本身 —— 请求体极小，
 *    避开云托管 callContainer 那 100KiB 的请求体上限。
 *
 * ⚠️ 服务端会校验路径里的 uid 段必须等于当前用户，所以不能改成传别的 key。
 */
/**
 * ⭐ 提交检测 —— **只受理，不等打分**。
 *
 * ⚠️⚠️ 为什么这里没有任何超时/预算参数，而上一版必须有一个 50 秒的 magic number：
 *    服务端把「受理」和「打分」拆开了（见 routes/submissions.ts）。
 *    一次讯飞评测实测 9.8 秒、长句 15 秒以上，而云托管 callContainer
 *    单次超时上限只有 15 秒 —— 一个请求根本装不下一次打分。
 *    现在 POST 在毫秒级返回 submissionId，打分在服务端后台跑，
 *    客户端用 fetchSubmissionStatus() 轮询。
 *    ⇒ 链路上**再没有任何「打分最多能跑多久」的假设**，
 *      也就没有任何需要随句子变长而上调的常数。
 *
 * ⚠️ 返回的 status 可能是 'scored'（这段音频早就打过分，幂等命中），
 *    这时 result 已经在了，不必再轮询。
 */
export function submitReading(
  articleId: string,
  audioKey: string,
  audioUrl?: string,
  /**
   * ⭐ 是否公开这次录音（「卡片之外的入口」能不能听到）—— 默认 **false**。
   * ⚠️ 提交时**不问**用户，统一按默认私密落库；结果页那个「允许公众收听」
   *    开关再改成 true（见 pages/challenge 的 onTogglePublic）。
   */
  isPublic = false,
  attemptId = '',
): Promise<SubmissionStatusResponse> {
  return request<SubmissionStatusResponse>('/api/user/submissions', {
    method: 'POST',
    // ⚠️ audioUrl 一并带上：服务端读音频本来要靠「开放接口服务」，
    //    而它在 dev 环境实测没生效 —— 给了签名地址就不必依赖它。
    //    服务端会严格校验（桶必须是我们的、对象必须等于 audioKey）。
    //    ⚠️ 服务端会把它**存进库里**：打分在后台跑，那时已经没有请求上下文了。
    /**
     * ⚠️⚠️ `attemptId` 是**幂等键**（服务端必填，见 db/schema.ts）：
     *    同一次录音重试提交时必须传**同一个值** —— 这样服务端能认出"这是刚才那一次"，
     *    返回同一个 submissionId，既不多扣能量也不重复计分。
     *    这里给它一个缺省空串只是为了让调用方显式想起它；服务端会拒绝空值（400）。
     */
    // ⚠️ **不再传 scheduleDate**（2026-09 删）：这次挑战归哪一天由服务端受理时取它的今天。
    data: { articleId, audioKey, audioUrl, isPublic, attemptId },
  })
}

/**
 * ⭐ 轮询打分状态。
 *
 * ⚠️ 用默认的 12 秒预算就够了 —— 这个请求正常情况下是**毫秒级**的
 *    （读一行记录而已）。它只在「服务端发现上次的打分进程死了、就地重跑」
 *    那一种情况下才会变慢；即便那次请求超时，下一轮轮询也能拿到结果。
 */
/**
 * ⭐ 改这段录音的可见性 —— **提交之后**才问用户（见结果页的开关）。
 *
 * ⚠️ 服务端只允许本人改（不校验归属的话，任何人都能把别人的录音设成公开）。
 */
export function setSubmissionVisibility(
  submissionId: string,
  isPublic: boolean,
): Promise<{ submissionId: string; isPublic: boolean }> {
  return request<{ submissionId: string; isPublic: boolean }>(
    '/api/user/submissions/' + submissionId + '/visibility',
    { method: 'POST', data: { isPublic } },
  )
}

export function fetchSubmissionStatus(submissionId: string): Promise<SubmissionStatusResponse> {
  return request<SubmissionStatusResponse>('/api/user/submissions/' + submissionId)
}

/**
 * ⭐ 一次挑战的**公开**结果 —— 走开放路径，不需要登录、也不校验归属。
 *
 * ⚠️ 结果页**只有这一条取数路径**（本人和访客同一份）：响应里有结果、录音地址
 *    和 owner.id；「是不是本人」由端侧拿 owner.id 跟自己的 userInfo.id 比。
 *    ⭐ 录音地址**无条件给** —— 从挑战详情分享卡片进来的都能听（链接即凭据）。
 * ⚠️ 路径不在 /api/user 下面：那条路径上全是鉴权中间件（见服务端 routes/public.ts）。
 */
export function fetchSubmissionShare(submissionId: string): Promise<ChallengeShareResponse> {
  return request<ChallengeShareResponse>('/api/challenge/' + submissionId)
}

/**
 * ⭐ **个人主页** —— 按用户 id 取一份，公开路径、不需要登录。
 *
 * ⚠️ 同一个 id 对所有人都返回同一份（包括我自己）：一页一套渲染，
 *    没有「本人 / 访客」两套数据（见服务端 routes/share.ts）。
 */
export function fetchUserProfile(userId: number): Promise<UserProfileResponse> {
  return request<UserProfileResponse>('/api/profile/' + userId)
}

/**
 * ⭐ 单取一段录音的**可播地址** —— 「我的挑战」列表里那个播放按钮。
 *
 * ⚠️ 走**开放路径**（与 /api/challenge/:sid 同一条口径）：不做用户鉴权、
 *    也不判 isPublic —— 音频的可见性由入口决定，不由这条查询决定。
 * ⚠️ 地址会过期，所以不能缓存、也不能提前批量取：每一步都按用户真正点下去
 *    那一下来。云端第一次播放可能在服务端转一次码，转好的副本会留在对象存储里。
 */
export function fetchSubmissionAudio(submissionId: string): Promise<SubmissionAudioResponse> {
  return request<SubmissionAudioResponse>('/api/challenge/' + submissionId + '/audio')
}
