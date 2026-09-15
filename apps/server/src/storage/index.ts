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
