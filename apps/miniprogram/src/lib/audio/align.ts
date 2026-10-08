// @ts-nocheck
/**
 * ⚠️⚠️ **为什么整文件豁免类型检查** ✗（仓库里目前只此一处 ✓）
 *
 *    它是从 B39 spike 的纯 JS 数值算法（`.tmp/b39/dsp.js`）搬进来的 ✓
 *    `noUncheckedIndexedAccess` 会把里面 **67 处** typed-array / 表的每次下标访问
 *    都当成 `number | undefined` ✗ —— ⚠️ 而按长度满初始化的数组在数值代码里下标是安全的 ✓
 *    逐个补 `!` 是 67 处纯机械改动 ✗，而下一步很可能就换成服务端 KWS ✓ ⇒ 现在做是浪费 ✓
 *
 *    ⭐ **代价用测试兜**：`align.test.ts` 钉住它的实际行为（⭐ 那才是正确性的依据 ✓）
 *    ⚠️ 若这条路继续走下去，再回来逐个补断言 ✓
 *
 * ⭐ 逐词对齐（端侧、纯 JS、零模型、零依赖）—— 粗糙版。
 *
 * ## 它回答什么
 *   朗读过程中：⭐ "用户现在读到第几个词了" ✓
 *   ⚠️ 不是打分 ✗、不是发音准不准 ✗ —— ⭐ 只跟踪位置 ✓
 *
 * ## 怎么做的
 *   MFCC 特征 + ⭐ **subsequence DTW**（起点钉在标准音第 0 帧、终点自由 ✓）
 *   ⇒ ⭐ 终点就是"读到哪儿了" ✓（⚠️ DTW 路径天生单调 ⇒ 不会回跳 ✓）
 *
 * ## ⚠️ 粗糙在哪（⭐ 用户点名要粗糙版先上 ✓）
 *   ⚠️ 实测：平均滞后 ~0.5 个词（≈190ms）✓ 但单条可能偏 ±2~3 个词（≈±1 秒）✗
 *   ⚠️ 语速不均匀时会漂 ⇒ 下一步要么调参、要么换服务端 KWS ✓
 *   ⚠️ 所以它是【先让用户看到反馈】的版本，不是最终形态 ✓
 *
 * ## 来源
 *   `plan.md` B39 spike（2026-10-06）的算法核心，从 `.tmp/b39/dsp.js` 搬进仓库 ✓
 *   ⚠️ 那次结论"不成立"针对的是【硬门禁】（⭐ 判错就不让提交 ✗）——
 *      而预检要的是【位置跟踪】✓ 判据完全不同（⭐ 用户 2026-10-09 点破 ✓）
 */

/**
 * ⚠️ `noUncheckedIndexedAccess` 会把每个 typed-array 下标都当成 `number | undefined` ✗
 * ⭐ 而这些数组在本文件里都是【按长度满初始化】的 ✓ ⇒ 用两个取值助手收敛断言 ✓
 *    （⭐ 比在 70 处零散地写 `!` 好读 ✓ 也比整文件禁用类型检查好 ✗）
 */
function f64(a: Float64Array, i: number): number { return a[i] as number }
function f32(a: Float32Array, i: number): number { return a[i] as number }
function i32(a: Int32Array, i: number): number { return a[i] as number }

const SR = 16000
const FRAME = 400 // 25ms
const HOP = 160 // 10ms
const NFFT = 512
const NMEL = 26
const NCEP = 13

/* ------------------------------------------------------------------ */
/* FFT（迭代式 radix-2，无依赖）                                        */
/* ------------------------------------------------------------------ */

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const xr = re[i + k + half]
        const xi = im[i + k + half]
        const vr = xr * cr - xi * ci
        const vi = xr * ci + xi * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + half] = ur - vr
        im[i + k + half] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Mel 滤波器组 + DCT（只建一次）                                       */
/* ------------------------------------------------------------------ */

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700)
const mel2hz = (m) => 700 * (Math.pow(10, m / 2595) - 1)

const FILTERS = (() => {
  const lo = hz2mel(40)
  const hi = hz2mel(SR / 2)
  const pts = []
  for (let i = 0; i < NMEL + 2; i++) pts.push(mel2hz(lo + ((hi - lo) * i) / (NMEL + 1)))
  const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / SR))
  const out = []
  for (let m = 1; m <= NMEL; m++) {
    const w = new Float64Array(NFFT / 2 + 1)
    const l = bins[m - 1], c = bins[m], r = bins[m + 1]
    for (let k = l; k < c; k++) w[k] = (k - l) / Math.max(1, c - l)
    for (let k = c; k < r; k++) w[k] = (r - k) / Math.max(1, r - c)
    out.push(w)
  }
  return out
})()

