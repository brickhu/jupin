import { describe, it, expect } from 'vitest'
import { sniffAudioContainer, PCM_BYTES_PER_SEC } from './audio'

const bytes = (...vals: number[]): Uint8Array => new Uint8Array(vals)
const ascii = (s: string, total = 12): Uint8Array => {
  const out = new Uint8Array(total)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

describe('sniffAudioContainer —— 只认 magic，不猜', () => {
  /**
   * ⭐ 这条是**实测数据**的回归。
   * 开发者工具真实产出的录音前 12 字节：
   *   1a45 dfa3 9f42 8681 0142 f781 0142 f281
   * 它被当成裸 PCM 喂给讯飞，就是「本地录音 → 提交打分跑不通」的根因。
   */
  it('⭐ 开发者工具的真实录音头（EBML）→ webm', () => {
    expect(
      sniffAudioContainer(
        bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81),
      ),
    ).toBe('webm')
  })

  it('RIFF / OggS / fLaC / ID3 / ftyp 各归各的', () => {
    expect(sniffAudioContainer(ascii('RIFF____WAVE'))).toBe('wav')
    expect(sniffAudioContainer(ascii('OggS________'))).toBe('ogg')
    expect(sniffAudioContainer(ascii('fLaC________'))).toBe('flac')
    expect(sniffAudioContainer(ascii('ID3_________'))).toBe('mp3')

    const mp4 = new Uint8Array(12)
    mp4.set([0, 0, 0, 0x20], 0)
    mp4.set([0x66, 0x74, 0x79, 0x70], 4) // 'ftyp'
    expect(sniffAudioContainer(mp4)).toBe('mp4')
  })

  it('⭐ 裸 PCM（真机链路）不能被误判成容器', () => {
    expect(sniffAudioContainer(new Uint8Array(4096))).toBe('raw-pcm')
    expect(sniffAudioContainer(bytes(0, 0, 0, 0, 1, 0, 0, 0, 0, 0))).toBe('raw-pcm')
  })

  /**
   * ⚠️ 唯一有真实误判风险的一类：裸 PCM 里恰好出现 `FF Ex`。
   *    单看那 11 个 1 分不开 —— `FF FF` 既是合法帧同步、又是最常见的 PCM 负样本（-1）。
   *    所以还要看**下一字节**的位率/采样率索引。
   */
  it('⭐ 裸 PCM 里的 FF FF（样本 -1）必须被挡掉', () => {
    expect(sniffAudioContainer(bytes(0xff, 0xff, 0x00, 0x00, 0, 0, 0, 0))).toBe('raw-pcm')
    expect(sniffAudioContainer(bytes(0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0))).toBe('raw-pcm')
  })

  it('真正的 MPEG 帧同步仍然认得出来', () => {
    // FF FB 90 00 = MPEG-1 Layer III，位率索引 9，采样率索引 0
    expect(sniffAudioContainer(bytes(0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0))).toBe('mp3')
  })

  it('ADTS AAC 单独归类（layer 字段恒为 00，不能与 mp3 混为一谈）', () => {
    expect(sniffAudioContainer(bytes(0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0))).toBe('aac')
    expect(sniffAudioContainer(bytes(0xff, 0xf9, 0x50, 0x80, 0, 0, 0, 0))).toBe('aac')
    // 采样率索引 15 = 非法
    expect(sniffAudioContainer(bytes(0xff, 0xf1, 0xfc, 0x80, 0, 0, 0, 0))).toBe('raw-pcm')
  })

  it('保留的版本 / 层 / 索引组合不判成 mp3', () => {
    expect(sniffAudioContainer(bytes(0xff, 0x07, 0x90, 0, 0, 0, 0, 0))).toBe('raw-pcm') // version=保留
    expect(sniffAudioContainer(bytes(0xff, 0xfb, 0xf0, 0, 0, 0, 0, 0))).toBe('raw-pcm') // 位率=15 非法
    expect(sniffAudioContainer(bytes(0xff, 0xfb, 0x0c, 0, 0, 0, 0, 0))).toBe('raw-pcm') // 位率=0 free
    expect(sniffAudioContainer(bytes(0xff, 0xeb, 0x94, 0, 0, 0, 0, 0))).toBe('raw-pcm') // Layer II
  })

  it('太短的数据不崩，一律当裸 PCM', () => {
    expect(sniffAudioContainer(new Uint8Array(0))).toBe('raw-pcm')
    expect(sniffAudioContainer(bytes(0x1a))).toBe('raw-pcm')
    expect(sniffAudioContainer(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('raw-pcm')
  })
})

describe('PCM_BYTES_PER_SEC', () => {
  it('16kHz × 16bit × 单声道 = 32000 字节/秒', () => {
    expect(PCM_BYTES_PER_SEC).toBe(32000)
  })

  it('实测的 8.82 秒解码结果 → 282240 字节（与 ffmpeg 实际输出一致）', () => {
    expect(8.82 * PCM_BYTES_PER_SEC).toBeCloseTo(282240, 0)
  })
})
