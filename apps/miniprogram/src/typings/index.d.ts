import type { MeResponse } from '@jushuo/shared'
import type { MeState } from '../lib/store'

/**
 * 全局 App 数据类型（与 src/app.ts 的 globalData 对应）。
 *
 * ⚠️ globalData.state / userInfo 是 **store 挂上来的引用**，不是独立数据：
 *    读写状态请走 lib/store，这里只是「任何地方都能直接读」的挂载点。
 */
declare global {
  interface IAppOption {
    globalData: {
      ready: boolean
      /** lib/store 的当前 state（同一引用） */
      state: MeState | null
      /** = state.userInfo；GET /api/user/me 的原始返回体 */
      userInfo: MeResponse | null
    }
    onLaunch?: () => void
  }
}

export {}