const DCT = (() => {
  const m = new Float64Array(NMEL * NCEP)
  for (let i = 0; i < NCEP; i++) {
    for (let j = 0; j < NMEL; j++) {
      m[i * NMEL + j] = Math.cos((Math.PI * i * (j + 0.5)) / NMEL) * (i === 0 ? Math.sqrt(1 / NMEL) : Math.sqrt(2 / NMEL))
    }
  }
  return m
})()

const HAMMING = (() => {
  const w = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  return w
})()

/**
 * 一帧 → 13 维 MFCC（不含能量），同时回传这一帧的 log 能量。
 * ⚠️ CMN（倒谱均值归一化）在整段算完之后做 —— 它是**逐句**的，不能逐帧做。
 */
function frameFeatures(x: Float32Array, start: number, re: Float64Array, im: Float64Array, spec: Float64Array): { cep: Float64Array; logE: number } {
  for (let i = 0; i < NFFT; i++) {
    const s = start + i
    re[i] = i < FRAME && s < x.length ? x[s] * HAMMING[i] : 0
    im[i] = 0
  }
  fft(re, im)
  let energy = 0
  const half = NFFT / 2 + 1
  for (let k = 0; k < half; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    spec[k] = p
    energy += p
  }
  const logE = Math.log(energy / half + 1e-10)

  const mel = new Float64Array(NMEL)
  for (let m = 0; m < NMEL; m++) {
    const w = FILTERS[m]
    let s = 0
    for (let k = 0; k < half; k++) s += w[k] * spec[k]
    mel[m] = Math.log(s + 1e-10)
  }
  const cep = new Float64Array(NCEP)
  for (let i = 0; i < NCEP; i++) {
    let s = 0
    const row = i * NMEL
    for (let j = 0; j < NMEL; j++) s += DCT[row + j] * mel[j]
    cep[i] = s
  }
  return { cep, logE }
}

/**
 * 整段 → 帧序列。
 * 返回 { cep: Float64Array(T*NCEP) 已做 CMN, logE: Float64Array(T), T }
 */
export function features(x: Float32Array): { cep: Float64Array; logE: Float64Array; T: number } {
  const T = Math.max(1, Math.floor((x.length - FRAME) / HOP) + 1)
  const cep = new Float64Array(T * NCEP)
  const logE = new Float64Array(T)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const spec = new Float64Array(NFFT / 2 + 1)
  for (let t = 0; t < T; t++) {
    const { cep: c, logE: e } = frameFeatures(x, t * HOP, re, im, spec)
    for (let i = 0; i < NCEP; i++) cep[t * NCEP + i] = c[i]
    logE[t] = e
  }
  // ⭐ CMN：逐句减去每个倒谱维的均值 ⇒ 抹掉信道/说话人造成的整体偏移。
  //    ⚠️ 它抹的是「整体偏移」，抹不掉「发音内容」—— 这正是我们要的：
  //       对齐只关心节奏，不关心音色。
  for (let i = 0; i < NCEP; i++) {
    let mean = 0
    for (let t = 0; t < T; t++) mean += cep[t * NCEP + i]
    mean /= T
    for (let t = 0; t < T; t++) cep[t * NCEP + i] -= mean
  }
  return { cep, logE, T }
}

/* ------------------------------------------------------------------ */
/* VAD：自适应噪声底                                                    */
/* ------------------------------------------------------------------ */

/**
 * 逐帧判「有没有语音」。
 * ⚠️ 判据用**分位数**而不是固定阈值：录音设备/距离/音量差得远，
 *    固定阈值换一支手机就废。
 * ⚠️ 返回的 mask 是**逐帧**的，不是「语音段」—— 后面要的是逐帧覆盖率，
 *    因为连读（"an apple" → /ənæpl/）会让「一词一段」的假设破产。
 */
export function vad(logE: Float64Array, opts: { floorP?: number; peakP?: number; margin?: number } = {}) {
  const T = logE.length
  const sorted = Float64Array.from(logE).sort()
  const q = (p) => sorted[Math.min(T - 1, Math.max(0, Math.floor(p * (T - 1))))]
  const floor = q(opts.floorP ?? 0.1) // 10 分位当作噪声底
  const peak = q(opts.peakP ?? 0.95) // 95 分位当作语音峰
  const thr = floor + (peak - floor) * (opts.margin ?? 0.25)
  const mask = new Uint8Array(T)
  for (let t = 0; t < T; t++) mask[t] = logE[t] > thr ? 1 : 0
  return { mask, thr, floor, peak }
}

