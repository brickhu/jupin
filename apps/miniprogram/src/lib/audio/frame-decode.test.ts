import { describe, expect, it } from 'vitest'

import { pcmFrameToSamples } from './frame-decode'


describe('pcmFrameToSamples —— 裸 PCM 帧（不用 decodeAudioData）', () => {
  /** 造一帧：把一组 -1..1 的值写成 16bit 小端 */
  function frameOf(values: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(values.length * 2)
    const view = new DataView(buf)
    // ⚠️ 必须夹到 Int16 的范围：1.0 × 32768 = 32768 会**溢出**成 -32768 ✗
    values.forEach((v, i) =>
      view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true),
    )
    return buf
  }

  it('⭐ 读回来的值与写进去的一致（16bit 量化误差之内）', () => {
    const s = pcmFrameToSamples(frameOf([0, 0.5, -0.5, 1, -1]))
    expect(s).toHaveLength(5)
    expect(s[0]).toBeCloseTo(0, 5)
    expect(s[1]).toBeCloseTo(0.5, 3)
    expect(s[2]).toBeCloseTo(-0.5, 3)
    expect(s[3]).toBeCloseTo(1, 3)
    // ⚠️ -1 精确对应 -32768 ⇒ -1.0 ✓（这就是"除以 32768 而不是 32767"的原因）
    expect(s[4]).toBeCloseTo(-1, 5)
    // ⚠️ 上界是 +32767（取不到 +32768）⇒ 正满量程读回来是 0.99997，**略小于 1** ✓
    //    这不是 bug：16bit 有符号的正负不对称，除以 32768 才不会越界 ✓
    expect(s[3]).toBeLessThan(1)
  })

  it('⚠️ 小端：字节序反了会读出完全不同的值', () => {
    const buf = new ArrayBuffer(2)
    new DataView(buf).setInt16(0, 0x0102, true) // 小端 ⇒ 字节是 02 01
    const bytes = new Uint8Array(buf)
    expect(bytes[0]).toBe(0x02)
    expect(pcmFrameToSamples(buf)[0]).toBeCloseTo(0x0102 / 32768, 5)
  })

  it('⚠️ 奇数长度去尾（不留半个采样）', () => {
    const odd = new ArrayBuffer(5)
    const s = pcmFrameToSamples(odd)
    expect(s).toHaveLength(2) // 5 字节 ⇒ 2 个完整采样 ✓
  })

  it('空帧 ⇒ 空数组（调用方据此不画）', () => {
    expect(pcmFrameToSamples(new ArrayBuffer(0))).toHaveLength(0)
  })
})
