import { env } from '../env'
import type { ObjectStorage } from './types'
import { normalizeKey } from './types'

/**
 * 微信云托管对象存储实现 —— 走**经典 HTTPS 接口**（/tcb/*）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 为什么**不是** /_/cos/getauth + COS-SDK（官方「开放接口服务」那条路）
 *
 *    那条路要求容器里**旁加载一个进程**，请求才会被就地接走。
 *    没接走时，发往 api.weixin.qq.com 的请求会直接出公网打真实微信服务器，
 *    而真实服务器上根本没有 /_/ 开头的路径 → 404。
 *    本项目在 dev 实测就是这种状态（容器内 /_/cos/getauth 返回 301 跳 https、
 *    响应头没有 x-openapi-seqid），而且**平台侧没有任何 API 能查这个开关的状态**
 *    （CLI 只包了 21 个 tcb 接口，控制台那两个开关读不到）。
 *
 *    ⇒ 改用官方另外三个接口：/tcb/uploadfile、/tcb/batchdownloadfile、
 *      /tcb/batchdeletefile。官方在这三个接口的文档里都明写
 *      「**本接口不支持云调用**」—— 也就是说它们**本来就不走旁加载**，
 *      只需要一个 access_token。要什么走什么，比去赌一个查不到状态的开关稳。
 * ══════════════════════════════════════════════════════════════════
 *
 * 凭据链：WX_APPID + WX_SECRET → access_token（两小时有效）→ /tcb/*
 *
 * ⚠️ access_token 是**进程级缓存**。多实例部署时每个实例各持一份，而微信侧
 *    同一个 appid 的 token 全局唯一（新取的会让旧的失效），所以每个调用都必须
 *    「报 40001/40003/42001 就刷新一次再重试」，不能假设手上的 token 一直有效。
 */

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const UPLOAD_URL = 'https://api.weixin.qq.com/tcb/uploadfile'
const DOWNLOAD_URL = 'https://api.weixin.qq.com/tcb/batchdownloadfile'
const DELETE_URL = 'https://api.weixin.qq.com/tcb/batchdeletefile'

/** 提前多久续期 —— 避免"签名时刚好过期" */
const TOKEN_SKEW_MS = 5 * 60_000
/** 临时下载链接有效期（秒）。只用来立刻把内容取回来，取完就丢，所以给短的 */
const DOWNLOAD_MAX_AGE_SEC = 600

/** 微信接口统一的错误字段 */
interface WxError {
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
function errText(err: unknown): string {
  const e = err as Error & { cause?: unknown }
  const cause = e?.cause
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : ''
  return (e?.message ?? String(err)) + (detail ? ` ← ${detail}` : '')
}

/** token 失效的三个错误码 —— 只在它们上面重试，别的错误重试没有意义 */
const TOKEN_ERRORS = [40001, 40003, 42001]

/**
 * 按扩展名给 MIME。
 * ⚠️ 不做成通用表：只覆盖我们真的会写的两种。写错 MIME 的症状是
 *    「音频下下来了但播不出声」，而它看起来像音频文件本身的问题。
 */
function contentTypeOf(key: string): string {
  if (key.endsWith('.mp3')) return 'audio/mpeg'
  if (key.endsWith('.pcm')) return 'application/octet-stream'
  return 'application/octet-stream'
}

let tokenCache: { token: string; expiresAt: number } | null = null

/** 换 access_token（带内存缓存）。force = true 时无视缓存强制刷新 */
async function accessToken(force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt - Date.now() > TOKEN_SKEW_MS) {
    return tokenCache.token
  }

