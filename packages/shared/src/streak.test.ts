import { describe, expect, it } from 'vitest'
import { applyRead, newStreakState, type StreakState } from './streak'

/**
 * Streak 的单测 —— 规则全在纯函数里，边界只能在这里钉。
 *
 * ⚠️⚠️ 这一版有一条**行为改动**要守住：**断档不再自动消耗解冻卡**。
 *    卡改成用户主动补签（见 services/unfreeze.ts），所以 applyRead
 *    的入参里**根本没有卡数** —— 用签名把这条钉死，比写十句注释管用。
 */

function state(over: Partial<StreakState> = {}): StreakState {
  return { ...newStreakState(), ...over }
}

describe('applyRead —— 每天读一句 +1', () => {
  it('第一次读 streak = 1', () => {
    const r = applyRead(newStreakState(), '2026-08-21')
    expect(r.streakDays).toBe(1)
    expect(r.streakBest).toBe(1)
    expect(r.counted).toBe(true)
    expect(r.delta).toBe(1)
    expect(r.lastReadDate).toBe('2026-08-21')
  })

  it('昨天读过 → 续上', () => {
    const r = applyRead(state({ streakDays: 4, streakBest: 4, lastReadDate: '2026-08-20' }), '2026-08-21')
    expect(r.streakDays).toBe(5)
    expect(r.delta).toBe(1)
  })

  it('跨月 / 跨年都按自然日算', () => {
    expect(applyRead(state({ streakDays: 2, lastReadDate: '2026-08-31' }), '2026-09-01').streakDays).toBe(3)
    expect(applyRead(state({ streakDays: 9, lastReadDate: '2025-12-31' }), '2026-01-01').streakDays).toBe(10)
  })
})

describe('applyRead —— 同一天只算一次', () => {
  it('今天已经读过 ⇒ 原样返回', () => {
    const before = state({ streakDays: 5, streakBest: 5, lastReadDate: '2026-08-21' })
    const r = applyRead(before, '2026-08-21')
    expect(r.streakDays).toBe(5)
    expect(r.counted).toBe(false)
    expect(r.delta).toBe(0)
  })

  it('⚠️ 读十遍也只算一次 —— streak 奖励「回来」，不奖励「量」', () => {
    let s = newStreakState()
    for (let i = 0; i < 10; i++) s = applyRead(s, '2026-08-21')
    expect(s.streakDays).toBe(1)
  })
})

describe('applyRead —— 断档', () => {
  it('⭐⭐ 断档直接归 1，**不自动消耗解冻卡**（卡是用户的资产）', () => {
    const r = applyRead(state({ streakDays: 12, streakBest: 12, lastReadDate: '2026-08-19' }), '2026-08-21')
    expect(r.streakDays).toBe(1)
    expect(r.delta).toBe(-11)
    // ⚠️ 入参里没有卡数、出参里也没有「用掉几张」—— 自动消耗这条路已经不存在了
    expect(Object.keys(r).sort()).toEqual(['counted', 'delta', 'lastReadDate', 'streakBest', 'streakDays'])
  })

  it('断档多久都一样：归 1，不按缺口扣任何东西', () => {
    expect(applyRead(state({ streakDays: 30, lastReadDate: '2026-08-01' }), '2026-08-21').streakDays).toBe(1)
    expect(applyRead(state({ streakDays: 3, lastReadDate: '2026-06-01' }), '2026-08-21').streakDays).toBe(1)
  })

  it('⚠️ streakBest 只增不减 —— 断档不没收历史最好成绩', () => {
    const r = applyRead(state({ streakDays: 30, streakBest: 30, lastReadDate: '2026-01-01' }), '2026-08-21')
    expect(r.streakDays).toBe(1)
    expect(r.streakBest).toBe(30)
  })
})

describe('applyRead —— 时钟回拨', () => {
  it('⚠️ lastReadDate 在未来时不重置、不烧 streak', () => {
    const before = state({ streakDays: 9, streakBest: 9, lastReadDate: '2026-09-01' })
    const r = applyRead(before, '2026-08-21')
    expect(r.streakDays).toBe(9)
    expect(r.counted).toBe(false)
    expect(r.lastReadDate).toBe('2026-09-01')
  })
})
