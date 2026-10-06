import { describe, expect, it } from 'vitest'
import { addDays } from './day'
import {
  ENERGY_PER_MAKEUP_DAY,
  MAX_MAKEUP_DAYS,
  makeupCostOf,
  makeupEligibilityOf,
  makeupTotalCostOf,
} from './makeup'
import type { StreakState } from './streak'

const TODAY = '2026-10-06'
/** lastReadDate 是 N 天前；streakDays 随便给个数，补签不该动它 */
const readDaysAgo = (n: number): StreakState => ({
  streakDays: 30,
  streakBest: 47,
  lastReadDate: addDays(TODAY, -n),
})

describe('makeupCostOf —— 等差 3 / 6 / 9', () => {
  it('1 天 3 / 2 天 6 / 3 天 9', () => {
    expect([1, 2, 3].map(makeupCostOf)).toEqual([3, 6, 9])
  })

  it('⚠️ 每天 3 点 —— 必须大于「读一句」的 2 点，否则纪律作废', () => {
    expect(ENERGY_PER_MAKEUP_DAY).toBeGreaterThan(2)
  })

  it('没断档（0 / 负数 / 脏数据）⇒ 0', () => {
    expect(makeupCostOf(0)).toBe(0)
    expect(makeupCostOf(-1)).toBe(0)
    expect(makeupCostOf(Number.NaN)).toBe(0)
  })

  it('⚠️ 超过上限的天数**被夹到上限**，不是线性增长（3 天以上不涨价）', () => {
    expect(makeupCostOf(4)).toBe(9)
    expect(makeupCostOf(100)).toBe(9 * 1) // ENERGY_PER_MAKEUP_DAY * MAX_MAKEUP_DAYS
  })
})

describe('makeupEligibilityOf —— 什么时候能补', () => {
  it('⭐ 断 1 天、今天还没读 ⇒ 能补，3 点', () => {
    const e = makeupEligibilityOf(readDaysAgo(2), TODAY)
    expect(e.ok).toBe(true)
    expect(e.gapDays).toBe(1)
    expect(e.cost).toBe(3)
  })

  it('⭐ 断 3 天（上限）⇒ 能补，9 点', () => {
    const e = makeupEligibilityOf(readDaysAgo(4), TODAY)
    expect(e.ok).toBe(true)
    expect(e.gapDays).toBe(3)
    expect(e.cost).toBe(9)
  })

  it('⚠️ 断 4 天 ⇒ too-long（只能重来，端侧要说成"新的开始"）', () => {
    const e = makeupEligibilityOf(readDaysAgo(5), TODAY)
    expect(e.ok).toBe(false)
    expect(e.reason).toBe('too-long')
    expect(e.gapDays).toBe(4)
  })

  it('⚠️⚠️ 今天已经读过 ⇒ already-read-today（缺口要在读之前补）', () => {
    const e = makeupEligibilityOf({ streakDays: 1, streakBest: 47, lastReadDate: TODAY }, TODAY)
    expect(e.ok).toBe(false)
    expect(e.reason).toBe('already-read-today')
  })

  it('昨天刚读过 ⇒ no-gap（天天来的人用不到这个功能）', () => {
    const e = makeupEligibilityOf(readDaysAgo(1), TODAY)
    expect(e.ok).toBe(false)
    expect(e.reason).toBe('no-gap')
  })

  it('从没读过 ⇒ no-gap（没有连战可救）', () => {
    const e = makeupEligibilityOf({ streakDays: 0, streakBest: 0, lastReadDate: null }, TODAY)
    expect(e.ok).toBe(false)
    expect(e.reason).toBe('no-gap')
  })

  it('⚠️ lastReadDate 在未来（时钟回拨）⇒ no-gap，不让他花冤枉钱', () => {
    const e = makeupEligibilityOf(
      { streakDays: 5, streakBest: 5, lastReadDate: addDays(TODAY, 3) },
      TODAY,
    )
    expect(e.ok).toBe(false)
    expect(e.reason).toBe('no-gap')
  })
})

describe('⭐ 补完之后的状态 —— 补签本身不加天数', () => {
  it('newLastReadDate 是**昨天**，不是今天', () => {
    const e = makeupEligibilityOf(readDaysAgo(3), TODAY)
    expect(e.newLastReadDate).toBe(addDays(TODAY, -1))
  })

  it('⭐⭐ 因为推到昨天，`applyRead(今天)` 就会算成"续上" —— 这才是接上了', async () => {
    const { applyRead } = await import('./streak')
    const before = makeupEligibilityOf(readDaysAgo(4), TODAY) // 断 3 天，streakDays 30
    const made = { ...readDaysAgo(4), lastReadDate: before.newLastReadDate as string }
    const after = applyRead(made, TODAY)
    expect(after.streakDays, '补完之后读今天 = 续上，不是归 1').toBe(31)
    expect(after.counted).toBe(true)
  })

  it('⚠️ 而**不补**直接读今天 ⇒ 归 1（这就是补签要救的东西）', async () => {
    const { applyRead } = await import('./streak')
    expect(applyRead(readDaysAgo(4), TODAY).streakDays).toBe(1)
  })

  it('streakBest 不受断档影响（所以"重来"没那么痛）', () => {
    const e = makeupEligibilityOf(readDaysAgo(4), TODAY)
    expect(e.ok).toBe(true)
    expect(readDaysAgo(4).streakBest).toBe(47)
  })
})

describe('makeupTotalCostOf —— 补签当天的总账', () => {
  it('⚠️ 补签 + 当天读的那一句，两笔都要摆在明处', () => {
    expect(makeupTotalCostOf(1, 2)).toBe(5)
    expect(makeupTotalCostOf(3, 2)).toBe(11)
  })

  it('⚠️ 缺口 = 总数 − 每日保底 —— 这个数是端侧要告诉用户"还差多少"的', () => {
    expect(makeupTotalCostOf(1, 2) - 3).toBe(2)
    expect(makeupTotalCostOf(3, 2) - 3).toBe(8)
  })
})
