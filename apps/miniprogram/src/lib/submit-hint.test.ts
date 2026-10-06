import { describe, expect, it } from 'vitest'
import { isSlowReading, submitHintOf } from './submit-hint'

describe('submitHintOf —— 提交按钮下面那一行', () => {
  it('① 什么都没问题 ⇒ 邀请提交', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: false })).toBe('朗读完整，点击提交 AI 检测并打分')
  })

  it('② 只漏读', () => {
    expect(submitHintOf({ missed: 2, misread: 0, slow: false })).toBe('漏读 2 个单词，建议重试')
  })

  it('③ 只读错', () => {
    expect(submitHintOf({ missed: 0, misread: 3, slow: false })).toBe('读错 3 个单词，建议重试')
  })

  it('④ 两个都有 ⇒ 一句话里都说到，不拆成两行', () => {
    expect(submitHintOf({ missed: 2, misread: 1, slow: false })).toBe(
      '漏读 2 个单词，读错 1 个单词，建议重试',
    )
  })

  it('⑤ 只慢', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: true })).toBe('读得有点慢，建议重读一遍后提交')
  })

  it('⭐ 读得不全比读得慢更该先说 —— 两个都占时只报前者', () => {
    expect(submitHintOf({ missed: 1, misread: 0, slow: true })).toBe('漏读 1 个单词，建议重试')
    expect(submitHintOf({ missed: 0, misread: 1, slow: true })).toBe('读错 1 个单词，建议重试')
  })

  it('⚠️ 文案里不出现"错读"（用户列举时写混过一次）—— 统一用"读错"', () => {
    expect(submitHintOf({ missed: 1, misread: 1, slow: false })).not.toContain('错读')
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
