/**
 * WAV 编解码 —— 纯函数，零依赖。
 *
 * 背景：小程序 getRecorderManager 以 format:'PCM' 录出的是**裸 PCM**，
 *      没有 WAV 头，InnerAudioContext 无法直接播放。
 *      同时讯飞 ISE 要求"如果用 wav 格式音频，需要去掉头部"。
 */

import { AUDIO_SPEC } from '../constants/index'

/** 给裸 PCM 加上 44 字节 WAV 头（用于本地回放） */
export function pcmToWav(
  pcm: ArrayBuffer | Uint8Array,
  sampleRate: number,
  channels = 1,
  bitDepth = 16,
): ArrayBuffer {
  const pcmBytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const byteRate = (sampleRate * channels * bitDepth) / 8
  const blockAlign = (channels * bitDepth) / 8
  const headerSize = 44
  const buffer = new ArrayBuffer(headerSize + pcmBytes.length)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.length, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)              // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcmBytes.length, true)

  new Uint8Array(buffer, headerSize).set(pcmBytes)
  return buffer
}

/** 从 WAV 中提取裸 PCM（⚠️ 讯飞要求去掉头部；且要兼容非标准头） */
export function wavToPcm(wav: Uint8Array): Uint8Array {
  let offset = 12            // 跳过 RIFF + size + WAVE
  while (offset < wav.length - 8) {
    const id = String.fromCharCode(
      wav[offset] as number, wav[offset + 1] as number,
      wav[offset + 2] as number, wav[offset + 3] as number,
    )
    const size =
      (wav[offset + 4] as number) |
      ((wav[offset + 5] as number) << 8) |
      ((wav[offset + 6] as number) << 16) |
      ((wav[offset + 7] as number) << 24)
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size
  }
  return wav                 // fallback：当作裸 PCM
}

/** Int16 PCM → Float32（[-1, 1]），供音频分析使用 */
export function pcmInt16ToFloat32(pcm: Uint8Array): Float32Array {
  const samples = Math.floor(pcm.length / 2)
  const out = new Float32Array(samples)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

/** Float32（[-1, 1]）→ Int16 PCM */
export function float32ToPcmInt16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/** 按固定帧长切分（默认取 AUDIO_SPEC.frameSamples） */
export function frameAudio(
  samples: Float32Array,
  frameSamples: number = AUDIO_SPEC.frameSamples,
): Float32Array[] {
  const frames: Float32Array[] = []
  for (let i = 0; i + frameSamples <= samples.length; i += frameSamples) {
    frames.push(samples.subarray(i, i + frameSamples))
  }
  return frames
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
