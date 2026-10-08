/**
 * ⭐ align.ts 的行为测试 —— ⚠️ 它整文件豁免了类型检查（见文件头 ✓）
 *    ⇒ ⭐【正确性靠这里兜】✓ 这是那个豁免的代价对应的补偿 ✓
 */
import { describe, expect, it } from 'vitest'
import { alignFreeEnd, features } from './align'

/** 造一段假的"语音"：几个不同频率的音节，段间有停顿 ✓ */
function fakeSpeech(segs: { hz: number; ms: number }[], sr = 16000): Float32Array {
  const out: number[] = []
  for (const { hz, ms } of segs) {
    const n = Math.round((ms / 1000) * sr)
    for (let i = 0; i < n; i++) out.push(Math.sin((2 * Math.PI * hz * i) / sr) * 0.4)
  }
  return Float32Array.from(out)
}

const SPEECH = [
  { hz: 220, ms: 300 },
  { hz: 330, ms: 300 },
  { hz: 440, ms: 300 },
  { hz: 550, ms: 300 },
]

describe('features —— MFCC 特征', () => {
  it('帧数 = (样本数 - 400) / 160 + 1', () => {
    const f = features(fakeSpeech(SPEECH))
    const expected = Math.floor((16000 * 1.2 - 400) / 160) + 1
    expect(f.T).toBe(expected)
    expect(f.cep.length).toBe(expected * 13)
    expect(f.logE.length).toBe(expected)
  })

  it('静音的能量低于语音（⭐ VAD 靠它判有没有说话 ✓）', () => {
    const silence = features(new Float32Array(16000))
    const speech = features(fakeSpeech(SPEECH))
    const avg = (a: Float64Array) => Array.from(a).reduce((s, v) => s + v, 0) / a.length
    expect(avg(silence.logE)).toBeLessThan(avg(speech.logE))
  })
})

describe('⭐ alignFreeEnd —— 端点自由的对齐', () => {
  const std = features(fakeSpeech(SPEECH))
  const stdDurMs = 1200

  it('⭐ 同一段音频自己对自己 ⇒ 终点落在最后', () => {
    const user = features(fakeSpeech(SPEECH))
    const { endFrame } = alignFreeEnd(std.cep, std.T, user.cep, user.T)
    expect(endFrame).toBeGreaterThan(std.T * 0.8)
  })

  it('⭐⭐ **终点随音频变长而单调不减**（⭐ 这条保证"高亮不会回跳" ✓）', () => {
    const full = fakeSpeech(SPEECH)
    let prev = -1
    for (const frac of [0.3, 0.5, 0.7, 0.9, 1.0]) {
      const part = full.subarray(0, Math.round(full.length * frac))
      const uf = features(part)
      // ⭐ 把上一次的位置当单调下界传进去 ✓（⭐ 算法本身不保证 ✓ 见它的头注释 ✓）
      const { endFrame } = alignFreeEnd(std.cep, std.T, uf.cep, uf.T, 0.35, Math.max(0, prev))
      expect(endFrame).toBeGreaterThanOrEqual(prev)
      prev = endFrame
    }
    // ⭐ 而且读完时必须基本走到底 ✓
    expect(prev).toBeGreaterThan(std.T * 0.7)
  })

  it('⚠️ 只读了一小半时，终点不该冲到结尾（⭐ 这是固定端点 DTW 会犯的错 ✓）', () => {
    const full = fakeSpeech(SPEECH)
    const part = full.subarray(0, Math.round(full.length * 0.35))
    const uf = features(part)
    const { endFrame } = alignFreeEnd(std.cep, std.T, uf.cep, uf.T)
    expect(endFrame).toBeLessThan(std.T * 0.8)
  })
})
