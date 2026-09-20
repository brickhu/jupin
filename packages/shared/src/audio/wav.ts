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

/** 16bit PCM 的字节序 */
export type PcmByteOrder = 'le' | 'be'

/** Int16 PCM → Float32（[-1, 1]），供音频分析使用 */
export function pcmInt16ToFloat32(pcm: Uint8Array, order: PcmByteOrder = 'le'): Float32Array {
  const samples = Math.floor(pcm.length / 2)
  const out = new Float32Array(samples)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const little = order === 'le'
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, little) / 32768
  }
  return out
}

/** 一小段数据的过零率 —— 只用于判断字节序，所以抽样即可 */
function sampleZcr(pcm: Uint8Array, order: PcmByteOrder): number {
  const s = pcmInt16ToFloat32(pcm.subarray(0, Math.min(pcm.length, 4096)), order)
  if (s.length < 2) return 0
  let z = 0
  for (let i = 1; i < s.length; i++) {
    if (((s[i - 1] as number) < 0) !== ((s[i] as number) < 0)) z++
  }
  return z / (s.length - 1)
}

/**
 * ⭐⭐ 判断这段 PCM 该按**哪种字节序**读才像音频。
 *
 * ⚠️⚠️ 为什么需要它 —— 这是一次真实的误判：
 *    开发者工具 `onFrameRecorded` 给的帧被读成 float 后，
 *    过零率恰好 **0.500**、RMS 恰好 **-4.8dB（= 1/√3）**，
 *    于是被判定为"满量程随机噪声，工具没有可用音频"。
 *
 *    但这两个数**同时也是「字节序反了」的指纹**：
 *    16bit 音频若把低位字节当成高位读，低位那点随机性会被放大到整个量程 ——
 *    结果正是 RMS ≈ 1/√3、过零率 ≈ 0.5。真实语音的过零率只有 0.03~0.15。
 *
 *    所以判据是**对比**，不是绝对值：哪种读法像语音就用哪种。
 *
 * ⚠️ 极度保守：**只有在「小端明显不像音频、大端明显像」时才翻转**。
 *    宁可漏判（继续当成噪声），也绝不把本来正确的小端数据改坏 ——
 *    真机链路给的就是小端，判错会把好音频毁掉。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️⚠️ **实测结论：这个假设在开发者工具上被证伪了。**
 *
 *    跑自检量到：两种读法的过零率都是 0.49 —— 大端并不更像语音。
 *    所以那段帧**不是字节序反了的 PCM**，而是真的编码数据：
 *      · 首帧头 43 c6 74 80 …（0x43 是 Opus 包的 TOC 字节）
 *      · 落盘文件 EBML/WebM，Opus 48kHz
 *    ⇒ 工具把同一路 Opus 流的**裸包**当 frameBuffer 回给我们了。
 *
 *    这个函数**仍然保留**：它挡的是另一类真实故障（设备给大端 PCM），
 *    而且它保守 —— 判不出来就不动数据。
 *    留下这段记录，是为了让下一个人不必再试同一个假设。
 */
export function detectPcmByteOrder(pcm: Uint8Array): PcmByteOrder {
  if (pcm.length < 64) return 'le'
  const le = sampleZcr(pcm, 'le')
  const be = sampleZcr(pcm, 'be')
  if (le > 0.4 && be < 0.25) return 'be'
  return 'le'
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
