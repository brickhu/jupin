import { describe, expect, it } from 'vitest'

import { frameKindOf, pcmFrameToSamples } from './frame-decode'

/**
 * ⚠️⚠️ **这两个函数被 `1547759` 删过，2026-10-10 恢复** ✗
 *
 *    恢复的理由：⭐ 帧里装什么**不取决于我们的代码** ✗，取决于 `RecorderManager`：
 *      ⭐ `format:'PCM'` ⇒ ⭐ **无头裸 PCM**（⭐ `37e6a31` 的真机实测 ✓）
 *      ⚠️ `format:'mp3'` ⇒ ⚠️ mp3 分片（⭐ 真机上 `decodeAudioData` 能解 ✓）
 *    ⚠️ 只留解码那条时，裸 PCM 帧会**硬解失败** ⇒ ⭐ 拿不到采样 ⇒
 *       ⚠️ **VAD 完全不动 ⇒ 读完不停** ✓✓
 */

/** ⭐ 造一段 16bit 小端 PCM */
function pcmBytes(values: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(values.length * 2)
  const view = new DataView(buf)
  values.forEach((v, i) => view.setInt16(i * 2, v, true))
  return buf
}

describe('pcmFrameToSamples —— 裸 PCM 帧直读（不用解码器）', () => {
  it('⭐ 16bit 小端 → -1..1 的采样', () => {
    const s = pcmFrameToSamples(pcmBytes([0, 16384, -16384, 32767]))
    expect(s[0]).toBeCloseTo(0, 6)
    expect(s[1]).toBeCloseTo(0.5, 4)
    expect(s[2]).toBeCloseTo(-0.5, 4)
    // ⚠️ 除以 32768：32767 ⇒ 0.99997，不会越界到 1.0
    expect(s[3]).toBeLessThan(1)
    expect(s[3]).toBeGreaterThan(0.999)
  })

  it('⚠️ 奇数长度时丢掉最后那个不完整的字节（不能越界读）', () => {
    const odd = new ArrayBuffer(5)
    new DataView(odd).setInt16(0, 100, true)
    expect(pcmFrameToSamples(odd)).toHaveLength(2) // 5 字节 ⇒ 2 个 16bit
  })

  it('空帧 ⇒ 空采样（不是崩溃）', () => {
    expect(pcmFrameToSamples(new ArrayBuffer(0))).toHaveLength(0)
  })

  it('⭐ −32768 映射到 −1.0（下界不越界）', () => {
    expect(pcmFrameToSamples(pcmBytes([-32768]))[0]).toBeCloseTo(-1, 6)
  })
})

describe('frameKindOf —— 按魔法字节判这帧是什么', () => {
  it('⭐ 无头裸 PCM ⇒ pcm', () => {
    // ⚠️ sniffAudioContainer 的兜底值就是 raw-pcm
    expect(frameKindOf(pcmBytes([1, 2, 3, 4]))).toBe('pcm')
    expect(frameKindOf(new ArrayBuffer(0))).toBe('pcm')
  })

  it('⭐ 带头部的容器（WAV / OGG）⇒ container', () => {
    // RIFF....WAVE
    const wav = new Uint8Array(16)
    wav.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
    wav.set([0x57, 0x41, 0x56, 0x45], 8) // 'WAVE'
    expect(frameKindOf(wav.buffer)).toBe('container')

    const ogg = new Uint8Array(8)
    ogg.set([0x4f, 0x67, 0x67, 0x53], 0) // 'OggS'
    expect(frameKindOf(ogg.buffer)).toBe('container')
  })
})
