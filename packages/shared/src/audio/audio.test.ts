import { describe, it, expect } from 'vitest'
import { detectPitch, pitchVariability } from './pitch'
import { detectVad, frameEnergy, zeroCrossingRate } from './vad'
import { dtwDistance, dtwSimilarity } from './dtw'
import { pcmToWav, wavToPcm, pcmInt16ToFloat32, float32ToPcmInt16, frameAudio } from './wav'
import { AUDIO_SPEC, MS_PER_WORD, CONQUEST_THRESHOLD } from '../constants/index'

/**
 * ⭐ 这些测试就是「音频算法必须是纯函数」这条设计约束的价值证明：
 *    不用开小程序、不用真机，在 Node 里毫秒级跑完。
 */
const SR = AUDIO_SPEC.sampleRate

function sine(hz: number, ms: number, amp = 0.5): Float32Array {
  const n = Math.round((ms / 1000) * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return out
}

describe('pitch (YIN)', () => {
  it('能识别 220Hz 正弦波的基频', () => {
    const hz = detectPitch(sine(220, 40), SR)
    expect(hz).toBeGreaterThan(200)
    expect(hz).toBeLessThan(245)
  })

  it('静音帧返回 0（无浊音）', () => {
    expect(detectPitch(new Float32Array(640), SR)).toBe(0)
  })

  it('语调起伏度：平调 < 起伏调', () => {
    const flat = [150, 150, 150, 150, 150]
    const varied = [120, 200, 130, 210, 125]
    expect(pitchVariability(flat)).toBeLessThan(pitchVariability(varied))
  })
})

describe('vad', () => {
  it('语音帧能量显著高于静音帧', () => {
    expect(frameEnergy(sine(200, 40))).toBeGreaterThan(frameEnergy(new Float32Array(640)))
  })

  it('能区分「有声段 + 静音段」', () => {
    const frames = [
      ...frameAudio(sine(200, 400)),
      ...frameAudio(new Float32Array(SR * 0.4)),
    ]
    const vad = detectVad(frames)
    expect(vad.segments.length).toBeGreaterThanOrEqual(1)
    expect(vad.speechRatio).toBeGreaterThan(0.2)
    expect(vad.speechRatio).toBeLessThan(0.9)
  })

  it('纯静音时 speechMs 为 0', () => {
    expect(detectVad(frameAudio(new Float32Array(SR * 0.2))).speechMs).toBe(0)
  })

  it('静音的过零率为 0', () => {
    expect(zeroCrossingRate(new Float32Array(640))).toBe(0)
  })
})

describe('dtw', () => {
  it('相同序列距离为 0', () => {
    const a = [[1, 2], [3, 4], [5, 6]]
    expect(dtwDistance(a, a)).toBeCloseTo(0, 5)
  })

  it('差异越大距离越大', () => {
    const base = [[1, 1], [1, 1], [1, 1]]
    const near = [[1.1, 1.1], [1.1, 1.1], [1.1, 1.1]]
    const far = [[9, 9], [9, 9], [9, 9]]
    expect(dtwDistance(base, near)).toBeLessThan(dtwDistance(base, far))
  })

  it('不等长序列不会病态对齐（Sakoe-Chiba 窗）', () => {
    const a = [[1, 1], [1, 1]]
    const b = Array.from({ length: 6 }, () => [1, 1])
    expect(Number.isFinite(dtwDistance(a, b))).toBe(true)
  })

  it('相似度落在 0–100', () => {
    expect(dtwSimilarity(0)).toBe(100)
    expect(dtwSimilarity(1e6)).toBeLessThan(1)
  })
})

describe('wav 编解码', () => {
  it('PCM → WAV 带正确头部，且能取回裸 PCM', () => {
    const pcm = float32ToPcmInt16(sine(440, 100))
    const wav = new Uint8Array(pcmToWav(pcm, SR))
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    // ⚠️ 讯飞要求去掉 WAV 头，这里验证取回的裸 PCM 长度正确
    expect(wavToPcm(wav).length).toBe(pcm.length)
  })

  it('Int16 → Float32 归一化到 [-1, 1]', () => {
    const f = pcmInt16ToFloat32(new Uint8Array([0x00, 0x80, 0xff, 0x7f]))
    expect(f[0]).toBeCloseTo(-1, 4)
    expect(f[1]).toBeCloseTo(1, 4)
  })
})

describe('constants', () => {
  it('每词毫秒数符合 150wpm 基准', () => {
    expect(MS_PER_WORD).toBeCloseTo(400, 0)
  })
  it('征服阈值为 85', () => {
    expect(CONQUEST_THRESHOLD).toBe(85)
  })
})
