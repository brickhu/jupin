import { describe, expect, it } from 'vitest'
import { isSlowReading, submitHintOf } from './submit-hint'

describe('submitHintOf —— 提交按钮下面那一行', () => {
  it('① 什么都没问题 ⇒ 邀请提交（绿）', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: false })).toEqual({
      text: '朗读完整，点击提交 AI 检测并打分',
      level: 'ok',
    })
  })

  it('② 只漏读 ⇒ **拦提交**，措辞是「请重新朗读」而不是「建议重试」', () => {
    expect(submitHintOf({ missed: 2, misread: 0, slow: false })).toEqual({
      text: '漏读 2 个单词，请重新朗读',
      level: 'block',
    })
  })

  it('③ 只读错 ⇒ **不拦**（ASR 听错占很大一块），仍是建议的口吻', () => {
    expect(submitHintOf({ missed: 0, misread: 3, slow: false })).toEqual({
      text: '读错 3 个单词，建议重试',
      level: 'warn',
    })
  })

  it('④ 漏读 + 读错 ⇒ 因为漏读而**拦**，一句话里都说到', () => {
    expect(submitHintOf({ missed: 2, misread: 1, slow: false })).toEqual({
      text: '漏读 2 个单词，读错 1 个单词，请重新朗读',
      level: 'block',
    })
  })

  it('⑤ 只慢 ⇒ 黄、不拦（建议重读一遍后提交）', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: true })).toEqual({
      text: '读得有点慢，建议重读一遍后提交',
      level: 'warn',
    })
  })

  it('⭐ 读得不全比读得慢更该先说 —— 两个都占时只报前者', () => {
    expect(submitHintOf({ missed: 1, misread: 0, slow: true }).text).toBe('漏读 1 个单词，请重新朗读')
    expect(submitHintOf({ missed: 0, misread: 1, slow: true }).text).toBe('读错 1 个单词，建议重试')
  })

  it('⚠️ 文案里不出现"错读"（用户列举时写混过一次）—— 统一用"读错"', () => {
    expect(submitHintOf({ missed: 1, misread: 1, slow: false }).text).not.toContain('错读')
  })
})

describe('submitHintOf 的 level —— 同时决定颜色和按钮能不能按', () => {
  it('⭐⭐ **只有漏读出 block**（= 红 + 按钮变灰），其余都不是', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: false }).level).toBe('ok')
    expect(submitHintOf({ missed: 0, misread: 0, slow: true }).level).toBe('warn')
    expect(submitHintOf({ missed: 0, misread: 9, slow: false }).level).toBe('warn')

    expect(submitHintOf({ missed: 1, misread: 0, slow: false }).level).toBe('block')
    expect(submitHintOf({ missed: 1, misread: 1, slow: false }).level).toBe('block')
  })

  it('⭐ level 与文案同源 —— block 的那一句一定含「请重新朗读」', () => {
    const cases = [
      { missed: 0, misread: 0, slow: false },
      { missed: 2, misread: 0, slow: false },
      { missed: 2, misread: 1, slow: false },
      { missed: 0, misread: 2, slow: false },
      { missed: 0, misread: 0, slow: true },
    ]
    for (const c of cases) {
      const h = submitHintOf(c)
      expect(h.level === 'block').toBe(h.text.includes('请重新朗读'))
    }
  })
})

describe('isSlowReading —— 时长对比标准音', () => {
  it('超过 2 倍 ⇒ 慢', () => {
    expect(isSlowReading(9000, 4000)).toBe(true)
  })

  it('没到 2 倍 ⇒ 不慢', () => {
    expect(isSlowReading(7000, 4000)).toBe(false)
  })

  it('正好 2 倍 ⇒ 不算慢（要"过长"，边界取不到）', () => {
    expect(isSlowReading(8000, 4000)).toBe(false)
  })

  it('⚠️ 标准音拿不到（0）⇒ 不判慢 —— 没有参照就不下结论', () => {
    expect(isSlowReading(99000, 0)).toBe(false)
  })

  it('⚠️ 标准音太短 ⇒ 不判慢（短句的比值噪声太大）', () => {
    // 1.2 秒的句子读 2.5 秒 = 2 倍多，可那完全正常
    expect(isSlowReading(2500, 1200)).toBe(false)
  })

  it('标准音刚过下限就开始判', () => {
    expect(isSlowReading(5000, 2000)).toBe(true)
  })
})
