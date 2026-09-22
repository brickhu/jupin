import { describe, expect, it } from 'vitest'

import { agoText } from './time'

/**
 * ⚠️ 这些断言钉的是**用户看到的那一行字**，不是格式偏好：
 *    「精确到分」是产品要求 —— 时间说不清，用户就无法把一条记录和
 *    「我那天在地铁上读的那次」对上。
 * ⚠️ 全部用固定的「现在」，否则断言只能写成「包含『分钟前』」这种废话。
 */
describe('agoText —— 挑战记录的时间（精确到分）', () => {
  // 北京 2026-09-21 20:00
  const NOW = Date.parse('2026-09-21T12:00:00Z')
  const at = (ms: number) => new Date(NOW - ms).toISOString()

  it('一分钟内说「刚刚」', () => {
    expect(agoText(at(0), NOW)).toBe('刚刚')
    expect(agoText(at(59_000), NOW)).toBe('刚刚')
  })

  it('一小时内精确到分钟', () => {
    expect(agoText(at(60_000), NOW)).toBe('1 分钟前')
    expect(agoText(at(5 * 60_000), NOW)).toBe('5 分钟前')
    expect(agoText(at(59 * 60_000), NOW)).toBe('59 分钟前')
  })

  it('今天更早的时刻给「今天 HH:MM」（北京时间）', () => {
    expect(agoText(at(2 * 60 * 60_000), NOW)).toBe('今天 18:00')
    // 北京时间 00:05 —— 同一个 UTC 日，但已经是第二天
    expect(agoText('2026-09-20T16:05:00Z', NOW)).toBe('今天 00:05')
  })

  it('昨天带「昨天」两个字', () => {
    expect(agoText('2026-09-20T06:30:00Z', NOW)).toBe('昨天 14:30')
  })

  it('今年更早的给 MM-DD HH:MM', () => {
    expect(agoText('2026-09-01T02:03:00Z', NOW)).toBe('09-01 10:03')
  })

  it('往年的带上年份', () => {
    expect(agoText('2025-03-05T01:00:00Z', NOW)).toBe('2025-03-05 09:00')
  })

  it('⭐ 按北京时间算，不跟着设备时区走', () => {
    // 这一条在 UTC 下是 09-20 16:05，在北京是 09-21 00:05 —— 必须是「今天」
    expect(agoText('2026-09-20T16:05:00Z', NOW)).toBe('今天 00:05')
  })

  it('拿不到时间就给空串（调用方据此不渲染那一格）', () => {
    expect(agoText(null, NOW)).toBe('')
    expect(agoText(undefined, NOW)).toBe('')
    expect(agoText('', NOW)).toBe('')
    expect(agoText('昨天下午', NOW)).toBe('')
  })

  it('设备时钟比服务端慢（时间在未来）不显示成负数', () => {
    expect(agoText(at(-90_000), NOW)).toBe('刚刚')
  })
})