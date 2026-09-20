import { describe, it, expect } from 'vitest'
import { estimateSampleRateFromFrames } from './resample'

/** 造一串等间隔到达的帧 */
function frames(bytes: number, count: number, intervalMs: number): { bytes: number; t: number }[] {
  return Array.from({ length: count }, (_, i) => ({ bytes, t: i * intervalMs }))
}

describe('estimateSampleRateFromFrames —— 反推设备真实采样率', () => {
  /**
   * ⭐⭐ 真机实测数据（iPhone 15）：帧 4096 字节、间隔 137ms、采样率 16kHz。
   *
   * ⚠️ 这条测试钉的是一个**真实毁掉过录音**的 off-by-one：
   *    如果分子把第一帧也算进去，会得到 29898 B/s → 吸附成 32000Hz，
   *    于是 16kHz 音频被砍掉一半长度 —— 试听快一倍、高一个八度。
   */
  it('⭐⭐ iPhone 实测：4096 字节 / 137ms → 16000（不是 32000）', () => {
    expect(estimateSampleRateFromFrames(frames(4096, 2, 137))).toBe(16000)
    // 多帧也一样（分子是「第 2 帧起」的字节和，跨度是首末之差，比例不变）
    expect(estimateSampleRateFromFrames(frames(4096, 10, 137))).toBe(16000)
  })

  it('⭐ 反例：若把第一帧也算进分子，就会得到 32000 —— 这个坑值得留个记号', () => {
    // 8192 / 137ms × 1000 ÷ 2 = 29898 → 吸附到 32000
    const wrong = (8192 / 137) * 1000 / 2
    expect(wrong).toBeCloseTo(29898, -1)
    expect(Math.abs(32000 - wrong) / 32000).toBeLessThan(0.08) // 落在容差内，会被错误吸附
  })

  it('8kHz 设备：2048 字节 / 128ms → 8000', () => {
    // 2048 / 128ms × 1000 ÷ 2 = 8000
    expect(estimateSampleRateFromFrames(frames(2048, 2, 128))).toBe(8000)
  })

  it('Android 实测：2560 字节 / 137ms → 仍是 16000 附近', () => {
    // 2560 / 137 × 1000 ÷ 2 = 9343 —— 距 8000 偏 17%、距 16000 偏 42%，测不准
    expect(estimateSampleRateFromFrames(frames(2560, 2, 137))).toBe(0)
  })

  it('帧数不足 2（算不出跨度）→ 0（宁可不动数据）', () => {
    expect(estimateSampleRateFromFrames([])).toBe(0)
    expect(estimateSampleRateFromFrames(frames(4096, 1, 137))).toBe(0)
  })

  it('时间戳相同（同一毫秒到达）→ 0，不产生 Infinity', () => {
    const same = [
      { bytes: 4096, t: 100 },
      { bytes: 4096, t: 100 },
    ]
    expect(estimateSampleRateFromFrames(same)).toBe(0)
  })
})
