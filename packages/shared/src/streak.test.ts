import { describe, expect, it } from 'vitest'
import { FREEZE_EVERY_DAYS, applyRead, newStreakState, type StreakState } from './streak'

function state(patch: Partial<StreakState> = {}): StreakState {
  return { ...newStreakState(), ...patch }
}

describe('applyRead —— 首次与日常续上', () => {
  it('第一次读 streak = 1', () => {
    const r = applyRead(state(), '2026-08-21')
    expect(r.streakDays).toBe(1)
    expect(r.streakBest).toBe(1)
    expect(r.lastReadDate).toBe('2026-08-21')
    expect(r.counted).toBe(true)
    expect(r.delta).toBe(1)
  })

  it('昨天读过 → +1', () => {
    const r = applyRead(state({ streakDays: 4, streakBest: 4, lastReadDate: '2026-08-20' }), '2026-08-21')
    expect(r.streakDays).toBe(5)
    expect(r.delta).toBe(1)
    expect(r.counted).toBe(true)
  })

  it('跨月 / 跨年同样只认「差一天」', () => {
    expect(applyRead(state({ streakDays: 2, lastReadDate: '2026-08-31' }), '2026-09-01').streakDays).toBe(3)
    expect(applyRead(state({ streakDays: 9, lastReadDate: '2025-12-31' }), '2026-01-01').streakDays).toBe(10)
  })
})

describe('applyRead —— 同一天重复读不叠加', () => {
  it('今天已经读过 → counted=false 且状态一个字段都不动', () => {
    const before = state({ streakDays: 6, streakBest: 6, lastReadDate: '2026-08-21', freezeCount: 1 })
    const r = applyRead(before, '2026-08-21')
    expect(r.counted).toBe(false)
    expect(r.delta).toBe(0)
    expect(r.streakDays).toBe(6)
    expect(r.freezeCount).toBe(1)
    expect(r.freezeEarned).toBe(0)
  })

  it('⚠️ 读十遍也只算一次 —— streak 奖励「回来」，不奖励「量」', () => {
    let s = state()
    for (let i = 0; i < 10; i++) s = applyRead(s, '2026-08-21')
    expect(s.streakDays).toBe(1)
  })
})

describe('applyRead —— 断档', () => {
  it('没有 Freeze：归 1（而不是 0）', () => {
    const r = applyRead(state({ streakDays: 12, streakBest: 12, lastReadDate: '2026-08-19' }), '2026-08-21')
    // 今天这一读是有效的，所以不是 0 —— 归 0 会让用户看到「读了但还是 0 天」
    expect(r.streakDays).toBe(1)
    expect(r.delta).toBe(-11)
  })

  it('⚠️ streakBest 只增不减 —— 断档不没收徽章', () => {
    const r = applyRead(state({ streakDays: 30, streakBest: 30, lastReadDate: '2026-01-01' }), '2026-08-21')
    expect(r.streakDays).toBe(1)
    expect(r.streakBest).toBe(30)
  })

  it('有冻结卡：全额补上，streak 不断', () => {
    const r = applyRead(
      state({ streakDays: 10, streakBest: 10, lastReadDate: '2026-08-18', freezeCount: 3 }),
      '2026-08-21',
    )
    // 中间漏了 19 / 20 两天
    expect(r.freezeUsed).toBe(2)
    expect(r.freezeCount).toBe(1)
    expect(r.streakDays).toBe(11)
    expect(r.delta).toBe(1)
  })

  it('⚠️ 补不齐就归 1，不做「部分补」 —— 半补出来的数字没法向用户解释', () => {
    const r = applyRead(
      state({ streakDays: 30, streakBest: 30, lastReadDate: '2026-08-01', freezeCount: 5 }),
      '2026-08-21',
    )
    expect(r.streakDays).toBe(1)
    // ⚠️ 补不齐时不能扣卡：扣了却没用上，用户会看到卡凭空少了
    expect(r.freezeUsed).toBe(0)
    expect(r.freezeCount).toBe(5)
  })

  it('恰好补得齐（边界）', () => {
    const r = applyRead(
      state({ streakDays: 7, streakBest: 7, lastReadDate: '2026-08-18', freezeCount: 2 }),
      '2026-08-21',
    )
    expect(r.freezeUsed).toBe(2)
    expect(r.freezeCount).toBe(0)
    expect(r.streakDays).toBe(8)
  })

  it('差一张就补不齐（边界）', () => {
    const r = applyRead(
      state({ streakDays: 7, streakBest: 7, lastReadDate: '2026-08-18', freezeCount: 1 }),
      '2026-08-21',
    )
    expect(r.freezeUsed).toBe(0)
    expect(r.freezeCount).toBe(1)
    expect(r.streakDays).toBe(1)
  })
})

describe('applyRead —— Freeze 发放', () => {
  it('满 7 天发 1 张', () => {
    const r = applyRead(state({ streakDays: 6, streakBest: 6, lastReadDate: '2026-08-20' }), '2026-08-21')
    expect(r.streakDays).toBe(FREEZE_EVERY_DAYS)
    expect(r.freezeEarned).toBe(1)
    expect(r.freezeCount).toBe(1)
  })

  it('第 8 天不再重复发', () => {
    const r = applyRead(
      state({ streakDays: 7, streakBest: 7, lastReadDate: '2026-08-20', freezeCount: 1 }),
      '2026-08-21',
    )
    expect(r.freezeEarned).toBe(0)
    expect(r.freezeCount).toBe(1)
  })

  it('第 14 天再发一张（每 7 天一张）', () => {
    const r = applyRead(
      state({ streakDays: 13, streakBest: 13, lastReadDate: '2026-08-20', freezeCount: 1 }),
      '2026-08-21',
    )
    expect(r.freezeEarned).toBe(1)
    expect(r.freezeCount).toBe(2)
  })

  it('⚠️ 补签一次跨过两个 7 天倍数时，两张都要发', () => {
    // 13 天 → 用 Freeze 补 7 天 → 14 天，跨过 14 这个倍数
    const r = applyRead(
      state({ streakDays: 13, streakBest: 13, lastReadDate: '2026-08-13', freezeCount: 7 }),
      '2026-08-21',
    )
    expect(r.streakDays).toBe(14)
    expect(r.freezeUsed).toBe(7)
    // 补签花掉 7 张、又发 1 张
    expect(r.freezeEarned).toBe(1)
    expect(r.freezeCount).toBe(1)
  })

  it('归 1 时绝不倒扣 Freeze', () => {
    const r = applyRead(
      state({ streakDays: 20, streakBest: 20, lastReadDate: '2026-01-01', freezeCount: 0 }),
      '2026-08-21',
    )
    expect(r.freezeEarned).toBe(0)
    expect(r.freezeCount).toBe(0)
    expect(r.streakDays).toBe(1)
  })
})

describe('applyRead —— 时钟异常', () => {
  it('⚠️ lastReadDate 在未来（时钟回拨）时不重置、不烧 streak', () => {
    const before = state({ streakDays: 9, streakBest: 9, lastReadDate: '2026-09-01', freezeCount: 2 })
    const r = applyRead(before, '2026-08-21')
    expect(r.streakDays).toBe(9)
    expect(r.freezeUsed).toBe(0)
    expect(r.counted).toBe(false)
    expect(r.lastReadDate).toBe('2026-09-01')
  })
})