  const appid = env.WX_APPID
  const secret = env.WX_SECRET
  if (!appid || !secret) {
    throw new Error(
      '缺少 WX_APPID / WX_SECRET —— /tcb/* 这套接口要用它们换 access_token。' +
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

/**
 * 调一个 /tcb/* 接口。
 * ⚠️ token 失效时**强制刷新并重试一次**：access_token 是全局唯一的，
 *    别的实例刚换过就会让手上这个作废，这是常态而不是异常。
 */
async function callTcb<T extends WxError>(api: string, body: Record<string, unknown>): Promise<T> {
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(attempt > 0)
    const res = await fetch(`${api}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: env.WX_CLOUD_ENV_ID, ...body }),
    })
    const data = (await res.json()) as T
    if (data.errcode === 0) return data

    lastError = `${data.errcode ?? '?'} ${data.errmsg ?? ''}`
    if (attempt === 0 && TOKEN_ERRORS.includes(Number(data.errcode))) {
      console.warn(`[storage] access_token 失效（${lastError}），刷新后重试`)
      continue
    }
    break
  }
  throw new Error(`调用 ${api.split('/').pop()} 失败：${lastError}`)
}

/** /tcb/uploadfile 的返回 */
interface UploadTicket extends WxError {
  url?: string
  token?: string
  authorization?: string
  file_id?: string
  cos_file_id?: string
}

/** 下载列表里的一项 */
interface DownloadFileItem {
  fileid?: string
  download_url?: string
  errmsg?: string
  code?: string
}

/** /tcb/batchdownloadfile 的返回 */
interface DownloadResult extends WxError {
  file_list?: DownloadFileItem[]
}

/** key → cloud://<环境>.<桶>/<key> */
function fileIdOf(key: string): string {
  if (!env.WX_CLOUD_ENV_ID || !env.COS_BUCKET) {
    throw new Error(
      '缺少 WX_CLOUD_ENV_ID / COS_BUCKET，拼不出 fileID。' +
        '正常情况下 pnpm deploy:dev / deploy:prod 会从云托管 API 自动读出并注入，' +
        '见 tools/deploy-cloud.mjs。' +
        `（当前值：env=${env.WX_CLOUD_ENV_ID || '空'} bucket=${env.COS_BUCKET || '空'}）`,
    )
  }
  return `cloud://${env.WX_CLOUD_ENV_ID}.${env.COS_BUCKET}/${key}`
}

/**
 * 换某个 key 的临时下载链接（**不下载**）。
 * ⚠️ 提到模块级而不是做成私有方法：深度自检也要用它，
 *    而"为了探测去调私有方法"只能靠 as unknown as 强转 —— 那种代码迟早骗到自己。
 */
async function fetchDownloadItem(key: string): Promise<DownloadFileItem | undefined> {
  const res = await callTcb<DownloadResult>(DOWNLOAD_URL, {
    file_list: [{ fileid: fileIdOf(key), max_age: DOWNLOAD_MAX_AGE_SEC }],
  })
  return res.file_list?.[0]
}

export class WxCloudStorage implements ObjectStorage {
  readonly name = 'wxcloud'

  /**
   * ⭐ 写入对象 —— 内容侧的静态资源（标准音）靠它进对象存储。
   *
   * 两步：① /tcb/uploadfile 换上传票据 ② 拿票据把字节 POST 给 COS。
   *
   * ⚠️⚠️ 第二步那五个表单字段**一个都不能少、file 必须最后**：
   *    这是 COS 的 POST Object 协议 + 云开发的元数据约定。
   *    尤其 x-cos-meta-fileid —— 漏了的话文件确实传上去了，
   *    但**小程序端读不到**（官方文档专门警告过这一条），
   *    而症状是「后台能看到文件、客户端 404」，极难查。
   */
  async put(fileID: string, data: Uint8Array): Promise<void> {
    const key = normalizeKey(fileID)
    const ticket = await callTcb<UploadTicket>(UPLOAD_URL, { path: key })
    if (!ticket.url || !ticket.token || !ticket.authorization || !ticket.cos_file_id) {
      throw new Error(`上传票据不完整（${key}）：${JSON.stringify(ticket).slice(0, 200)}`)
    }

    const form = new FormData()
    form.append('Signature', ticket.authorization)
    form.append('x-cos-security-token', ticket.token)
    form.append('x-cos-meta-fileid', ticket.cos_file_id)
    form.append('key', key)
    form.append('file', new Blob([data], { type: contentTypeOf(key) }), key.split('/').pop() ?? 'file')

    const up = await fetch(ticket.url, { method: 'POST', body: form })
    // COS 成功时返回 204 无内容，所以只看状态码
    if (!up.ok) {
      throw new Error(`上传 ${key} 失败：HTTP ${up.status} ${(await up.text()).slice(0, 200)}`)
    }
  }

  /** 取回对象内容（先换临时下载链接，再拉字节） */
  async get(fileID: string): Promise<Uint8Array> {
    const key = normalizeKey(fileID)
    const item = await fetchDownloadItem(key)
    if (!item?.download_url) {
      throw new Error(`取下载链接失败：${key}（${item?.errmsg ?? item?.code ?? '没有 download_url'}）`)
    }
    const res = await fetch(item.download_url)
    if (!res.ok) throw new Error(`下载 ${key} 失败：HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * ⚠️ 只换链接、**不下载**：判断"在不在"没必要把整个文件拉下来。
   * ⚠️ 出错一律当"不存在"：权限问题也会走到这里，而那时重传会因为同样的权限
   *    问题报出真正的错误 —— 不会静默通过。
   */
  async exists(fileID: string): Promise<boolean> {
    try {
      const item = await fetchDownloadItem(normalizeKey(fileID))
      return Boolean(item?.download_url)
    } catch {
      return false
    }
  }

  async remove(fileID: string): Promise<void> {
    const key = normalizeKey(fileID)
    await callTcb<WxError & { delete_list?: unknown }>(DELETE_URL, {
      fileid_list: [fileIdOf(key)],
    })
  }
}

/**
 * 深度自检 —— 把这条链路真跑一遍，并把每一步的结果原样带出来。
 *
 * ⚠️ 探针**不真的写**：只换上传票据（拿到就说明鉴权、环境、权限都对），
 *    不往桶里丢垃圾对象。
 * ⚠️ 另外拿一个**不存在的 key** 去换下载链接：期望「拿不到链接」。
 *    拿不到恰恰证明「鉴权通过 + 环境对」—— 要真是签名错 / 环境不存在，
 *    报出来的是另一类错误。这和本地实现里"用不存在的 key 探测"是同一个思路。
 */
export async function probeWxStorage(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}

  // ⭐ 旁加载给的根证书在不在、有没有被 Node 认下来 —— 这两条决定 HTTPS 能不能通
  try {
    const { existsSync } = await import('node:fs')
    out.caFile = existsSync('/app/cert/certificate.crt') ? '存在' : '不存在'
  } catch {
    out.caFile = '检查失败'
  }
  out.caEnv = process.env.NODE_EXTRA_CA_CERTS ?? '(未设置)'

  // ⭐ 先量最底层的两件事：公网域名能不能解析、能不能连出去。
  //    换服务之后 /tcb/* 全挂过，就是靠这一条定位到「这个实例没有公网出口」。
  try {
    const { lookup } = await import('node:dns/promises')
    const { address } = await lookup('api.weixin.qq.com')
    out.dns = address + (/^(10\.|169\.254\.)/.test(address) ? '（内网地址 → 旁加载在）' : '（公网地址）')
  } catch (err) {
    out.dns = 'failed: ' + errText(err).slice(0, 200)
  }

  try {
    await accessToken()
    out.token = 'ok'
  } catch (err) {
    out.token = `failed: ${errText(err).slice(0, 300)}`
    return out
  }

  try {
    const ticket = await callTcb<UploadTicket>(UPLOAD_URL, { path: '__probe__/never-uploaded.bin' })
    out.uploadTicket = ticket.url ? 'ok（拿到上传票据，未真正上传）' : `异常返回：${JSON.stringify(ticket).slice(0, 200)}`
  } catch (err) {
    out.uploadTicket = `failed: ${errText(err).slice(0, 300)}`
  }

  try {
    const item = await fetchDownloadItem('__probe__/never-exists.bin')
    out.downloadProbe = item?.download_url
      ? `异常：不存在的对象竟然拿到了链接（说明桶或环境配错了）`
      : `ok（不存在的对象没拿到链接 → 鉴权与环境都对）`
    out.downloadProbeRaw = JSON.stringify(item ?? null).slice(0, 200)
  } catch (err) {
    out.downloadProbe = `failed: ${errText(err).slice(0, 300)}`
  }

  return out
}
