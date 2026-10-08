/**
 * ⭐ **实时波形的数据整形** —— 把一帧的采样压成"几根柱子"。
 *
 * ⚠️ 画图（canvas）在页面里，这里只做**纯计算** —— 因为它有边界要守
 *    （采样比柱子少、采样比柱子多、空帧、柱子数为 0…），而 canvas 上测不了这些 ✓
 *
 * ⚠️ 用**峰值**（每一段里绝对值最大的那个）而不是均值：
 *    一段语音里绝大多数点都接近 0，均值会把所有柱子压成一条线 ✗
 *    峰值画出来才是"说话时的起伏" ✓
 */
export function peakBars(samples: Float32Array | null, barCount: number): number[] {
  if (!samples || samples.length === 0 || barCount <= 0) return []

  const out = new Array<number>(barCount).fill(0)
  for (let i = 0; i < samples.length; i++) {
    /**
     * ⚠️ 分桶要**按比例缩放**（i * barCount / length）而不是 i % barCount：
     *    后者会让相邻的柱子来自采样里相隔很远的两个位置，波形看起来是噪声 ✗
     * ⚠️ 最后 min(barCount-1, …) 是必需的：i = length-1 时算出来正好是 barCount，
     *    越界会写到一个不存在的格子上（静默丢掉 + 数组变长）✗
     */
    const bucket = Math.min(barCount - 1, Math.floor((i * barCount) / samples.length))
    const v = Math.abs(samples[i] ?? 0)
    if (v > (out[bucket] ?? 0)) out[bucket] = v
  }
  return out
}

/**
 * ⭐⭐ **波形用的自动增益** —— 让柱子"撑满"那条 64rpx 的带子。
 *
 * ## 为什么需要它
 *
 * 人说话的音量，峰值通常只到满量程的 **0.2~0.5**（`peakBars` 给的是 0..1）——
 * 照原样画，柱子只有半高的两三成，看着像"没在收音" ✗
 * （用户真机实测反馈：**其它都对，就是幅度不够** ✓）
 *
 * ## ⚠️⚠️ 它**只作用于画图**，绝不能碰静音判据
 *
 * `vad.ts` 的 `SILENCE_RMS = 0.02` 是一个**绝对**阈值 ✓
 * 一旦把增益套到判据上，"放大静音"会让它**永远判不出静音** ⇒ 永不自动结束 ✗✗
 * ⇒ 所以：**判据吃原始采样，画图吃增益后的柱子** ✓ 两条路严格分开 ✓
 *
 * ## 做法
 *
 * 记住"**这一轮见过的最强音**"（峰值），把它当成满格 ✓
 *   · 上去得**快**（立刻采纳更大的峰值）—— 不然第一声会被画得很小 ✗
 *   · 下来得**慢**（慢慢衰减）—— 不然说完一句、停顿一下，
 *     下一次开口会因为"基准被静音拉低"而**突然撑满**，看起来一跳一跳的 ✗
 *   · 有个**下限**（`WAVE_MIN_PEAK`）：很安静时不再放大，
 *     否则会把底噪也放大成满格噪声 ✗
 */
export const WAVE_MIN_PEAK = 0.04
/** 每帧的衰减系数（帧间隔约 170ms ⇒ 约 3 秒掉一半，慢到看不出台阶） */
export const WAVE_DECAY = 0.97

export interface WaveGain {
  /** 当前用作"满格"的峰值 */
  peak: number
}

export const WAVE_GAIN_ZERO: WaveGain = { peak: WAVE_MIN_PEAK }

/** ⭐ 吃进这一帧的柱子，吐出新的增益状态（纯函数） */
export function advanceWaveGain(g: WaveGain, bars: number[]): WaveGain {
  let observed = 0
  for (const b of bars) if (b > observed) observed = b
  // 上去快、下来慢，且不低于下限
  return { peak: Math.max(WAVE_MIN_PEAK, Math.max(observed, g.peak * WAVE_DECAY)) }
}

/**
 * ⭐ 按增益把柱子缩放到 0..1（纯函数）。
 * ⚠️ 结果**夹到 1**：峰值那一帧自己会算出正好 1.0，超过就是浮点误差 ✓
 */
export function applyWaveGain(bars: number[], g: WaveGain): number[] {
  const peak = Math.max(WAVE_MIN_PEAK, g.peak)
  return bars.map((b) => Math.min(1, b / peak))
}
