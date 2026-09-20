import { describe, it, expect } from 'vitest'
import { detectPcmByteOrder, pcmInt16ToFloat32, float32ToPcmInt16 } from './wav'

/** 造一段"像语音"的信号：两个低频正弦叠加（过零率很低） */
function speechLike(n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = 0.3 * Math.sin(i * 0.05) + 0.15 * Math.sin(i * 0.013)
  }
  return out
}

/** 把 16bit 样本的字节序翻过来 */
function swapBytes(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(pcm.length)
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    out[i] = pcm[i + 1] as number
    out[i + 1] = pcm[i] as number
  }
  return out
}

describe('detectPcmByteOrder —— 区分「字节序反了」和「真的是噪声」', () => {
  it('正常小端语音 → le（绝不翻转）', () => {
    const pcm = float32ToPcmInt16(speechLike(2048))
    expect(detectPcmByteOrder(pcm)).toBe('le')
  })

  /**
   * ⭐⭐ 这条是核心：把同一段语音的字节序翻过来（模拟"按错字节序读"），
   *    必须能被认出来。
   *
   *    ⚠️ 这个现象曾经被误判成「开发者工具给的是满量程随机噪声」——
   *       因为过零率恰好 0.500、RMS 恰好 -4.8dB（= 1/√3）。
   *       而这两个数**同时也是字节序反了的指纹**。
   */
  it('⭐ 字节序被翻过来的语音 → be', () => {
    const le = float32ToPcmInt16(speechLike(2048))
    const be = swapBytes(le)
    expect(detectPcmByteOrder(be)).toBe('be')
  })

  it('⭐ 翻过来的数据按大端读回来，就是原信号', () => {
    const le = float32ToPcmInt16(speechLike(1024))
    const be = swapBytes(le)
    const back = pcmInt16ToFloat32(be, 'be')
    const orig = pcmInt16ToFloat32(le, 'le')
    for (let i = 0; i < orig.length; i++) {
      expect(back[i]).toBeCloseTo(orig[i] as number, 6)
    }
  })

  it('真·随机字节不会被翻转（保守性：宁可漏判也不误伤）', () => {
    const rnd = new Uint8Array(4096)
    let s = 12345
    for (let i = 0; i < rnd.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      rnd[i] = s & 0xff
    }
    expect(detectPcmByteOrder(rnd)).toBe('le')
  })

  it('太短的数据不判 → le', () => {
    expect(detectPcmByteOrder(new Uint8Array(8))).toBe('le')
    expect(detectPcmByteOrder(new Uint8Array(0))).toBe('le')
  })
})
