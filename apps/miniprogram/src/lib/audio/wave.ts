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
