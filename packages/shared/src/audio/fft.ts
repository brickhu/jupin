/**
 * radix-2 FFT —— 纯函数，零平台依赖。
 *
 * ⚠️⚠️ 为什么必须自己写：小程序**没有 AnalyserNode**，频谱只能自算。
 *    而原先 `dtw.ts` 里的 `magnitudeSpectrum()` 用的是**朴素 DFT，O(n²)**：
 *    1024 点约 100 万次运算，而 FFT 只要约 1 万次 —— 差 100 倍。
 *
 *    实测代价（见 docs/experiments/dtw-alignment-feasibility.md）：
 *      Node 下每帧 7.5ms → 按 iOS 慢 13 倍算 ≈ **100ms/帧**，
 *      而实时预算是 64ms/帧 —— **直接让「实时逐词跟随」不可行**。
 *    换成 FFT 之后才有余量。
 */

/**
 * 就地 FFT（迭代版 Cooley-Tukey）。
 *
 * @param re 实部，长度必须是 2 的幂，**原地改写**
 * @param im 虚部，长度必须与 re 相同，**原地改写**
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n !== im.length) throw new Error(`FFT 实部/虚部长度不一致：${n} vs ${im.length}`)
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`)

  // ---- ① 位反转置换 ----
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }

  // ---- ② 蝶形运算 ----
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      // 旋转因子按递推算，避免每个 k 都调一次 cos/sin
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const bRe = re[b] as number
        const bIm = im[b] as number
        // v = b * cur
        const vRe = bRe * curRe - bIm * curIm
        const vIm = bRe * curIm + bIm * curRe
        const uRe = re[a] as number
        const uIm = im[a] as number
        re[a] = uRe + vRe
        im[a] = uIm + vIm
        re[b] = uRe - vRe
        im[b] = uIm - vIm

        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/**
 * 单边幅度谱（汉宁窗 + 补零到 2 的幂）。
 *
 * ⚠️ 输出的**数值必须与替换前的朴素 DFT 完全一致** ——
 *    MFCC 是层层叠加的，频谱差一点，最终特征就漂一点，
 *    而参考音的 MFCC 是**离线预算好**的，两边对不上就白算。
 *    所以 audio.test.ts 里有一条「与朴素 DFT 逐个比对」的回归。
 */
export function magnitudeSpectrum(frame: Float32Array): Float64Array {
  let n = 1
  while (n < frame.length) n <<= 1

  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const len = frame.length
  const denom = Math.max(1, len - 1)
  for (let t = 0; t < len; t++) {
    // 汉宁窗
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * t) / denom))
    re[t] = (frame[t] as number) * w
  }

  fft(re, im)

  const half = n >> 1
  const out = new Float64Array(half)
  for (let k = 0; k < half; k++) {
    const r = re[k] as number
    const i = im[k] as number
    out[k] = Math.sqrt(r * r + i * i)
  }
  return out
}
