/**
 * ⭐⭐ **微信 access_token + 通用 API 调用** —— 全项目**唯一**的一份。
 *
 * ## ⚠️ 为什么必须只有一份
 *
 *    `access_token` 在微信侧是**全局唯一**的 ✗：⭐ 新换一个，旧的立刻作废 ✓。
 *    所以「每个模块自己缓存一份」不是省事，是**让两边互相踢** ✓ ——
 *    症状是"偶尔报 40001"，而它看起来像网络抖动 ✓。
 *
 *    ⚠️ 本模块是从 `storage/wxcloud.ts` 提出来的（2026-10-09 ✓）：
 *    虚拟支付要调 `/xpay/*`，那也需要 access_token ✓ ——
 *    与其再写一份缓存，不如把原来那份提出来共用 ✓。
 *
 * ## ⚠️ 用法上的一个约定
 *
 *    {@link callWxApi} **不往 body 里注入 `env`** ✗ ——
 *    因为两套接口要的 `env` **含义完全不同** ✓：
 *      · `/tcb/*`    ⇒ `env` = **云开发环境 ID**（字符串，如 `dev-xxx`）
 *      · `/xpay/*`   ⇒ `env` = **支付环境**（数字，0 现网 / 1 沙箱）
 *    ⚠️ 如果这里替调用方填了，两边就一定会有一个是错的 ✓
 *    ⇒ ⭐ **由调用方自己放进 body** ✓
 */
import { env } from '../env'

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'

/** 提前多久续期 —— 避免"签名时刚好过期" */
const TOKEN_SKEW_MS = 5 * 60_000

/** 微信接口统一的错误字段 */
export interface WxError {
  errcode?: number
  errmsg?: string
}

/**
 * 把错误（连同 `cause`）说清楚。
 *
 * ⚠️⚠️ Node 的 fetch 失败时**只给一个 `TypeError: fetch failed`**，
 *    真正的病因（getaddrinfo ENOTFOUND / ECONNREFUSED / 证书错误 / 连接超时）
 *    全在 `err.cause` 里。不把它带出来，线上就只剩一句
 *    「fetch failed」—— 那等于没有信息，只能靠猜。
 *    （这个坑真踩过：换了服务之后 /tcb/* 全挂，而 /health 只说 fetch failed。）
 */
export function errText(err: unknown): string {
  const e = err as Error & { cause?: unknown }
  const cause = e?.cause
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : ''
  return (e?.message ?? String(err)) + (detail ? ` ← ${detail}` : '')
}

let tokenCache: { token: string; expiresAt: number } | null = null

/** 换 access_token（带内存缓存）。force = true 时无视缓存强制刷新 */
export async function getAccessToken(force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt - Date.now() > TOKEN_SKEW_MS) {
    return tokenCache.token
  }

  const appid = env.WX_APPID
  const secret = env.WX_SECRET
  if (!appid || !secret) {
    throw new Error(
      '缺少 WX_APPID / WX_SECRET —— 微信服务端接口要用它们换 access_token。' +
        '填法：**公用**根 .env 里加这两行（两个环境共用同一个小程序），再重新部署。' +
        `（当前：appid=${appid ? '有' : '空'} secret=${secret ? '有' : '空'}）`,
    )
  }

  const url = new URL(TOKEN_URL)
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', appid)
  url.searchParams.set('secret', secret)

  const res = await fetch(url)
  const data = (await res.json()) as { access_token?: string; expires_in?: number } & WxError
  if (!data.access_token) {
    throw new Error(`换 access_token 失败：${data.errcode ?? '?'} ${data.errmsg ?? ''}`)
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  }
  return tokenCache.token
}

/** token 失效的三个错误码 —— 只在它们上面重试，别的错误重试没有意义 */
const TOKEN_ERRORS = [40001, 40003, 42001]

/**
 * 调一个微信服务端接口（**POST JSON + query 里带 access_token**）。
 *
 * ⚠️ token 失效时**强制刷新并重试一次**：access_token 是全局唯一的，
 *    别的实例刚换过就会让手上这个作废，这是常态而不是异常。
 *
 * ⚠️ 附加的 query 参数（如 `/xpay/*` 的 `pay_sig`）由调用方给 ✓
 *    —— ⚠️ 别在这里拼签名 ✗：签名的原文里**不含** access_token ✓，
 *    而它必须与 query 里的实际值逐字节一致 ✓。
 *
 * ⚠️⚠️ **`body` 可以直接传字符串**（⭐ 2026-10-09 加 ✓）——
 *    因为 `/xpay/*` 的签名原文**就是 POST body 本身** ✓
 *    （⭐ 官方 §2.5：服务器 API 的 `signData` = **api 的 post body** ✓）
 *    ⇒ ⭐ 那就**只能序列化一次**：签完必须原样发出去 ✗
 *      ⚠️ 传对象进来会让这里再 `JSON.stringify` 一次 ✗ ——
 *      键顺序/空格一变签名就对不上 ✓（⭐ 报 -15006，而报错离原因很远 ✓）
 */
export async function callWxApi<T extends WxError>(
  api: string,
  body: Record<string, unknown> | string,
  query: Record<string, string> = {},
): Promise<T> {
  // ⚠️ 字符串原样用；对象才序列化 —— 见上面那段（⭐ 签名一致性 ✓）
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt > 0)
    const url = new URL(api)
    url.searchParams.set('access_token', token)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    const data = (await res.json()) as T
    if (data.errcode === 0) return data

    lastError = `${data.errcode ?? '?'} ${data.errmsg ?? ''}`
    if (!TOKEN_ERRORS.includes(data.errcode ?? 0)) break
  }
  throw new Error(`微信接口失败（${api}）：${lastError}`)
}
