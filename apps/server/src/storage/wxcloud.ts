import COS from 'cos-nodejs-sdk-v5'
import { env } from '../env'
import type { ObjectStorage } from './types'
import { normalizeKey } from './types'

/**
 * 微信云托管对象存储实现。
 *
 * ⭐ 读取路径（官方文档给的正规做法）：
 *    ① 用「开放接口服务」拿**临时密钥**：GET http://api.weixin.qq.com/_/cos/getauth
 *       —— 容器内调用，自动带当前环境身份，**不需要任何长期密钥**。
 *    ② 用临时密钥初始化 COS-SDK（通过 getAuthorization 回调，SDK 会自动续期）。
 *    ③ cos.getObject / cos.deleteObject。
 *
 * 官方场景文档《如何处理用户上传的图片然后返回》描述的正是我们这条链路：
 * 小程序 uploadFile 拿 fileID → 服务端读 → 处理 → 返回。
 *
 * ⚠️ **前置条件：控制台要开启「开放接口服务」**。
 *    没开的话 /_/cos/getauth 会失败，错误信息见 getAuth() 的报错。
 *
 * ⚠️ 为什么不用「客户端取临时链接、服务端 fetch」那条路：
 *    它把服务端变成「按客户端给的 URL 去抓取」，是个 SSRF 面，
 *    还得额外维护域名白名单。现在这条是服务端自己去可信位置取，干净得多。
 *
 * ⚠️ 为什么不用 tcb/batchdownloadfile：
 *    那个接口要 access_token，等于多一层令牌生命周期管理；
 *    而 /_/cos/getauth 走的是开放接口服务，零令牌。
 */

const COS_AUTH_URL = 'http://api.weixin.qq.com/_/cos/getauth'

interface CosAuthResponse {
  TmpSecretId: string
  TmpSecretKey: string
  Token: string
  /** 失效时间戳（秒） */
  ExpiredTime: string
}

export class WxCloudStorage implements ObjectStorage {
  readonly name = 'wxcloud'
  private client: COS | null = null
  private creds: { auth: CosAuthResponse; startTime: number } | null = null

  /**
   * ⚠️ 刻意**不把取密钥藏在 SDK 的 getAuthorization 回调里**。
   *
   *    原因：SDK 那个 callback 的签名只接受凭据、**不接受错误**
   *    （`callback(params: Authorization | Credentials)`，不是 error-first）。
   *    把可能失败的网络调用放进去，出错就只能吞掉或让请求干等。
   *
   *    所以改成：get / remove 进来先显式 ensureAuth()，
   *    失败就在**调用点**抛出完整可读的错误；
   *    而 getAuthorization 退化成「同步把已取到的凭据交给 SDK」。
   */
  private async ensureAuth(): Promise<void> {
    // 提前 60 秒续期，避免签名时刚好过期
    const stillValid =
      this.creds !== null && Number(this.creds.auth.ExpiredTime) * 1000 - Date.now() > 60_000
    if (stillValid) return

    const auth = await getAuth()
    this.creds = { auth, startTime: Math.floor(Date.now() / 1000) }
  }

  private cos(): COS {
    if (this.client) return this.client

    if (!env.COS_BUCKET || !env.COS_REGION) {
      throw new Error(
        '缺少 COS_BUCKET / COS_REGION。' +
          '正常情况下 pnpm deploy:dev / deploy:prod 会从云托管 API 自动读出并注入，' +
          '见 tools/deploy-cloud.mjs。' +
          `（当前值：bucket=${env.COS_BUCKET || '空'} region=${env.COS_REGION || '空'}）`,
      )
    }

    this.client = new COS({
      getAuthorization: (_options, callback) => {
        const c = this.creds
        if (!c) {
          // 正常走不到：get/remove 都先 ensureAuth()。真到了这里说明 SDK 提前要签名，
          // 给个空凭据让它快速失败，而不是一直挂着。
          callback({ TmpSecretId: '', TmpSecretKey: '', StartTime: 0, ExpiredTime: 0 })
          return
        }
        callback({
          TmpSecretId: c.auth.TmpSecretId,
          TmpSecretKey: c.auth.TmpSecretKey,
          SecurityToken: c.auth.Token,
          StartTime: c.startTime,
          ExpiredTime: Number(c.auth.ExpiredTime),
        })
      },
    })
    return this.client
  }

  async get(fileID: string): Promise<Uint8Array> {
    const key = normalizeKey(fileID)
    await this.ensureAuth()
    const res = await this.cos().getObject({
      Bucket: env.COS_BUCKET as string,
      Region: env.COS_REGION as string,
      Key: key,
    })
    const body = res.Body
    if (!body) throw new Error(`对象内容为空：${key}`)
    return new Uint8Array(body as Buffer)
  }

  async remove(fileID: string): Promise<void> {
    const key = normalizeKey(fileID)
    await this.ensureAuth()
    await this.cos().deleteObject({
      Bucket: env.COS_BUCKET as string,
      Region: env.COS_REGION as string,
      Key: key,
    })
  }
}

/**
 * 取临时密钥。
 * ⚠️ 失败时把原始报错带出来 —— 最常见的原因是控制台没开「开放接口服务」，
 *    而那个错误的原始信息才说得清问题。
 */
export async function getAuth(): Promise<CosAuthResponse> {
  let res: Response
  try {
    res = await fetch(COS_AUTH_URL)
  } catch (err) {
    throw new Error(`调用开放接口服务失败（网络层）：${(err as Error).message}`)
  }
  const text = await res.text()
  if (!res.ok) {
    // ⚠️ 404 是最常见的失败，而且原因不直观，所以单独解释清楚。
    //    云托管的「开放接口服务」本质是平台在容器网络里拦截发往 api.weixin.qq.com 的请求，
    //    把 /_/ 开头的路径转到云调用代理。**开关没打开时请求会真的打到微信服务器**，
    //    而那里根本没有 /_/cos/getauth 这个路径，于是返回 404。
    const hint =
      res.status === 404
        ? '—— 几乎可以确定是「开放接口服务」没开启：' +
          '云托管控制台 → 服务管理 → 云调用 → 打开「开放接口服务」开关。' +
          '（未开启时请求会打到真实的微信服务器，而那里没有 /_/ 开头的路径）'
        : ''
    throw new Error(
      `调用开放接口服务失败：HTTP ${res.status} ${text.slice(0, 200)} ${hint}`.trim(),
    )
  }
  let info: CosAuthResponse
  try {
    info = JSON.parse(text) as CosAuthResponse
  } catch {
    throw new Error(`开放接口服务返回的不是 JSON：${text.slice(0, 200)}`)
  }
  if (!info.TmpSecretId || !info.TmpSecretKey) {
    throw new Error(
      `开放接口服务未返回临时密钥：${text.slice(0, 200)}。` +
        '最常见原因：云托管控制台未开启「开放接口服务」。',
    )
  }
  return info
}
