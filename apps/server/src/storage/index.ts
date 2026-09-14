import { env } from '../env'
import { LocalStorage } from './local'
import { WxCloudStorage } from './wxcloud'
import type { ObjectStorage } from './types'

export type { ObjectStorage } from './types'
export { normalizeKey } from './types'
export { LocalStorage } from './local'

let cached: ObjectStorage | undefined

/** 对象存储工厂 —— 与引擎工厂同样的思路，业务代码不感知实现 */
export function getStorage(): ObjectStorage {
  if (cached) return cached
  cached =
    env.STORAGE === 'wxcloud'
      ? new WxCloudStorage({ envId: process.env.WX_CLOUD_ENV_ID ?? '' })
      : new LocalStorage()
  console.log(`[storage] 使用 ${cached.name} 实现`)
  return cached
}
