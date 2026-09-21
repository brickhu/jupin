import { env } from '../env'
import { LocalStorage } from './local'
import { probeWxStorage, WxCloudStorage } from './wxcloud'
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
 * 深度自检：把「换 access_token → 换上传票据 → 换下载链接」整条链路真跑一遍。
 *
 * ⭐ 为什么值得单独做：这条链路跨三个外部系统（微信 access_token、云开发 /tcb/*、
 *    腾讯云 COS），任何一个环节没配对，都只会在「用户提交音频」或「灌标准音」
 *    那一刻才暴露，而那两处的报错信息离根因很远。
 *
 * ⚠️ 它**不真的写**（不往桶里丢垃圾对象），细节见 wxcloud.ts 的 probeWxStorage。
 */
export async function probeStorage(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    impl: env.STORAGE,
    bucket: env.COS_BUCKET ?? null,
    region: env.COS_REGION ?? null,
    envId: env.WX_CLOUD_ENV_ID ?? null,
    appidConfigured: Boolean(env.WX_APPID),
    secretConfigured: Boolean(env.WX_SECRET),
  }

  if (env.STORAGE !== 'wxcloud') {
    out.note = '当前不是 wxcloud 实现，无需探测外部链路'
    return out
  }

  Object.assign(out, await probeWxStorage())
  return out
}