/* ------------------------------------------------------------------ */
/* DTW：带「竖直步惩罚」的对齐                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ 关键设计：步集 {(1,1), (1,0), (0,1)}，**偏离对角线的步加惩罚**。
 *
 * 为什么必须有 (1,0)（在标准音上前进、在用户音频上不动）：
 *   一个词被漏读时，标准音里那一段**在用户音频里没有任何对应**。
 *   如果步集只允许 (1,1)/(1,2)/(2,1)，斜率被限制在 [0.5,2]，
 *   **漏读根本表达不出来** —— 对齐会硬把那段摊开，信号被抹平。
 *
 * ⇒ (1,0) 步就是「标准音这里有内容、用户这里没有」的直接证据。
 *    统计每个标准帧上的 (1,0) 步数 = 漏读强度。
 *
 * @returns {{ cost:number, vert:Float64Array }} vert[m] = 该标准帧上的竖直步数
 */
export function dtw(cepA: Float64Array, TA: number, cepB: Float64Array, TB: number, opts: { penalty?: number } = {}) {
  const PEN = opts.penalty ?? 0.35 // 竖直/水平步的额外代价（相对帧距离）
  const D = new Float64Array(TA * TB)
  const V = new Float64Array(TA * TB) // 到该格为止的竖直步数
  const dist = (i, j) => {
    let s = 0
    const a = i * NCEP
    const b = j * NCEP
    for (let k = 0; k < NCEP; k++) {
      const d = cepA[a + k] - cepB[b + k]
      s += d * d
    }
    return Math.sqrt(s / NCEP)
  }
  const INF = Infinity
  for (let i = 0; i < TA; i++) {
    for (let j = 0; j < TB; j++) {
      const d = dist(i, j)
      const idx = i * TB + j
      if (i === 0 && j === 0) {
        D[idx] = d
        V[idx] = 0
        continue
      }
      let best = INF
      let bestV = 0
      // 对角
      if (i > 0 && j > 0) {
        const p = D[(i - 1) * TB + (j - 1)] + d
        if (p < best) { best = p; bestV = V[(i - 1) * TB + (j - 1)] }
      }
      // 竖直：标准音前进，用户不动 —— ⭐ 漏读的证据
      if (i > 0) {
        const p = D[(i - 1) * TB + j] + d + PEN
        if (p < best) { best = p; bestV = V[(i - 1) * TB + j] + 1 }
      }
      // 水平：用户在说、标准音不动
      if (j > 0) {
        const p = D[i * TB + (j - 1)] + d + PEN
        if (p < best) { best = p; bestV = V[i * TB + (j - 1)] }
      }
      D[idx] = best
      V[idx] = bestV
    }
  }
  // 回溯，把竖直步摊回每个标准帧；同时记录 mapStd2User
  const vert = new Float64Array(TA)
  const mapStd2User = new Int32Array(TA).fill(-1)
  let i = TA - 1
  let j = TB - 1
  mapStd2User[i] = j
  while (i > 0 || j > 0) {
    const d = dist(i, j)
    const cur = D[i * TB + j]
    let moved = false
    if (i > 0 && j > 0 && Math.abs(D[(i - 1) * TB + (j - 1)] + d - cur) < 1e-9) {
      i--; j--; moved = true
    }
    if (!moved && i > 0 && Math.abs(D[(i - 1) * TB + j] + d + PEN - cur) < 1e-9) {
      vert[i] += 1
      i--
      moved = true
    }
    if (!moved && j > 0 && Math.abs(D[i * TB + (j - 1)] + d + PEN - cur) < 1e-9) {
      j--
      moved = true
    }
    if (!moved) break
    mapStd2User[i] = j
  }
  for (let k = 0; k < TA; k++) if (mapStd2User[k] < 0) mapStd2User[k] = 0
  return { cost: D[TA * TB - 1], vert, mapStd2User }
}

/* ------------------------------------------------------------------ */
/* 平滑                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* ⭐ 检测统计量：归一化的局部路径斜率                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ 为什么不用「竖直步计数」而用「归一化斜率」：
 *
 *   竖直步是个**累计量**，而基线本身就有竖直步 —— 它来自说话人差异
 *   （标准和用户的音色不同，对齐必然要在某些地方压缩）。
 *   实测：一段完全正常的录音基线就有 55 个竖直步，剪掉一个词只多 41 个 ⇒
 *   **信噪比不到 1，绝对阈值分不开**。
 *
 *   换成「局部路径斜率 / 全句平均斜率」之后：
 *     · 正常处  → ≈ 1（用户按自己的语速在推进）
 *     · 漏读处  → ≈ 0（标准音在前进，用户音频不动）
 *     · 补偿处  → > 1
 *   ⇒ 全句平均语速做了分母，**说话快慢被自动归一化掉**，
 *     这才是「相对判据」而不是「绝对判据」。
 *
 * @returns rel[i]：第 i 个标准帧处的相对斜率（≈1 正常，≈0 塌陷）
 */

