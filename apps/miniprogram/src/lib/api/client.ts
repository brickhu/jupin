import type {
  ApiResult,
  ChallengesResponse,
  EnergyResponse,
  MeResponse,
  ParticipationsResponse,
  ScheduleDetail,
  ChallengeShareResponse,
  SchedulesResponse,
  ShopGoodsResponse,
  ShopOrderResponse,
  StreakRecordResponse,
  StreakView,
  SubmissionAudioResponse,
  SubmissionStatusResponse,
} from '@jushuo/shared'

import { BASE_URL, CLOUD_ENV_ID, CLOUD_SERVICE, TRANSPORT } from '../../config'

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
  constructor() {
    super('登录已过期')
    this.name = 'AuthExpiredError'
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
 * ⚠️ 只给启动用：会话中（已经在读句子、在提交）再等 25 秒没有意义，
 *    那时候失败得越快越好 —— 所以那些请求仍然走默认的 12 秒。
 */
const LAUNCH_BUDGET_MS = 25_000

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
    reject(new AuthExpiredError())
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
function httpRequest<T>(path: string, options: RequestOptions): Promise<T> {
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
      reject(
        new Error(
          '当前环境没有 wx.cloud.callContainer：基础库 ' +
            (wx.getAppBaseInfo?.().SDKVersion ?? '未知') +
            ' 可能低于 2.23.0，或 wx.cloud.init() 失败。' +
            '可用「预览」而不是旧版「真机调试」再试。',
        ),
      )
      return
    }
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
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}

interface RequestOptions {
  method?: 'GET' | 'POST'
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
    throw err
  }
}

/**
 * ⭐ 重新登录 —— 并发请求共用**同一个** Promise。
 *
 * ⚠️ 页面首屏常常同时发好几个请求，它们会一起 401。
 *    不做合并的话就会同时打 N 次 wx.login + N 次登录接口，
 *    而其中只有最后一次签发的 token 有效 —— 前面几次都白发。
 */
let relogging: Promise<void> | null = null

