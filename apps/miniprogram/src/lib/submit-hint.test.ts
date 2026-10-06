import { describe, expect, it } from 'vitest'
import { isSlowReading, submitHintOf } from './submit-hint'

describe('submitHintOf —— 提交按钮下面那一行', () => {
  it('① 什么都没问题 ⇒ 邀请提交', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: false })).toEqual({
      text: '朗读完整，点击提交 AI 检测并打分',
      ok: true,
    })
  })

  it('② 只漏读', () => {
    expect(submitHintOf({ missed: 2, misread: 0, slow: false }).text).toBe('漏读 2 个单词，建议重试')
  })

  it('③ 只读错', () => {
    expect(submitHintOf({ missed: 0, misread: 3, slow: false }).text).toBe('读错 3 个单词，建议重试')
  })

  it('④ 两个都有 ⇒ 一句话里都说到，不拆成两行', () => {
    expect(submitHintOf({ missed: 2, misread: 1, slow: false }).text).toBe(
      '漏读 2 个单词，读错 1 个单词，建议重试',
    )
  })

  it('⑤ 只慢', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: true }).text).toBe('读得有点慢，建议重读一遍后提交')
  })

  it('⭐ 读得不全比读得慢更该先说 —— 两个都占时只报前者', () => {
    expect(submitHintOf({ missed: 1, misread: 0, slow: true }).text).toBe('漏读 1 个单词，建议重试')
    expect(submitHintOf({ missed: 0, misread: 1, slow: true }).text).toBe('读错 1 个单词，建议重试')
  })

  it('⚠️ 文案里不出现"错读"（用户列举时写混过一次）—— 统一用"读错"', () => {
    expect(submitHintOf({ missed: 1, misread: 1, slow: false }).text).not.toContain('错读')
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

describe('submitHintOf 的 ok —— 界面据此选颜色（绿 / 黄）', () => {
  it('⭐⭐ **只有"朗读完整"是绿的**，其余（含读得慢）一律黄', () => {
    expect(submitHintOf({ missed: 0, misread: 0, slow: false }).ok).toBe(true)

    expect(submitHintOf({ missed: 1, misread: 0, slow: false }).ok).toBe(false)
    expect(submitHintOf({ missed: 0, misread: 1, slow: false }).ok).toBe(false)
    expect(submitHintOf({ missed: 1, misread: 1, slow: false }).ok).toBe(false)
    // ⚠️ "读得有点慢"也是**有事要说**，用黄不用绿
    expect(submitHintOf({ missed: 0, misread: 0, slow: true }).ok).toBe(false)
  })

  it('ok 与 text 同源 —— 绿的那一句一定是"朗读完整"', () => {
    const cases = [
      { missed: 0, misread: 0, slow: false },
      { missed: 2, misread: 0, slow: false },
      { missed: 0, misread: 0, slow: true },
    ]
    for (const c of cases) {
      const h = submitHintOf(c)
      expect(h.ok).toBe(h.text.startsWith('朗读完整'))
    }
  })
})
