import type { ApiResult, SubmitResponse } from '@jushuo/shared'

/**
 * 后端基址。
 * ⚠️ 真机预览时 localhost 指向手机自己，必须用**宿主机局域网 IP**，
 *    并在开发者工具勾选「不校验合法域名」。
 */
const BASE_URL = 'http://192.168.1.5:3000'

let token = ''

export function setToken(t: string): void {
  token = t
  wx.setStorageSync('token', t)
}

function restoreToken(): string {
  if (!token) token = (wx.getStorageSync('token') as string) || ''
  return token
}

export async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; data?: unknown } = {},
): Promise<T> {
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
      success: (res) => {
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
      },
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}

/** ⭐ 打开即登录：wx.login → openid，无注册无密码无验证码 */
export async function login(): Promise<void> {
  const code = await new Promise<string>((resolve, reject) => {
    wx.login({
      success: (res) => resolve(res.code),
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
  const data = await request<{ token: string }>('/api/auth/login', {
    method: 'POST',
    data: { code },
  })
  setToken(data.token)
}

/** 健康检查（脚手架自检用） */
export function health(): Promise<{ status: string; engine: string }> {
  return request<{ status: string; engine: string }>('/health')
}

/**
 * 提交检测。
 *
 * ⭐ 传的是 fileID 而不是音频本身 —— 音频已由 uploadAudio 直传对象存储。
 *    这样请求体极小，避开云托管服务的大小限制（大请求会报 413）。
 */
export function submitReading(arenaId: number, fileID: string): Promise<SubmitResponse> {
  return request<SubmitResponse>('/api/submissions', {
    method: 'POST',
    data: { arenaId, fileID },
  })
}
