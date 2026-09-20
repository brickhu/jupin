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

  /**
   * ⭐ 写入对象 —— 内容侧的静态资源（标准音）靠它进对象存储。
   *
   * ⚠️ 用的是**同一份临时密钥**（/_/cos/getauth），没有额外的长期密钥要管。
   * ⚠️ 必须显式给 ContentType：对象存储不会猜，缺了它下下来的就是
   *    application/octet-stream，而 InnerAudioContext 对 MIME 是挑剔的。
   */
  async put(fileID: string, data: Uint8Array): Promise<void> {
    const key = normalizeKey(fileID)
    await this.ensureAuth()
    await this.cos().putObject({
      Bucket: env.COS_BUCKET as string,
      Region: env.COS_REGION as string,
      Key: key,
      Body: Buffer.from(data) as unknown as string,
      ContentType: contentTypeOf(key),
    })
  }

  /**
   * ⚠️ 用 headObject 而不是 getObject：只想知道「在不在」，
   *    没必要把整个文件拉下来再扔掉。
   */
  async exists(fileID: string): Promise<boolean> {
    const key = normalizeKey(fileID)
    await this.ensureAuth()
    try {
      await this.cos().headObject({
        Bucket: env.COS_BUCKET as string,
        Region: env.COS_REGION as string,
        Key: key,
      })
      return true
    } catch {
      // 权限错误也会走到这里并当成「不存在」—— 那会导致重传一次，
      // 而重传会因为同样的权限问题报出真正的错误。不会静默通过。
      return false
    }
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
 *
 * ⚠️⚠️ 失败时**必须把判定云调用链路的证据带出来**，否则只能瞎猜。
 *    官方文档给了唯一判据：走通云调用时，响应头会带 `x-openapi-seqid`。
 *      · 有 seqid   → 云调用链路是通的，问题在这个接口本身 / 权限配置
 *      · 没有 seqid → 请求**根本没走云调用**，直接打到了真实微信服务器
 *                     （真实服务器上当然没有 /_/ 开头的路径 → 404）
 *
 * ⚠️ 而「没走云调用」最常见的原因**不是开关没开**，而是官方这句原文：
 *    「实例扩缩容时**不遵循当前的开关状态，而是遵循版本创建时的开关状态**」
 *    —— 光开开关不重新构建版本是没用的。
 */
export async function getAuth(): Promise<CosAuthResponse> {
  let res: Response
  try {
    res = await fetch(COS_AUTH_URL)
  } catch (err) {
    throw new Error('调用开放接口服务失败（网络层）：' + (err as Error).message)
  }

  // ⭐ 判定依据：云调用链路走通时，平台会在响应头里加 x-openapi-seqid
  const seqid = res.headers.get('x-openapi-seqid')
  const text = await res.text()

  if (!res.ok) {
    const diagnosis = seqid
      ? ' 【诊断】响应头里【有】x-openapi-seqid —— 云调用链路是通的，问题在这个接口或「云调用-微信令牌配置」的白名单。'
      : ' 【诊断】响应头里【没有】x-openapi-seqid —— 这个请求根本没走云调用，而是打到了真实微信服务器。' +
        '按官方《开放接口服务》的四步逐条核对（前三步缺一不可）：' +
        '① 接口白名单：控制台-云调用-微信令牌权限配置里，按**路径**格式加入 /_/cos/getauth；' +
        '② 开关：控制台-云调用里「开放接口服务」为开启（且是**本环境**，本项目有 dev/prod 两个环境）；' +
        '③ 重新构建版本：官方明确「实例遵循**版本创建时**的开关状态」，开完开关必须再部署一次；' +
        '④ 镜像要有 shell —— 官方「开放接口服务依赖 shell，镜像内无 sh/bash 将无法正常部署容器」。'
    throw new Error(
      '调用开放接口服务失败：HTTP ' + res.status + ' body=' + JSON.stringify(text.slice(0, 160)) + diagnosis,
    )
  }

  let info: CosAuthResponse
  try {
    info = JSON.parse(text) as CosAuthResponse
  } catch {
    throw new Error(
      '开放接口服务返回的不是 JSON（前 160 字符）：' + JSON.stringify(text.slice(0, 160)) +
        (seqid ? ' 【已走云调用】' : ' 【未走云调用】'),
    )
  }
  return info
}
