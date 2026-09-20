import { env } from '../env'
import { LocalStorage } from './local'
import { WxCloudStorage, getAuth } from './wxcloud'
import type { ObjectStorage } from './types'

export type { ObjectStorage } from './types'
export { normalizeKey } from './types'
export { LocalStorage } from './local'

let cached: ObjectStorage | undefined

/** 对象存储工厂 —— 与引擎工厂同样的思路，业务代码不感知实现 */
export function getStorage(): ObjectStorage {
  if (cached) return cached
  cached = env.STORAGE === 'wxcloud' ? new WxCloudStorage() : new LocalStorage()
  console.log(`[storage] 使用 ${cached.name} 实现`)
  return cached
}

/**
 * 深度自检：把「取临时密钥 → 用密钥读对象存储」整条链路真跑一遍。
 *
 * ⭐ 为什么值得单独做：这条链路跨越微信开放接口服务和腾讯云 COS 两个外部系统，
 *    任何一个环节没配对（最常见的是控制台没开「开放接口服务」、桶名/地域写错），
 *    在真正提交音频之前都发现不了。
 *
 * ⚠️ 用**不存在的 key** 去读：期望拿到 `NoSuchKey`。
 *    那个错误恰恰证明「鉴权通过 + 桶存在 + 地域正确」——
 *    如果返回的是签名错误或桶不存在，问题就定位到别处了。
 */
export async function probeStorage(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    impl: env.STORAGE,
    bucket: env.COS_BUCKET ?? null,
    region: env.COS_REGION ?? null,
  }

  // ⭐⭐ 官方给出的**第二个**判定依据：
  //    「通过请求头返回 x-openapi-seqid 和**解析地址为内部地址（10.0.0.x / 169.254.0.x）**
  //      判断是否使用了开放接口服务。」
  //    「开放接口服务以旁加载形式部署到服务中」—— 所以它的存在与否，
  //    直接反映在 api.weixin.qq.com 解析到什么地址上。
  //    ⚠️ 这一条比只看 seqid 更有信息量：它能区分
  //       「sidecar 根本不在」和「sidecar 在但请求没匹配上」。
  try {
    const { lookup } = await import('node:dns/promises')
    const { address } = await lookup('api.weixin.qq.com')
    out.openapiDns = address
    out.openapiActive = /^(10\.|169\.254\.)/.test(address)
    out.openapiNote = out.openapiActive
      ? '解析到内部地址 → 开放接口服务已旁加载'
      : '解析到公网地址 → 开放接口服务**没有**部署到这个实例（开关未生效或版本是开关打开前构建的）'
  } catch (err) {
    out.openapiDnsError = (err as Error).message
  }
  if (env.STORAGE !== 'wxcloud') {
    out.note = '当前不是 wxcloud 实现，无需探测外部链路'
    return out
  }

  if (!env.COS_BUCKET || !env.COS_REGION) {
    out.error = '缺少 COS_BUCKET / COS_REGION'
    return out
  }

  try {
    const auth = await getAuth()
    out.auth = 'ok'
    out.authExpiresInSec = Number(auth.ExpiredTime) - Math.floor(Date.now() / 1000)
  } catch (err) {
    out.auth = 'failed'
    out.authError = (err as Error).message
    return out
  }

  try {
    await getStorage().get('cloud://probe.invalid/__jushuo_probe__.bin')
    out.read = 'unexpected-success（不该读到不存在的对象）'
  } catch (err) {
    const msg = (err as Error).message
    out.read = /NoSuchKey|NotFound|404/i.test(msg)
      ? 'ok（NoSuchKey —— 说明鉴权、桶、地域全部正确）'
      : `failed: ${msg.slice(0, 200)}`
  }
  return out
}