function relogin(): Promise<void> {
  if (!relogging) {
    relogging = login().finally(() => {
      // ⚠️ 稍后才允许下一次：立刻放开会和「刚签发就被别处判定失效」打架
      setTimeout(() => {
        relogging = null
      }, 2_000)
    })
  }
  return relogging
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

    try {
      const attemptOptions: RequestOptions = { ...options, timeout: remaining }
      return await (TRANSPORT === 'container'
        ? containerRequest<T>(path, attemptOptions)
        : httpRequest<T>(path, attemptOptions))
    } catch (err) {
      const e = err as Error
      // ⚠️ AuthExpiredError 刻意**不在这里重试** —— 它是 request() 那一层的事，
      //    在那里重试之前会先重新登录。在这里当成普通传输失败重试，
      //    只会在同一个失效 token 上白撞三次。
      if (e instanceof AuthExpiredError) throw e
      const retryable =
        e instanceof RetryableError || e instanceof StillScoringError || isTransportFailure(e)
      if (!retryable || lastAttempt) {
        if (retryable && lastAttempt) {
          // ⚠️ 「重试到预算用尽」有两种完全不同的原因，**不能给同一句话**：
          //    ① 冷启动：请求根本没打到服务（服务端没有任何记录）
          //    ② 打分未完成：服务端正在跑评测，只是还没跑完
          //    把它们都说成「服务正在启动中」会让用户以为服务挂了、去重开小程序，
          //    而这恰恰是唯一不该做的动作（重开也不会更快）。
          const scoring = e instanceof StillScoringError
          throw new ApiError(
            scoring
              ? '打分还在进行中（长句要十几秒），再点一次「提交检测」即可拿到结果 —— 不会重复计费'
              : '服务正在启动中（云托管冷启动要十几秒），请再试一次',
            scoring ? 'SCORING' : 'COLD_START',
            { attempts: RETRY_DELAYS_MS.length, lastError: e.message },
          )
        }
        throw err
      }
      lastErr = e
      console.warn(`[api] ${path} 第 ${attempt + 1} 次失败，将重试：${e.message}`)
    }
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

export async function login(): Promise<void> {
  if (TRANSPORT === 'container') {
    // ⚠️⚠️ 这里**必须**带 noRelogin。
    //    容器通道下身份由微信网关注入，login() 就是「取一次自己是谁」，
    //    所以它本身就是一个会被 401 的请求。不禁止重登的话：
    //      request(/api/user/me) 401 → relogin() → login() → request(/api/user/me) → …
    //    而 relogin() 会复用同一个 Promise，第二次等的是**自己** —— 死锁，不是报错。
    // ⭐ 启动请求：给冷启动留够时间（见 LAUNCH_BUDGET_MS）
    const me = await request<{ id: number }>('/api/user/me', {
      noRelogin: true,
      budgetMs: LAUNCH_BUDGET_MS,
    })
    setUserId(me.id)
    return
  }

  const code = await wxLoginCode()
  const data = await request<{ token: string; user: { id: number } }>('/api/auth/login', {
    method: 'POST',
    data: { code },
    // ⚠️ 必须带：不然登录失败会递归地再触发一次登录，直到栈溢出
    noRelogin: true,
    // ⭐ 启动请求：给冷启动留够时间（见 LAUNCH_BUDGET_MS）
    budgetMs: LAUNCH_BUDGET_MS,
  })
  setToken(data.token)
  setUserId(data.user.id)
}

/**
 * ⭐ 每日挑战列表 —— 首页**只需要这一个请求**。
 *
 * 今日挑战、历史挑战、streak 都在同一个响应里：
 * 做减法之后首页就是这一页列表，拆成多个请求只会让首屏出现几段先后到达的空白。
 *
 * @param days 含今天一共列几天（服务端会夹到 2–30）
 */
export function fetchSchedules(days = 7): Promise<SchedulesResponse> {
  // ⭐ 首页的第一个请求 —— 冷启动就撞在它身上，给足预算（见 LAUNCH_BUDGET_MS）
  return request<SchedulesResponse>('/api/schedules?days=' + days, { budgetMs: LAUNCH_BUDGET_MS })
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
  return request<ShopGoodsResponse>('/api/shop/goods', { budgetMs: LAUNCH_BUDGET_MS })
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
  return request<ShopOrderResponse>('/api/shop/order', {
    method: 'POST',
    data: { goodsCode, code },
    budgetMs: LAUNCH_BUDGET_MS,
  })
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
export function saveProfile(input: {
  nickname: string
  avatarUrl?: string
}): Promise<{ nickname: string; avatarUrl: string | null }> {
  return request<{ nickname: string; avatarUrl: string | null }>('/api/user/profile', {
    method: 'POST',
    data: input,
  })
}

/**
 * ⭐ 单个挑战的详情（完整榜单 + 我的名次）。
 * @param date 'YYYY-MM-DD' —— 由调用页面**原样带过来**，不要在客户端重算「今天」
 */
export function fetchScheduleDetail(date: string): Promise<ScheduleDetail> {
  return request<ScheduleDetail>('/api/schedules/' + date)
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
  articleId: number,
  audioKey: string,
  /**
   * ⭐ 这次挑战的日期（'YYYY-MM-DD'）。
   * ⚠️ 必须由页面把**当初点进来的那一天**原样回传：
   *    历史挑战的「再次挑战」要归到那一天，不能算到今天头上 ——
   *    否则昨天那张卡片的参与人数和最高分会莫名其妙地变。
   */
  scheduleDate: string,
  audioUrl?: string,
  /** ⭐ 是否公开这次录音（别人能不能听到）—— 默认公开 */
  isPublic = true,
): Promise<SubmissionStatusResponse> {
  return request<SubmissionStatusResponse>('/api/submissions', {
    method: 'POST',
    // ⚠️ audioUrl 一并带上：服务端读音频本来要靠「开放接口服务」，
    //    而它在 dev 环境实测没生效 —— 给了签名地址就不必依赖它。
    //    服务端会严格校验（桶必须是我们的、对象必须等于 audioKey）。
    //    ⚠️ 服务端会把它**存进库里**：打分在后台跑，那时已经没有请求上下文了。
    data: { articleId, audioKey, audioUrl, isPublic, scheduleDate },
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
    '/api/submissions/' + submissionId + '/visibility',
    { method: 'POST', data: { isPublic } },
  )
}

export function fetchSubmissionStatus(submissionId: string): Promise<SubmissionStatusResponse> {
  return request<SubmissionStatusResponse>('/api/submissions/' + submissionId)
}

/**
 * ⭐ 别人**分享出来的**那次挑战 —— 走公开路径，不需要登录、也不校验归属。
 *
 * ⚠️ 结果页两个视角共用一套渲染：本人走上面那个（服务端会校验归属），
 *    不是本人（或没登录）时落到这里 —— 服务端只给公开信息，
 *    录音地址也只在这条提交是公开的时候才给。
 * ⚠️ 路径不在 /api 下面：那条路径上全是鉴权中间件（见服务端 routes/share.ts）。
 */
export function fetchSubmissionShare(submissionId: string): Promise<ChallengeShareResponse> {
  return request<ChallengeShareResponse>('/share/challenge/' + submissionId)
}

/**
 * ⭐ 拿这段录音的**可播地址** —— 「我的挑战」列表里那个播放按钮。
 *
 * ⚠️ 地址是**单独授权、会过期**的，所以不能缓存、也不能提前批量取：
 *    每一步都按用户真正点下去那一下来（理由见服务端那条路由）。
 * ⚠️ 云端那条路第一次播放可能在服务端转一次码，给它正常预算就够了；
 *    转好的副本会留在对象存储里，之后就只是一次元数据查询。
 */
export function fetchSubmissionAudio(submissionId: string): Promise<SubmissionAudioResponse> {
  return request<SubmissionAudioResponse>('/api/submissions/' + submissionId + '/audio')
}
