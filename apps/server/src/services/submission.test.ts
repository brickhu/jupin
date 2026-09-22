import { describe, expect, it } from 'vitest'
import { MAX_INVALID_PER_DAY } from '@jushuo/shared'

import { trackInvalid } from './submission'

/**
 * ⚠️ 这些规则**全是边界**，而且每一条写错的后果都不是报错、
 *    是「用户莫名其妙提交不了」或「根本没拦住刷机」。所以逐条钉死。
 *
 * ⚠️ 这里原来还有一组 checkChallenge（免费 1 次 / 付费 50 次每天）——
 *    额度已经整体换成**能量值**（见 services/energy.ts）：
 *    余额跨天留存、必须落库，不再是「今天用了几次」这种能现算的东西。
 */

describe('trackInvalid —— 垃圾音频的当日刹车', () => {
  it('同一天累加', () => {
    expect(trackInvalid(0, '2026-09-21', '2026-09-21').count).toBe(1)
    expect(trackInvalid(1, '2026-09-21', '2026-09-21').count).toBe(2)
  })

  it('⚠️ 跨天重新计数（昨天的账不算今天头上）', () => {
    expect(trackInvalid(5, '2026-09-20', '2026-09-21').count).toBe(1)
  })

  it('第一次（从没记过）也算 1', () => {
    expect(trackInvalid(0, null, '2026-09-21').count).toBe(1)
  })

  it('到了上限就拦', () => {
    expect(trackInvalid(MAX_INVALID_PER_DAY - 1, '2026-09-21', '2026-09-21').blocked).toBe(true)
    expect(trackInvalid(0, '2026-09-21', '2026-09-21').blocked).toBe(false)
  })
})
