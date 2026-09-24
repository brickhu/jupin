import { describe, expect, it } from 'vitest'
import { formatDuration } from './format'

describe('formatDuration', () => {
  it('固定 mm:ss、两段都两位 —— 5 秒是 00:05 而不是 0:05', () => {
    expect(formatDuration(5000)).toBe('00:05')
    expect(formatDuration(65_000)).toBe('01:05')
    expect(formatDuration(600_000)).toBe('10:00')
  })

  it('超过一小时不折成小时，分钟位继续涨（标准音最长也就十几秒）', () => {
    expect(formatDuration(3_600_000)).toBe('60:00')
    expect(formatDuration(5_999_000)).toBe('99:59')
  })

  it('四舍五入到秒', () => {
    expect(formatDuration(4999)).toBe('00:05')
    expect(formatDuration(4400)).toBe('00:04')
    expect(formatDuration(999)).toBe('00:01')
  })

  it('算不出来就是空串 —— 调用方据此不渲染时长（显示 00:00 会像音频坏了）', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('')
    // 不足半秒 ⇒ 舍入后是 0 秒，同样不显示
    expect(formatDuration(300)).toBe('')
  })
})
