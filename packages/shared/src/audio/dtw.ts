/**
 * DTW（动态时间规整）+ MFCC —— 零模型的标准音相似度对比。
 *
 * 用途：端侧的「这次比上次更接近标准发音了吗」相对趋势。
 * ⚠️ 只做相对比较，不产出绝对分数——绝对分数需要校准，而校准是几周的工作量。
 */

/** 提取 MFCC 特征序列（简化版：梅尔滤波器组 + DCT，取前 N 维） */
export function mfcc(
  frame: Float32Array,
  sampleRate: number,
  numCoeffs = 13,
  numFilters = 26,
): number[] {
  const N = frame.length
  const spectrum = magnitudeSpectrum(frame)
  const bins = spectrum.length

  // 梅尔滤波器组
  const melLow = hzToMel(80)
  const melHigh = hzToMel(Math.min(8000, sampleRate / 2))
  const melPoints = new Array<number>(numFilters + 2)
  for (let i = 0; i < numFilters + 2; i++) {
    melPoints[i] = melLow + ((melHigh - melLow) * i) / (numFilters + 1)
  }
  const hzPoints = melPoints.map(melToHz)
  const binPoints = hzPoints.map((hz) => Math.floor(((N + 1) * hz) / sampleRate))

  const filterEnergies = new Array<number>(numFilters).fill(0)
  for (let m = 1; m <= numFilters; m++) {
    const left = binPoints[m - 1] as number
    const center = binPoints[m] as number
    const right = binPoints[m + 1] as number
    let sum = 0
    for (let k = left; k < center; k++) {
      if (k < 0 || k >= bins) continue
      sum += (spectrum[k] as number) * ((k - left) / Math.max(1, center - left))
    }
    for (let k = center; k < right; k++) {
      if (k < 0 || k >= bins) continue
      sum += (spectrum[k] as number) * ((right - k) / Math.max(1, right - center))
    }
    filterEnergies[m - 1] = Math.log(sum + 1e-10)
  }

  // DCT-II
  const coeffs: number[] = []
  for (let c = 0; c < numCoeffs; c++) {
    let sum = 0
    for (let m = 0; m < numFilters; m++) {
      sum += (filterEnergies[m] as number) * Math.cos((Math.PI * c * (m + 0.5)) / numFilters)
    }
    coeffs.push(sum)
  }
  return coeffs
}

/** 对整段音频逐帧提取 MFCC */
export function mfccSequence(frames: Float32Array[], sampleRate: number, numCoeffs = 13): number[][] {
  return frames.map((f) => mfcc(f, sampleRate, numCoeffs))
}

/**
 * DTW 距离（带 Sakoe-Chiba 窗，避免病态对齐）。
 * 距离越小说明两段发音越接近。
 */
export function dtwDistance(
  a: number[][],
  b: number[][],
  windowRatio = 0.2,
): number {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return Number.POSITIVE_INFINITY

  const window = Math.max(Math.abs(n - m), Math.floor(Math.max(n, m) * windowRatio))
  const INF = Number.POSITIVE_INFINITY
  let prev = new Float64Array(m + 1).fill(INF)
  let curr = new Float64Array(m + 1).fill(INF)
  prev[0] = 0

  for (let i = 1; i <= n; i++) {
    curr.fill(INF)
    const lo = Math.max(1, i - window)
    const hi = Math.min(m, i + window)
    for (let j = lo; j <= hi; j++) {
      const cost = euclidean(a[i - 1] as number[], b[j - 1] as number[])
      const best = Math.min(prev[j] as number, curr[j - 1] as number, prev[j - 1] as number)
      curr[j] = cost + (best === INF ? 0 : best)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return (prev[m] as number) / Math.max(n, m)
}

/** 把 DTW 距离转成 0–100 的相似度（仅在「同一句话纵向比较」时有意义） */
export function dtwSimilarity(distance: number, scale = 20): number {
  return Math.round(100 / (1 + distance / scale))
}

/* ---------- 内部工具 ---------- */

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}
function euclidean(a: number[], b: number[]): number {
  let sum = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (b[i] as number)
    sum += d * d
  }
  return Math.sqrt(sum)
}

/** 朴素 DFT 幅度谱（小程序无 AnalyserNode，需自算） */
function magnitudeSpectrum(frame: Float32Array): Float64Array {
  // 补零到 2 的幂
  let n = 1
  while (n < frame.length) n <<= 1
  const half = n >> 1
  const out = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    let re = 0
    let im = 0
    const factor = (-2 * Math.PI * k) / n
    for (let t = 0; t < frame.length; t++) {
      // 汉宁窗
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * t) / (frame.length - 1)))
      const s = (frame[t] as number) * w
      re += s * Math.cos(factor * t)
      im += s * Math.sin(factor * t)
    }
    out[k] = Math.sqrt(re * re + im * im)
  }
  return out
}
