/**
 * 语音活动检测（VAD）—— 基于能量 + 过零率。
 *
 * 用途：本地预检第①②层（技术有效性 / 长度合理性）、语速停顿分析。
 * ⚠️ 必须在端侧做——依赖云端等于音频已经上云，省不下成本。
 */

export interface VadOptions {
  /** 能量阈值倍率（相对噪声底），默认 3 */
  energyFactor?: number
  /** 连续多少帧低于阈值才算静音（抗抖动），默认 3（≈120ms） */
  hangoverFrames?: number
}

export interface VadResult {
  /** 逐帧是否为语音 */
  voiced: boolean[]
  /** 有效语音总时长（毫秒） */
  speechMs: number
  /** 有效语音占比 */
  speechRatio: number
  /** 语音段（连续 voiced 的起止帧索引） */
  segments: Array<{ startFrame: number; endFrame: number }>
}

/** 单帧短时能量（均方值） */
export function frameEnergy(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] as number
    sum += s * s
  }
  return frame.length === 0 ? 0 : sum / frame.length
}

/** 单帧过零率 —— 辅助区分静音与清音 */
export function zeroCrossingRate(frame: Float32Array): number {
  if (frame.length < 2) return 0
  let crossings = 0
  for (let i = 1; i < frame.length; i++) {
    if (((frame[i - 1] as number) >= 0) !== ((frame[i] as number) >= 0)) crossings++
  }
  return crossings / (frame.length - 1)
}

/**
 * @param frames 分帧后的音频
 * @param frameMs 每帧时长（毫秒），默认 40
 */
export function detectVad(
  frames: Float32Array[],
  frameMs = 40,
  opts: VadOptions = {},
): VadResult {
  const energyFactor = opts.energyFactor ?? 3
  const hangover = opts.hangoverFrames ?? 3

  if (frames.length === 0) {
    return { voiced: [], speechMs: 0, speechRatio: 0, segments: [] }
  }

  const energies = frames.map(frameEnergy)

  // 噪声底：取能量最低的 20% 帧的中位数
  const sorted = [...energies].sort((a, b) => a - b)
  const noiseFloor =
    sorted[Math.floor(sorted.length * 0.2)] ?? 0
  const threshold = Math.max(noiseFloor * energyFactor, 1e-6)

  // 原始判定
  const raw = energies.map((e, i) => e > threshold && zeroCrossingRate(frames[i] as Float32Array) < 0.5)

  // 迟滞：静音需要连续 hangover 帧才生效，避免词间气口被切断
  const voiced: boolean[] = []
  let silentRun = 0
  let lastVoiced = false
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]) {
      silentRun = 0
      lastVoiced = true
      voiced.push(true)
    } else {
      silentRun++
      if (lastVoiced && silentRun <= hangover) {
        voiced.push(true)   // 迟滞窗口内延续
      } else {
        lastVoiced = false
        voiced.push(false)
      }
    }
  }

  // 合并成语音段
  const segments: Array<{ startFrame: number; endFrame: number }> = []
  let start = -1
  for (let i = 0; i < voiced.length; i++) {
    if (voiced[i] && start < 0) start = i
    else if (!voiced[i] && start >= 0) {
      segments.push({ startFrame: start, endFrame: i - 1 })
      start = -1
    }
  }
  if (start >= 0) segments.push({ startFrame: start, endFrame: voiced.length - 1 })

  const voicedFrames = voiced.filter(Boolean).length
  const speechMs = voicedFrames * frameMs

  return {
    voiced,
    speechMs,
    speechRatio: voicedFrames / voiced.length,
    segments,
  }
}

/** 从语音段推导停顿位置（用于流利度反馈） */
export function detectPauses(
  vad: VadResult,
  frameMs = 40,
  minPauseMs = 300,
): Array<{ startMs: number; durationMs: number }> {
  const pauses: Array<{ startMs: number; durationMs: number }> = []
  for (let i = 1; i < vad.segments.length; i++) {
    const prevEnd = (vad.segments[i - 1] as { endFrame: number }).endFrame
    const currStart = (vad.segments[i] as { startFrame: number }).startFrame
    const gapMs = (currStart - prevEnd - 1) * frameMs
    if (gapMs >= minPauseMs) {
      pauses.push({ startMs: (prevEnd + 1) * frameMs, durationMs: gapMs })
    }
  }
  return pauses
}
