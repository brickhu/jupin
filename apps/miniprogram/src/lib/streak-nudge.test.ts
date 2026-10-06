import { describe, expect, it } from 'vitest'
import type { MakeupState } from '@jushuo/shared'
import { streakNudgeOf } from './streak-nudge'

/**
 * ⭐ 连战提醒的**分级** —— 分级本身就是产品决策（prd §7.8.1），所以要被测住。
 * ⚠️ 两组最要紧的用例：**稀缺必须是真的**、**断太久不许说成失败**。
 */

const gap = (n: number): MakeupState => ({
  ok: true,
  gapDays: n,
  cost: n * 3,
  totalCost: n * 3 + 2,
})
const tooLong: MakeupState = { ok: false, gapDays: 4, cost: 0, totalCost: 2, reason: 'too-long' }
const noGap: MakeupState = { ok: false, gapDays: 0, cost: 0, totalCost: 2, reason: 'no-gap' }

describe('今天读过了 ⇒ 不提醒', () => {
  it('⚠️ 他已经在做这件事了，别再吵他', () => {
    expect(streakNudgeOf(gap(2), true, 30).level).toBe('none')
    expect(streakNudgeOf(tooLong, true, 30).level).toBe('none')
  })
})

describe('今天还没读、但还没断 ⇒ 预防那一档', () => {
  it('⭐ 是 today 而不是 gap —— 不用补，只差读一句', () => {
    expect(streakNudgeOf(noGap, false, 30).level).toBe('today')
  })

  it('⚠️ 这一档**没有按钮**（去读就是首页本身，不需要跳走）', () => {
    expect(streakNudgeOf(noGap, false, 30).action).toBe('')
  })

  it('从没读过的人不说"连战还连着"', () => {
    expect(streakNudgeOf(noGap, false, 0).note).not.toContain('连着')
  })
})

describe('断档逐级升级', () => {
  it('断 1 / 2 / 3 天 ⇒ gap1 / gap2 / gap3', () => {
    expect(streakNudgeOf(gap(1), false, 30).level).toBe('gap1')
    expect(streakNudgeOf(gap(2), false, 30).level).toBe('gap2')
    expect(streakNudgeOf(gap(3), false, 30).level).toBe('gap3')
  })

  it('⚠️ 只有 gap3 用弹窗 —— 它是**真的最后一天**（上限 3 天是硬的）', () => {
    expect(streakNudgeOf(gap(3), false, 30).title).toContain('最后一天')
  })

  it('⭐⭐ 稀缺必须是真的：gap1 说还剩 2 天、gap2 说还剩 1 天', () => {
    expect(streakNudgeOf(gap(1), false, 30).note).toContain('还有 2 天')
    expect(streakNudgeOf(gap(2), false, 30).note).toContain('还有 1 天')
  })

  it('⭐⭐ 说「还剩几天」，**不说"你哪天断的"**（时间压力比日期有效）', () => {
    for (const g of [1, 2, 3]) {
      const n = streakNudgeOf(gap(g), false, 30)
      expect(n.title + n.note).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })

  it('补签要花几点要说出来（不然用户不知道够不够）', () => {
    expect(streakNudgeOf(gap(2), false, 30).cost).toBe(6)
  })
})

describe('⚠️ 断太久那一档 —— 不说失败', () => {
  it('kind 是 restart', () => {
    expect(streakNudgeOf(tooLong, false, 47).level).toBe('restart')
  })

  it('⭐⭐ 文案里**不许出现"失败"**，要说"重来/重新开始"', () => {
    const n = streakNudgeOf(tooLong, false, 47)
    expect(n.title + n.note).not.toContain('失败')
    expect(n.title).toContain('重来')
  })

  it('⭐⭐ 要提「最长的 N 天还在」—— 让"重来"没那么痛', () => {
    expect(streakNudgeOf(tooLong, false, 47).note).toContain('47')
  })

  it('没有历史最长时也不说一句空话', () => {
    expect(streakNudgeOf(tooLong, false, 0).note).toContain('新的一根')
  })
})

describe('服务端那份还没到', () => {
  it('⚠️ 什么都不说 —— 编一句是在替服务端下结论', () => {
    expect(streakNudgeOf(undefined, false, 30).level).toBe('none')
  })
})
