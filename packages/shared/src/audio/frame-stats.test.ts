import { describe, expect, it } from 'vitest'
import { computeFrameStats, isIntervalConsistent, judgeAudioRate, type FrameSample } from './frame-stats'

/**
 * ⭐ 这里的数字全部来自**真实设备实测**，不是编的。
 *
 * 来源：iPhone 15 / iOS 26.6 / 微信基础库 3.17.3 的真机自检报告。
 *
 * 为什么值得固化成测试：
 *   第一版自检把「帧应为 2048 字节、间隔应为 64ms」写死，
 *   于是这份完全正常的真实数据被误判成两项失败 ——
 *   实际设备回的是 4096 字节 / 137ms，两者自洽，音频完全正确。
 *   这个测试锁住「以自洽性判定」这个结论，防止有人再改回硬编码期望值。
 */

/** 复现 iPhone 15 的那次录音：37 帧，正文帧 4096 字节，间隔 ~137ms */
function iphone15Samples(): FrameSample[] {
  const out: FrameSample[] = []
  let t = 1_700_000_000_000
  // 36 个正文帧 + 1 个被截断的末帧，间隔在 137ms 附近抖动
  const intervals = [137, 136, 138, 137, 137, 139, 135, 137, 137, 136,
                     138, 137, 137, 136, 137, 139, 135, 137, 137, 137,
                     136, 138, 137, 137, 136, 137, 139, 135, 137, 137,
                     137, 136, 138, 137, 137, 136]
  for (let i = 0; i < 36; i++) {
    out.push({ bytes: 4096, t })
    t += intervals[i] ?? 137
  }
  out.push({ bytes: 2264, t })
  return out
}

describe('computeFrameStats —— iPhone 15 真实数据', () => {
  const s = computeFrameStats(iphone15Samples())

  it('识别出 37 帧，且帧大小众数是 4096（不是我们请求的 2048）', () => {
    expect(s.count).toBe(37)
    expect(s.frameBytes).toBe(4096)
    // 末帧被截断，不计入众数
    expect(s.lastFrameBytes).toBe(2264)
    expect(s.frameBytesStability).toBe(1)
  })

  it('帧间隔 P50 落在 137ms 附近', () => {
    expect(s.intervalP50).toBeGreaterThan(130)
    expect(s.intervalP50).toBeLessThan(145)
  })

  it('⭐ 音频速率判定为通过（16kHz 单声道）—— 这才是判断音频对不对的关键项', () => {
    const j = judgeAudioRate(s.sampleRateTimesChannels)
    expect(j.pass).toBe(true)
    expect(j.verdict).toContain('16kHz 单声道')
  })

  it('⭐ 帧间隔与帧大小自洽 —— 旧版拿 64ms 硬套才会误判失败', () => {
    expect(s.impliedFrameMs).toBeGreaterThan(120)
    expect(s.impliedFrameMs).toBeLessThan(145)
    expect(isIntervalConsistent(s.intervalP50, s.impliedFrameMs)).toBe(true)
  })

  it('帧完整性：帧数 × 帧大小 ≈ 总字节数（说明没丢帧）', () => {
    const integrity = (s.count * s.frameBytes) / s.totalBytes
    expect(integrity).toBeGreaterThan(0.85)
    expect(integrity).toBeLessThan(1.15)
  })

  it('回归：若按「分析帧 64ms」硬套，就会得出不一致的错误结论', () => {
    // 这条断言是反例：证明旧判据为什么会误判
    expect(isIntervalConsistent(s.intervalP50, 64)).toBe(false)
  })
})

describe('judgeAudioRate —— 三种典型故障', () => {
  it('16000 → 16kHz 单声道，通过', () => {
    expect(judgeAudioRate(16000).pass).toBe(true)
  })

  it('32000 → 双声道，不通过（numberOfChannels 未生效）', () => {
    const j = judgeAudioRate(32000)
    expect(j.pass).toBe(false)
    expect(j.verdict).toContain('双声道')
  })

  it('8000 → 采样率 8kHz，不通过（sampleRate 未生效）', () => {
    const j = judgeAudioRate(8000)
    expect(j.pass).toBe(false)
    expect(j.verdict).toContain('8kHz')
  })

  it('完全对不上的值 → 无法判定（而不是硬判失败）', () => {
    expect(judgeAudioRate(12345).pass).toBe(null)
    expect(judgeAudioRate(0).pass).toBe(null)
    expect(judgeAudioRate(Number.NaN).pass).toBe(null)
  })
})

describe('computeFrameStats —— 边界情况', () => {
  it('没有帧时全部为 0，不抛异常', () => {
    const s = computeFrameStats([])
    expect(s.count).toBe(0)
    expect(s.frameBytes).toBe(0)
    expect(s.bytesPerSec).toBe(0)
    expect(judgeAudioRate(s.sampleRateTimesChannels).pass).toBe(null)
  })

  it('只有 1 帧时无法算间隔，回落到兜底值', () => {
    const s = computeFrameStats([{ bytes: 4096, t: 1000 }], 4096, 5000)
    expect(s.count).toBe(1)
    expect(s.intervalP50).toBe(0)
    expect(s.totalBytes).toBe(4096)
    expect(s.spanMs).toBe(5000)
    expect(s.frameBytes).toBe(4096)
  })

  it('帧大小不稳定时稳定性下降（可用于识别异常）', () => {
    const s = computeFrameStats([
      { bytes: 4096, t: 0 },
      { bytes: 4096, t: 137 },
      { bytes: 1024, t: 274 },
      { bytes: 8192, t: 411 },
      { bytes: 500, t: 548 },
    ])
    expect(s.frameBytesStability).toBeLessThan(0.9)
  })
})
