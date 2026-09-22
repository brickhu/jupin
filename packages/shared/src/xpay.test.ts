import { describe, expect, it } from 'vitest'

import { explainXpayError } from './xpay'

/**
 * ⚠️ 这些码值得逐条翻译：它们几乎都指向「配置 / 发布流程没走完」而不是代码 bug，
 *    而用户在端侧看到的是这一句 —— 直接甩一个 -15013 给他，等于什么也没说。
 */
describe('虚拟支付错误码翻译', () => {
  it('认识的码给人话，且带上码本身（方便回查文档）', () => {
    expect(explainXpayError(-15013)).toContain('道具价格')
    expect(explainXpayError(-15013)).toContain('-15013')
  })

  it('不认识的码不丢信息', () => {
    expect(explainXpayError(-99999, '奇奇怪怪')).toContain('奇奇怪怪')
  })

  it('没有码时用原始信息兜底（0 也算没有码 —— 成功不是错误）', () => {
    expect(explainXpayError(undefined, '网络错误')).toBe('网络错误')
    expect(explainXpayError(0, '网络错误')).toBe('网络错误')
  })

  /** ⚠️ 用户取消是最常见的「失败」，不能给一句看不懂的报错 */
  it('取消支付说得像人话', () => {
    expect(explainXpayError(-2)).toContain('取消')
  })
})
