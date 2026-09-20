/**
 * 采样率归一化 —— 纯函数，零平台依赖（可在 Node 里单测）。
 *
 * ⚠️⚠️ 这个文件存在的理由：
 *   小程序录音 API 的 sampleRate 参数只是**请求值，不是契约**。
 *   真机自检（T3+T4）实测到 8400（= 8kHz 单声道）—— 我们请求 16000 却没生效。
 *   而这条链路对采样率**处处敏感**：
 *     · 讯飞 ISE 硬要求 16kHz，喂 8kHz 会被当"语速减半"判成乱读
 *     · 服务端用「字节数 ÷ 32000」算时长，8kHz 时直接翻倍
 *     · 端侧 VAD 用固定的 64ms 分析帧计时，8kHz 时语音时长被算成一半
 *
 *   所以**不能假设采样率**，只能从「字节数 + 时长」反推，再把音频归一化到 16kHz。
 *   ⭐ 关键性质：设备本来就是 16kHz 时，这里是**恒等变换**（不做任何事）——
 *      也就是说这段代码在两种情况下都做对的事，不依赖任何一侧的判断。
 */
import { pcmInt16ToFloat32, float32ToPcmInt16, type PcmByteOrder } from './wav'

/**
 * 小程序 RecorderManager 文档允许的采样率全集。
 * ⚠️ 反推出来的值只能吸附到这些档位上；不落在任何档位附近就认为「测不准」，
 *    宁可不重采样（保持原样），也不要按一个瞎猜的比例把音频毁掉。
 */
export const KNOWN_SAMPLE_RATES = [
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
] as const

/**
 * 由「字节数 ÷ 时长」反推真实采样率。
 *
 * 录音 API 从头到尾不会告诉我们它到底用了多少采样率，只能这样算。
 *
 * @param bytes    这段时间内的总字节数
 * @param durationMs 这段时间的毫秒数
 * @param channels 声道数（我们请求 1）
 * @param bitDepth 位深（我们请求 16）
 * @returns 采样率估计值；无法计算时返回 0
 */
export function estimateSampleRate(
  bytes: number,
  durationMs: number,
  channels = 1,
  bitDepth = 16,
): number {
  if (!(bytes > 0) || !(durationMs > 0) || !(channels > 0) || !(bitDepth > 0)) return 0
  const bytesPerSec = (bytes / durationMs) * 1000
  return (bytesPerSec * 8) / (channels * bitDepth)
}

/**
 * ⭐ 从**「帧字节数 + 到达时刻」序列**反推采样率。
 *
 * ⚠️⚠️ 这里有一个**必须记住的 off-by-one**，它真实地毁掉过一次真机录音：
 *
 *    速率 = 字节数 ÷ 时间跨度。而 `spanMs = t_last - t_first` 覆盖的是
 *    「第一帧**之后**」那段时间 —— 第一帧本身录的是 t1 **之前**的音频。
 *    所以分子**绝不能包含第一帧**，否则字节率会系统性偏高约一倍。
 *
 *    实测后果（iPhone，帧 4096 字节、间隔 137ms）：
 *      含第一帧：8192 / 137ms → 29898 B/s → 吸附成 **32000Hz**（实际是 16000）
 *      不含第一帧：4096 / 137ms → 14949 B/s → 吸附成 **16000Hz** ✅
 *    于是 16kHz 的音频被"重采样"成一半长度 —— 试听快一倍、高一个八度，
 *    听起来**根本不像本人的声音**。而这条链路只在真机上跑得到，
 *    模拟器里给的是 Opus 裸包，谁都不会去听。
 *
 * @returns 吸附后的档位；测不准（不在任何档位附近）时返回 0
 */
export function estimateSampleRateFromFrames(
  frames: { bytes: number; t: number }[],
  channels = 1,
  bitDepth = 16,
): number {
  if (frames.length < 2) return 0
  const first = frames[0] as { bytes: number; t: number }
  const last = frames[frames.length - 1] as { bytes: number; t: number }
  // ⭐ 分子只取第 2 帧起 —— 见上面那段
  const bytes = frames.slice(1).reduce((n, f) => n + f.bytes, 0)
  const spanMs = last.t - first.t
  return snapSampleRate(estimateSampleRate(bytes, spanMs, channels, bitDepth))
}

/**
 * 把采样率估计值吸附到最接近的合法档位。
 *
 * @param tolerance 允许的相对偏差，默认 0.08（±8%）。
 *        ⚠️ 放宽一点是必要的：帧回调和计时精度都会让实测值偏个百分之几
 *        （真机实测 16801 字节/秒 → 8400，距 8000 偏 5%）。
 * @returns 吸附后的档位；偏差过大（测不准）时返回 0
 */
export function snapSampleRate(estimate: number, tolerance = 0.08): number {
  if (!(estimate > 0) || !Number.isFinite(estimate)) return 0
  let best: number = KNOWN_SAMPLE_RATES[0]
  for (const r of KNOWN_SAMPLE_RATES) {
    if (Math.abs(r - estimate) < Math.abs(best - estimate)) best = r
  }
  return Math.abs(best - estimate) / best <= tolerance ? best : 0
}

/**
 * 线性插值重采样（单声道浮点）。
 *
 * ⭐ 为什么线性插值就够了：升采样时原始信号带宽本来就 ≤ fromRate/2，
 *    线性插值的频响损失集中在高频端，对 VAD / 基频 / 讯飞评分都无实质影响，
 *    而它零依赖、O(n)、易于在 Node 里验证。
 *
 * ⚠️ fromRate === toRate 时**原样返回入参**（同一个引用）——
 *    这是"16kHz 设备上等于什么都没做"的保证。
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0) || fromRate === toRate || input.length === 0) return input

  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const ratio = fromRate / toRate
  const out = new Float32Array(outLen)
  const last = input.length - 1

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.min(last, Math.floor(pos))
    const i1 = Math.min(last, i0 + 1)
    const frac = pos - i0
    out[i] = (input[i0] as number) * (1 - frac) + (input[i1] as number) * frac
  }
  return out
}

/**
 * 16bit 单声道裸 PCM 的采样率归一化。
 *
 * ⚠️ fromRate === toRate（或 fromRate 未知）时原样返回入参 —— 恒等变换。
 */
export function normalizePcmRate(
  pcm: Uint8Array,
  fromRate: number,
  toRate: number,
  sourceOrder: PcmByteOrder = 'le',
): Uint8Array {
  // ⚠️ 恒等变换只有在「采样率一致 **且** 字节序已经是小端」时才成立 ——
  //    字节序是大端时必须走一遍，把数据**归一化成小端**（下游一律按小端处理）
  if (!(fromRate > 0) || !(toRate > 0)) return pcm
  if (fromRate === toRate && sourceOrder === 'le') return pcm
  return float32ToPcmInt16(resampleLinear(pcmInt16ToFloat32(pcm, sourceOrder), fromRate, toRate))
}
