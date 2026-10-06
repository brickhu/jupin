import { describe, expect, it } from 'vitest'
import type { MakeupState } from '@jushuo/shared'
import { NO_MAKEUP, makeupViewOf } from './makeup-view'

/**
 * ⭐ 补签区那四档文案 —— 它们**本身就是产品决策**，所以要被测住。
 * ⚠️ 尤其 `too-long` 那一档：断太久**不能说成失败**（见 makeup-view.ts 的说明）。
 */

const ready = (over: Partial<MakeupState> = {}): MakeupState => ({
  ok: true,
  gapDays: 1,
  cost: 3,
  totalCost: 5,
  ...over,
})

describe('能补的那一档', () => {
  it('⭐ 标题说断几天', () => {
    expect(makeupViewOf(ready({ gapDays: 2 }), 100).title).toBe('连断了 2 天')
  })

  it('⭐⭐ 账目必须是**总账**（补签 + 今天读的那一句），不能只说补签的价钱', () => {
    const v = makeupViewOf(ready({ cost: 3, totalCost: 5 }), 100)
    expect(v.note).toContain('补签 3 点')
    expect(v.note, '必须把"今天还要读一句"也写进去').toContain('今天读一句 2 点')
    expect(v.note).toContain('＝ 5 点')
  })

  it('余额够 ⇒ 可以点，按钮是「补签」', () => {
    const v = makeupViewOf(ready({ cost: 3 }), 3)
    expect(v.canPress).toBe(true)
    expect(v.button).toBe('补签')
    expect(v.short).toBe('')
  })

  it('⭐⭐ 余额不够 ⇒ **不让点**（点下去必然失败，那是白让他受一次挫）', () => {
    const v = makeupViewOf(ready({ cost: 6 }), 3)
    expect(v.canPress).toBe(false)
    expect(v.button).toBe('能量不够')
  })

  it('⭐⭐ 不够时要说出**还差几点** —— 只说"不够"，用户没法决定要不要去吃饼干', () => {
    expect(makeupViewOf(ready({ cost: 6 }), 3).short).toContain('还差 3 点')
    expect(makeupViewOf(ready({ cost: 9 }), 2).short).toContain('还差 7 点')
  })

  it('提示里要给出**怎么补**（吃饼干 / 充值）', () => {
    expect(makeupViewOf(ready({ cost: 9 }), 2).short).toContain('饼干')
  })
})

describe('⚠️ 断太久那一档 —— 不能说成失败', () => {
  const tooLong: MakeupState = { ok: false, gapDays: 4, cost: 0, totalCost: 2, reason: 'too-long' }

  it('kind 是 too-long（不是 none、不是失败态）', () => {
    expect(makeupViewOf(tooLong, 100).kind).toBe('too-long')
  })

  it('⭐⭐ 文案里**不许出现"失败"**，要说"重新开始"', () => {
    const v = makeupViewOf(tooLong, 100)
    expect(v.title + v.note).not.toContain('失败')
    expect(v.note).toContain('重新开始')
  })

  it('⭐⭐ 而且要提「最长的连战记录不会丢」—— 让"重来"不那么痛', () => {
    expect(makeupViewOf(tooLong, 100).note).toContain('最长')
  })

  it('⚠️ 没有按钮 —— 这一刻没什么可做的', () => {
    expect(makeupViewOf(tooLong, 100).canPress).toBe(false)
  })
})

describe('今天已经读过那一档', () => {
  const readToday: MakeupState = {
    ok: false,
    gapDays: 1,
    cost: 0,
    totalCost: 2,
    reason: 'already-read-today',
  }

  it('要说清"补签要在读之前做"，否则用户会以为功能坏了', () => {
    const v = makeupViewOf(readToday, 100)
    expect(v.kind).toBe('read-today')
    expect(v.note).toContain('读之前')
  })
})

describe('整块不出现的情况', () => {
  it('没断档（no-gap）⇒ 不渲染 —— 天天来的人不需要看到这个功能', () => {
    expect(makeupViewOf({ ok: false, gapDays: 0, cost: 0, totalCost: 2, reason: 'no-gap' }, 100))
      .toEqual(NO_MAKEUP)
  })

  it('服务端那份还没到（undefined）⇒ 不渲染', () => {
    expect(makeupViewOf(undefined, 100)).toEqual(NO_MAKEUP)
  })

  it('⚠️ not-enough-energy 落在 makeup 里也不渲染 —— 它只在补签那一刻的响应里出现', () => {
    expect(
      makeupViewOf({ ok: false, gapDays: 1, cost: 3, totalCost: 5, reason: 'not-enough-energy' }, 100),
    ).toEqual(NO_MAKEUP)
  })
})
