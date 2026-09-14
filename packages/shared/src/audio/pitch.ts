/**
 * 基频（音高）检测 —— YIN 算法的简化实现。
 * 参考：de Cheveigné & Kawahara (2002), YIN: A fundamental frequency estimator.
 *
 * 用途：语调曲线。中文母语者说英语最大的问题之一就是语调过平。
 */

export interface PitchOptions {
  /** 搜索的最低基频（Hz），默认 70（男声下限） */
  minHz?: number
  /** 搜索的最高基频（Hz），默认 400（女声/童声上限） */
  maxHz?: number
  /** YIN 的绝对阈值，默认 0.15（越小越严格） */
  threshold?: number
}

/**
 * 对单帧音频估算基频。
 * @returns 基频（Hz）；返回 0 表示该帧无浊音（清音/静音）
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
  opts: PitchOptions = {},
): number {
  const minHz = opts.minHz ?? 70
  const maxHz = opts.maxHz ?? 400
  const threshold = opts.threshold ?? 0.15

  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(frame.length / 2))
  if (tauMax <= tauMin) return 0

  // 1. 差分函数
  const diff = new Float32Array(tauMax + 1)
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0
    const n = frame.length - tau
    for (let i = 0; i < n; i++) {
      const d = (frame[i] as number) - (frame[i + tau] as number)
      sum += d * d
    }
    diff[tau] = sum
  }

  // 2. 累积均值归一化差分（CMND）
  const cmnd = new Float32Array(tauMax + 1)
  let running = 0
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += diff[tau] as number
    cmnd[tau] = running === 0 ? 1 : (diff[tau] as number) * (tau - tauMin + 1) / running
  }

  // 3. 绝对阈值：找第一个低于阈值的局部极小
  let tau = tauMin
  while (tau <= tauMax) {
    if ((cmnd[tau] as number) < threshold) {
      // 走到该谷底
      while (tau + 1 <= tauMax && (cmnd[tau + 1] as number) < (cmnd[tau] as number)) tau++
      break
    }
    tau++
  }
  if (tau > tauMax) return 0

  // 4. 抛物线插值，提高亚采样精度
  const x0 = tau > tauMin ? cmnd[tau - 1] as number : cmnd[tau] as number
  const x1 = cmnd[tau] as number
  const x2 = tau + 1 <= tauMax ? cmnd[tau + 1] as number : cmnd[tau] as number
  const denom = 2 * (2 * x1 - x0 - x2)
  const betterTau = denom === 0 ? tau : tau + (x2 - x0) / denom

  return betterTau <= 0 ? 0 : sampleRate / betterTau
}

/**
 * 对整段音频逐帧提取音高曲线。
 * @param frames 已经是分帧后的 Float32Array 数组（每帧通常 640 采样 = 40ms @16k）
 */
export function pitchContour(
  frames: Float32Array[],
  sampleRate: number,
  opts: PitchOptions = {},
): number[] {
  return frames.map((f) => detectPitch(f, sampleRate, opts))
}

/** 语调起伏度：浊音帧基频的标准差 / 均值。数值越低说明语调越平。 */
export function pitchVariability(contour: number[]): number {
  const voiced = contour.filter((hz) => hz > 0)
  if (voiced.length < 3) return 0
  const mean = voiced.reduce((a, b) => a + b, 0) / voiced.length
  if (mean === 0) return 0
  const variance = voiced.reduce((a, b) => a + (b - mean) ** 2, 0) / voiced.length
  return Math.sqrt(variance) / mean
}
