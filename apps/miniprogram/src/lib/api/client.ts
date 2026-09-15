import type { ApiResult, SubmitResponse } from '@jushuo/shared'

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

interface RawResponse {
  statusCode: number
  data: unknown
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
    token = ''
    wx.removeStorageSync('token')
    reject(new Error('登录已过期'))
    return
  }
  if (body && typeof body === 'object' && 'ok' in body && body.ok) {
    resolve(body.data)
  } else {
    reject(new Error((body as { error?: string })?.error ?? '请求失败'))
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
      timeout: 15000,
      success: (res) => handleResponse<T>(res as unknown as RawResponse, resolve, reject),
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  data?: unknown
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return TRANSPORT === 'container' ? containerRequest<T>(path, options) : httpRequest<T>(path, options)
}

/**
 * ⭐ 打开即登录：wx.login → openid，无注册、无密码、无验证码。
 *
 * ⚠️ cloud 模式下身份由微信网关注入，不需要 token —— 但**仍然要取一次 uid**，
 *    因为上传音频的路径里必须带 uid（服务端会校验）。
 *    （早先这里只探了个健康检查，导致拿不到 uid，见 upload.ts。）
 */
export async function login(): Promise<void> {
  if (TRANSPORT === 'container') {
    const me = await request<{ id: number }>('/api/user/me')
    setUserId(me.id)
    return
  }

  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
  const data = await request<{ token: string; user: { id: number } }>('/api/auth/login', {
    method: 'POST',
    data: { code },
  })
  setToken(data.token)
  setUserId(data.user.id)
}

/**
 * /health 的完整结构。
 * ⭐ 后端刻意把**数据库状态**也放在这里（云托管 CLI 看不到容器日志，
 *    这是唯一能自查的通道），前端自检页直接展示出来。
 */
export interface HealthResponse {
  status: string
  engine: string
  node?: string
  /** 打码后的连接串，用来核对 MYSQL_* 有没有解析对 */
  database?: string
  /** 启动时建立的连接状态 */
  db?: 'connecting' | 'ready' | 'error'
  /** ⭐ 本次请求实时探测的结果 —— db 是启动时的缓存，库后来挂了它不会变 */
  dbLive?: 'ok' | 'error' | 'timeout'
  dbError?: string
  dbAttempts?: number
  migrated?: boolean
  migrateError?: string
  existingTables?: string[]
  envError?: string
}

/** 健康检查（脚手架自检用） */
export function health(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

/**
 * 提交检测。
 *
 * ⭐ 传的是**音频在对象存储里的路径**，不是音频本身 —— 请求体极小，
 *    避开云托管 callContainer 那 100KiB 的请求体上限。
 *
 * ⚠️ 服务端会校验路径里的 uid 段必须等于当前用户，所以不能改成传别的 key。
 */
export function submitReading(articleId: number, audioKey: string): Promise<SubmitResponse> {
  return request<SubmitResponse>('/api/submissions', {
    method: 'POST',
    data: { articleId, audioKey },
  })
}