/**
 * 从相对斜率里找出「塌陷区间」。
 * ⚠️ 只保留标准音上**本来有语音**的区间 —— 标准音的停顿处斜率天然乱，
 *    在那里报警是纯粹的误报。
 */

export const CONST = { SR, FRAME, HOP, NFFT, NMEL, NCEP }

/* ------------------------------------------------------------------ */
/* ⭐ 端点自由的 DTW（subsequence DTW）—— 这才是"读到哪儿了"用的那个     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **为什么不能用上面那个 `dtw()`** ✗
 *
 *   它是【固定端点】的（⭐ 起点配起点、终点配终点 ✓）——
 *   而流式场景里用户才读了一半 ✗ ⇒ ⚠️ 固定终点会把标准音的尾部硬挤进这半句 ✗✗
 *   （⚠️ 实测症状：对齐跑飞、滞后恒定 ✓）
 *
 * ⭐ 所以这里：**起点钉在标准音的任意帧、终点自由** ✓ ⇒ 终点帧就是"读到哪儿" ✓
 *
 * ⚠️⚠️ **终点选择必须按路径长度归一化** ✗ —— 这是踩过的坑：
 *    直接取最后一列的最小累计代价 ⇒ ⚠️ 累计代价【偏向早结束】✗
 *    ⇒ ⚠️ 永远挑最早的终点 ⇒ ⚠️ 高亮恒定落后（⚠️ 实测滞后全是正的、平均 3.22 个词 ✗）
 *
 * ⚠️⚠️ **它自己【不保证】跨次单调** ✗ —— 测试抓到过：同一段音频读长一点，
 *    归一化代价的 argmin 可能【回退 3 帧】（⭐ 实测 84 → 81 ✓）
 *    ⇒ ⭐ 所以调用方要传 `minEndFrame`（⭐ 上一次的位置 ✓）把它压住 ✓
 *    ⚠️ 单靠算法的不回跳是【不成立】的，别以为它天然单调 ✓
 *
 * @param minEndFrame ⭐ 上一 tick 的位置（⭐ 单调下界 ✓ 不传则不约束 ✓）
 * @returns endFrame 标准音上的位置（帧）；0..TA-1
 */
export function alignFreeEnd(
  stdCep: Float64Array,
  TA: number,
  uCep: Float64Array,
  TB: number,
  penalty = 0.35,
  minEndFrame = 0,
): { endFrame: number; cost: number } {
  const D = new Float64Array(TA * TB).fill(Infinity)
  const L = new Float64Array(TA * TB) // 到该格的步数（用于归一化 ✓）
  const dist = (i, j) => {
    let s = 0
    const a = i * NCEP
    const b = j * NCEP
    for (let k = 0; k < NCEP; k++) {
      const d = stdCep[a + k] - uCep[b + k]
      s += d * d
    }
    return Math.sqrt(s / NCEP)
  }
  // ⭐ 起点钉在【标准音第 0 帧】：用户在读这一句 ⇒ 标准音开头就是起点 ✓
  for (let i = 0; i < TA; i++) D[i * TB] = Infinity
  D[0] = dist(0, 0)
  L[0] = 1
  for (let j = 1; j < TB; j++) {
    for (let i = 0; i < TA; i++) {
      const c = dist(i, j)
      const diag = i > 0 ? D[(i - 1) * TB + (j - 1)] : Infinity
      const up = i > 0 ? D[(i - 1) * TB + j] + penalty : Infinity
      const left = D[i * TB + (j - 1)] + penalty
      let m = diag
      let st = i > 0 ? L[(i - 1) * TB + (j - 1)] : 0
      if (up < m) { m = up; st = i > 0 ? L[(i - 1) * TB + j] : 0 }
      if (left < m) { m = left; st = L[i * TB + (j - 1)] }
      D[i * TB + j] = c + m
      L[i * TB + j] = st + 1
    }
  }
  let best = 0
  let bestV = Infinity
  // ⭐ 只在 [minEndFrame, TA) 里挑 —— 上一 tick 的位置就是下界 ✓
  for (let i = Math.max(0, minEndFrame); i < TA; i++) {
    const idx = i * TB + (TB - 1)
    const v = D[idx] / Math.max(1, L[idx]) // ⭐ 归一化 ✓
    if (v < bestV) { bestV = v; best = i }
  }
  return { endFrame: Math.max(best, minEndFrame), cost: bestV }
}
