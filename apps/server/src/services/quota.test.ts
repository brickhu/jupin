import { describe, expect, it } from 'vitest'
import { FREE_DAILY_CHALLENGES, MAX_INVALID_PER_DAY, MEMBER_DAILY_CHALLENGES } from '@jushuo/shared'

import { checkChallenge, dailyLimitOf, trackInvalid } from './quota'

/**
 * ⚠️ 这些规则**全是边界**，而且每一条写错的后果都不是报错、
 *    是"用户莫名其妙提交不了"或"根本没拦住刷机"。所以逐条钉死。
 */

describe('checkChallenge —— 每日挑战次数（与句子无关）', () => {
  it('免费用户：今天还没挑战过 → 放行，上限 1', () => {
    const g = checkChallenge({ usedToday: 0, isMember: false })
    expect(g.allowed).toBe(true)
    expect(g.dailyLimit).toBe(FREE_DAILY_CHALLENGES)
  })

  it('⭐ 免费用户今天挑战过 1 次 → 拒绝，reason=free（付费可以继续）', () => {
    const g = checkChallenge({ usedToday: 1, isMember: false })
    expect(g.allowed).toBe(false)
    expect(g.code).toBe('QUOTA_EXHAUSTED')
    expect(g.reason).toBe('free')
    expect(g.dailyLimit).toBe(1)
    expect(g.usedToday).toBe(1)
  })

  it('付费用户：第 1–49 次放行，第 50 次开始拒绝（硬上限，不是无限）', () => {
    expect(checkChallenge({ usedToday: MEMBER_DAILY_CHALLENGES - 1, isMember: true }).allowed).toBe(true)
    const last = checkChallenge({ usedToday: MEMBER_DAILY_CHALLENGES, isMember: true })
    expect(last.allowed).toBe(false)
    expect(last.code).toBe('QUOTA_EXHAUSTED')
    expect(last.reason).toBe('cap')
    expect(last.dailyLimit).toBe(MEMBER_DAILY_CHALLENGES)
  })

  it('⚠️ 超过上限（并发 / 脏数据）也是拒绝，不会漏成放行', () => {
    expect(checkChallenge({ usedToday: MEMBER_DAILY_CHALLENGES + 5, isMember: true }).allowed).toBe(false)
    expect(checkChallenge({ usedToday: 99, isMember: false }).allowed).toBe(false)
  })

  it('dailyLimitOf：免费 1 / 付费 50', () => {
    expect(dailyLimitOf(false)).toBe(FREE_DAILY_CHALLENGES)
    expect(dailyLimitOf(true)).toBe(MEMBER_DAILY_CHALLENGES)
  })
})

describe('trackInvalid —— 垃圾音频的当日刹车', () => {
  it('同一天累加', () => {
    expect(trackInvalid(0, '2026-09-21', '2026-09-21').count).toBe(1)
    expect(trackInvalid(1, '2026-09-21', '2026-09-21').count).toBe(2)
  })

  it('⚠️ 跨天重新计数（昨天的账不算今天头上）', () => {
    expect(trackInvalid(5, '2026-09-20', '2026-09-21').count).toBe(1)
  })

  it('到了上限就拦', () => {
    expect(trackInvalid(MAX_INVALID_PER_DAY - 1, '2026-09-21', '2026-09-21').blocked).toBe(true)
    expect(trackInvalid(0, '2026-09-21', '2026-09-21').blocked).toBe(false)
  })
})
