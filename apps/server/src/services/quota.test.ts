import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_INTERVAL_MS,
  FREE_ATTEMPTS_PER_SENTENCE,
  MEMBER_ATTEMPTS_PER_SENTENCE,
} from '@jushuo/shared'

import { attemptLimitOf, checkChallenge, trackInvalid } from './quota'

/**
 * ⚠️ 这些规则**全是边界**，而且每一条写错的后果都不是报错、是"用户莫名其妙提交不了"
 *    或"根本没拦住刷机"。所以逐条钉死。
 */
const NOW = new Date('2026-09-21T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('checkChallenge —— 每句额度', () => {
  it('免费用户：这一句没读过 → 放行', () => {
    const g = checkChallenge({ attempts: 0, isMember: false, lastSubmitAt: null, now: NOW })
    expect(g.allowed).toBe(true)
    expect(g.limit).toBe(FREE_ATTEMPTS_PER_SENTENCE)
  })

  it('⭐ 免费用户读过一次 → 额度用完，reason=free（付费可以继续）', () => {
    const g = checkChallenge({ attempts: 1, isMember: false, lastSubmitAt: null, now: NOW })
    expect(g.allowed).toBe(false)
    expect(g.code).toBe('QUOTA_EXHAUSTED')
    expect(g.reason).toBe('free')
    expect(g.limit).toBe(1)
  })

  it('付费用户：第 1–19 次放行，第 20 次开始拒绝（硬上限，不是无限）', () => {
    const at = (attempts: number) =>
      checkChallenge({ attempts, isMember: true, lastSubmitAt: null, now: NOW })
    expect(at(MEMBER_ATTEMPTS_PER_SENTENCE - 1).allowed).toBe(true)
    const last = at(MEMBER_ATTEMPTS_PER_SENTENCE)
    expect(last.allowed).toBe(false)
    expect(last.code).toBe('QUOTA_EXHAUSTED')
    expect(last.reason).toBe('cap')
    expect(last.limit).toBe(MEMBER_ATTEMPTS_PER_SENTENCE)
  })

  it('⚠️ 次数比上限还多（脏数据 / 上限被调小）也要拦，不能只判等号', () => {
    const g = checkChallenge({ attempts: 999, isMember: true, lastSubmitAt: null, now: NOW })
    expect(g.allowed).toBe(false)
  })

  it('⚠️ 付费身份过期（isMember=false）立刻退回免费额度 —— 上限跟着身份走', () => {
    expect(attemptLimitOf(true)).toBe(MEMBER_ATTEMPTS_PER_SENTENCE)
    expect(attemptLimitOf(false)).toBe(FREE_ATTEMPTS_PER_SENTENCE)
    const g = checkChallenge({ attempts: 1, isMember: false, lastSubmitAt: null, now: NOW })
    expect(g.allowed).toBe(false)
  })
})

describe('checkChallenge —— 挑战间隔（防刷机）', () => {
  it('刚提交过 1 秒 → 太频繁，并给出还要等多少秒', () => {
    const g = checkChallenge({ attempts: 0, isMember: true, lastSubmitAt: ago(1_000), now: NOW })
    expect(g.allowed).toBe(false)
    expect(g.code).toBe('TOO_FREQUENT')
    expect(g.retryAfterSec).toBe(Math.ceil((CHALLENGE_INTERVAL_MS - 1_000) / 1000))
  })

  it('⭐ 间隔这一条**对所有人都生效**，付费用户也不例外（付费买的是次数，不是速度）', () => {
    const g = checkChallenge({ attempts: 0, isMember: true, lastSubmitAt: ago(5_000), now: NOW })
    expect(g.allowed).toBe(false)
    expect(g.code).toBe('TOO_FREQUENT')
  })

  it('刚好卡在间隔上 → 放行（边界是闭区间，否则会白等一轮）', () => {
    const g = checkChallenge({
      attempts: 0,
      isMember: false,
      lastSubmitAt: ago(CHALLENGE_INTERVAL_MS),
      now: NOW,
    })
    expect(g.allowed).toBe(true)
  })

  it('超过间隔 → 放行', () => {
    const g = checkChallenge({
      attempts: 0,
      isMember: false,
      lastSubmitAt: ago(CHALLENGE_INTERVAL_MS + 1),
      now: NOW,
    })
    expect(g.allowed).toBe(true)
  })

  it('⚠️ 剩余秒数至少是 1 —— 说「0 秒后再试」等于让他立刻再撞一次', () => {
    const g = checkChallenge({
      attempts: 0,
      isMember: false,
      lastSubmitAt: ago(CHALLENGE_INTERVAL_MS - 1),
      now: NOW,
    })
    expect(g.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  it('从没提交过 → 不受间隔限制', () => {
    const g = checkChallenge({ attempts: 0, isMember: false, lastSubmitAt: null, now: NOW })
    expect(g.allowed).toBe(true)
  })

  it('⭐ 两条都命中时给 QUOTA_EXHAUSTED —— 额度是根因，再等多久也没用', () => {
    // ⚠️ 顺序不能反：反了会给用户「等 2 分钟就能提交」的错觉，
    //    而他等完 2 分钟照样提交不了（额度是根本原因）。
    const g = checkChallenge({
      attempts: MEMBER_ATTEMPTS_PER_SENTENCE,
      isMember: true,
      lastSubmitAt: ago(1_000),
      now: NOW,
    })
    expect(g.code).toBe('QUOTA_EXHAUSTED')
  })
})

describe('trackInvalid —— 无效提交（不占额度）', () => {
  it('当天第一次 → 计数 1，不拦', () => {
    expect(trackInvalid(0, null, '2026-09-21')).toEqual({ count: 1, blocked: false })
  })

  it('跨天重新计数', () => {
    expect(trackInvalid(2, '2026-09-20', '2026-09-21')).toEqual({ count: 1, blocked: false })
  })

  it('当天连续超过上限 → 拦', () => {
    expect(trackInvalid(2, '2026-09-21', '2026-09-21')).toEqual({ count: 3, blocked: true })
  })
})
