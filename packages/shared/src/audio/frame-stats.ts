/**
 * 录音回帧统计 —— 纯函数，零平台依赖（可在 Node 里单测）。
 *
 * ⚠️⚠️ 这个文件的存在本身就是一次教训的产物。
 *
 * 真机自检的第一版把「帧应为 2048 字节、间隔应为 64ms」写死在判定里，
 * 结果在 iPhone 15 上误报两项失败 —— 实际设备回的是 4096 字节 / 137ms，
 * 两者完全自洽，音频本身完全正确。
 *
 * **设备回多大一块不由我们决定**（frameSize 只是请求值），
 * 所以判定只能基于**实测数据内部的自洽性**，不能基于人为预设。
 * 抽成纯函数是为了能拿真实设备数据做回归测试（见 audio.test.ts）。
 */

export interface FrameSample {
  /** 该帧的字节数（frameBuffer.byteLength） */
  bytes: number
  /** 回调到达时刻（Date.now()） */
  t: number
}

export interface FrameStats {
  count: number
  /** 众数帧字节数（**已排除末帧** —— 末帧通常被截断而偏小） */
  frameBytes: number
  /** 众数占正文帧的比例，越接近 1 说明帧大小越稳定 */
  frameBytesStability: number
  lastFrameBytes: number
  intervalP50: number
  intervalMin: number
  intervalMax: number
  totalBytes: number
  spanMs: number
  /** 近似每秒字节数。⚠️ 分子含全部帧、分母只覆盖 (count-1) 个间隔，故略微偏高 */
  bytesPerSec: number
  /** 采样率 × 声道数（= bytesPerSec ÷ 2，16bit）。本项目应为 16000 */
  sampleRateTimesChannels: number
  /** 由实测字节率推出的「每帧时长」——与 intervalP50 对比即可验自洽 */
  impliedFrameMs: number
}

/** 取分位数。⚠️ 入参必须是**已升序排序**的数组 */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function mode(values: number[]): { value: number; count: number } {
  const hist = new Map<number, number>()
  for (const v of values) hist.set(v, (hist.get(v) ?? 0) + 1)
  let best = { value: 0, count: 0 }
  for (const [value, count] of hist) if (count > best.count) best = { value, count }
  return best
}

/**
 * 从 onFrameRecorded 的回调样本算出全部派生量。
 *
 * @param samples 每帧的 {字节数, 到达时刻}
 * @param fallbackBytes 帧不足 2 个时的兜底总字节数
 * @param fallbackMs 帧不足 2 个时的兜底时长
 */
export function computeFrameStats(
  samples: FrameSample[],
  fallbackBytes = 0,
  fallbackMs = 0,
): FrameStats {
  const count = samples.length
  const sizes = samples.map((s) => s.bytes)
  const body = sizes.slice(0, Math.max(1, count - 1))
  const frameMode = mode(body)

  const intervals: number[] = []
  for (let i = 1; i < count; i++) {
    intervals.push((samples[i] as FrameSample).t - (samples[i - 1] as FrameSample).t)
  }
  const sortedIv = [...intervals].sort((a, b) => a - b)

  const spanMs =
    count >= 2 ? (samples[count - 1] as FrameSample).t - (samples[0] as FrameSample).t : fallbackMs
  const totalBytes = count >= 2 ? sizes.reduce((a, b) => a + b, 0) : fallbackBytes
  const bytesPerSec = spanMs > 0 ? (totalBytes / spanMs) * 1000 : 0

  return {
    count,
    frameBytes: frameMode.value,
    frameBytesStability: body.length > 0 ? frameMode.count / body.length : 0,
    lastFrameBytes: sizes[count - 1] ?? 0,
    intervalP50: percentile(sortedIv, 0.5),
    intervalMin: sortedIv[0] ?? 0,
    intervalMax: sortedIv[sortedIv.length - 1] ?? 0,
    totalBytes,
    spanMs,
    bytesPerSec,
    sampleRateTimesChannels: bytesPerSec / 2,
    impliedFrameMs: bytesPerSec > 0 ? (frameMode.value / bytesPerSec) * 1000 : 0,
  }
}

/**
 * 判定「音频速率」对不对 —— 这是判断音频是否可用的**关键项**。
 *
 * 录音 API 不直接给出采样率和声道数，只能反推出二者之积：
 *   每秒字节数 ÷ 2（16bit）= 采样率 × 声道数
 *
 * ⚠️ 只能测出乘积，单靠这一项无法区分「16k 双声道」和「32k 单声道」。
 *    要进一步确认需用 1kHz 标准音做精测。
 */
export function judgeAudioRate(sampleRateTimesChannels: number): {
  pass: boolean | null
  verdict: string
} {
  const v = sampleRateTimesChannels
  if (!Number.isFinite(v) || v <= 0) return { pass: null, verdict: '无法判定' }
  if (Math.abs(v - 16000) < 1600) {
    return { pass: true, verdict: '16kHz 单声道，与引擎要求一致' }
  }
  if (Math.abs(v - 32000) < 3200) {
    return { pass: false, verdict: '16kHz 双声道 —— numberOfChannels:1 未生效，引擎会判格式不符' }
  }
  if (Math.abs(v - 8000) < 800) {
    return { pass: false, verdict: '采样率实际是 8kHz —— sampleRate:16000 未生效' }
  }
  return { pass: null, verdict: `${Math.round(v)} —— 不在任何预期值附近，需人工判断` }
}

/**
 * 判定帧间隔与帧大小是否**自洽**。
 *
 * ⚠️ 刻意不比对某个绝对值：帧越大间隔就越长，两者只需对得上。
 *    按「分析帧 64ms」去套会误判 —— 第一版就是这么错的。
 *
 * @param tolerance 允许的相对偏差，默认 0.3（±30%）
 */
export function isIntervalConsistent(
  intervalP50: number,
  impliedFrameMs: number,
  tolerance = 0.3,
): boolean {
  if (!(impliedFrameMs > 0)) return false
  return Math.abs(intervalP50 - impliedFrameMs) / impliedFrameMs <= tolerance
}
