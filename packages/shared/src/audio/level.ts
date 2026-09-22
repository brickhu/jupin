/**
 * ⭐ 从一段采样里取「波形」和「强度」—— 纯函数，能在 Node 里单测。
 *
 * ⚠️ 为什么单独抽出来：实时波形这条路有两个数据来源，而它们给出的东西不同 ——
 *    · 平台解码器（wx.createWebAudioContext().decodeAudioData）解出来的**是采样**；
 *    · 有的设备/格式本来就是裸 PCM，按 16bit 读**也是采样**。
 *    两边都要走到「每根柱子多高」这一步，所以这一步必须是**同一份实现**，
 *    而且必须能脱开小程序环境测（音频在小程序里调试极其痛苦）。
 */

/**
 * 16bit **小端**裸 PCM → -1..1 的浮点采样。
 * ⚠️ 字节序写死小端：帧的字节序由 lib/audio/recorder.ts 判断并归一化，
 *    真机实测出现过大端设备 —— 那时按小端读会得到一条满量程的噪声，
 *    看起来像波形坏了。归一化放在上游做，这里不猜。
 */
export function samplesFromPcm16(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = bytes[i * 2] as number
    const hi = bytes[i * 2 + 1] as number
    const v = (hi << 8) | lo
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768
  }
  return out
}

/**
 * AnalyserNode.getByteTimeDomainData 给的 0..255（128 = 静音）→ -1..1。
 * ⚠️ 这是那条「解码之后接 analyser」的路用的（见 lib/audio/frame-decode.ts）。
 */
export function samplesFromByteTimeDomain(bytes: Uint8Array | Uint8ClampedArray): Float32Array {
  const out = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = ((bytes[i] as number) - 128) / 128
  return out
}

/**
 * ⭐ 峰值柱：把采样切成 barCount 段，每段取**绝对值峰值**（0..1）。
 *
 * ⚠️ 取峰值而不是均值：均值会把爆破音抹平，看起来像音量一直很小 ——
 *    而用户盯着这条波形就是要看「我声音够不够大」。
 * ⚠️ 采样数少于柱数时返回空数组（调用方据此不画）—— 硬画会得到一排等高的柱子，
 *    那比不画更像坏了。
 */
export function peakBars(samples: ArrayLike<number>, barCount: number): number[] {
  const total = samples.length
  if (total === 0 || barCount <= 0 || total < barCount) return []
  const bars: number[] = []
  for (let i = 0; i < barCount; i++) {
    const from = Math.floor((i * total) / barCount)
    const to = Math.max(from + 1, Math.floor(((i + 1) * total) / barCount))
    let peak = 0
    for (let s = from; s < to && s < total; s++) {
      const v = Math.abs(samples[s] as number)
      if (v > peak) peak = v
    }
    bars.push(peak > 1 ? 1 : peak)
  }
  return bars
}

/**
 * ⭐ 0–100 的**音频强度** —— 峰峰值占满量程的百分比。
 *
 * ⚠️ 公式取自那个已经被验证过的实现（掘金《微信小程序实现实时录音音频强度输出》）：
 *    他们用 0..255 的时域数据算 (max-min)/128*100/2，
 *    换成 -1..1 的采样就是 (max-min)/2*100 —— 同一个东西。
 * ⚠️ 拿不到采样（长度为 0）时给 0，不要给「一点底噪」：0 是「没声音」这个事实。
 */
export function intensityOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let max = -1
  let min = 1
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number
    if (v > max) max = v
    if (v < min) min = v
  }
  const i = ((max - min) / 2) * 100
  return i < 0 ? 0 : i > 100 ? 100 : i
}
