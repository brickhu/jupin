/**
 * 音频分析 Worker。
 *
 * ⚠️ 小程序要求 Worker 是**单文件**，所以由 esbuild 单独打包（见 build.mjs），
 *    把 @jushuo/shared 一起打进来。
 *
 * 职责极薄：收帧 → 调 @jushuo/shared/audio 的纯函数 → 回结果。
 * 真正的算法在 packages/shared/src/audio/ 里，可在 Node 里用 vitest 单测。
 */
import {
  AUDIO_SPEC, MS_PER_WORD, PREFLIGHT,
  frameAudio, pcmInt16ToFloat32,
  detectVad, detectPauses, pitchContour, pitchVariability,
} from '@jushuo/shared'

interface AnalyzeRequest {
  type: 'analyze'
  buffer: ArrayBuffer
  expectedWords: number
}

/**
 * 基准测试：算「单帧音高检测」的耗时（对应真机验证 T5）。
 * ⚠️ 不能在 Worker 里逐帧调 Date.now() —— 只有毫秒分辨率，
 *    而单帧目标 < 5ms。所以测**整轮**耗时再除以帧数。
 */
interface BenchRequest {
  type: 'bench'
  buffer: ArrayBuffer
  rounds: number
}

/**
 * 微基准：测**JS 引擎本身**快不快，与音频无关。
 *
 * ⭐ 为什么需要它：真机上 iOS 跑 YIN 是 7.2ms/帧，Android 只要 0.55ms —— 差 13 倍。
 *    如果连纯算术循环也差这么多，说明是**引擎级差异**（很可能是 iOS 的 JavaScriptCore
 *    没有 JIT，iOS 只给 WebKit 开 JIT 权限），而不是 YIN 算法本身的问题。
 *    这个结论会影响所有算法的预算，所以值得测清楚而不是猜。
 */
interface MicroBenchRequest {
  type: 'microbench'
  iterations: number
}

/** 纯粹的生命周期探针（对应真机验证 T6），不碰音频，只测能不能收发 */
interface PingRequest {
  type: 'ping'
  seq: number
}

type Request = AnalyzeRequest | BenchRequest | PingRequest | MicroBenchRequest

interface AnalyzeResponse {
  type: 'result'
  vad: { speechMs: number; speechRatio: number; pauseCount: number }
  pitch: { variability: number; voicedFrames: number }
  preflight: { pass: boolean; reason?: string }
}

interface BenchResponse {
  type: 'benchResult'
  frames: number
  rounds: number
  /** 每帧平均耗时（毫秒）的各个分位数 */
  p50Ms: number
  p95Ms: number
  maxMs: number,
  minMs: number
  totalMs: number
}

interface PongResponse {
  type: 'pong'
  seq: number
}

worker.onMessage((msg: Request) => {
  if (msg.type === 'ping') {
    const res: PongResponse = { type: 'pong', seq: msg.seq }
    worker.postMessage(res)
    return
  }

  if (msg.type === 'microbench') {
    worker.postMessage(runMicroBench(msg))
    return
  }

  if (msg.type === 'bench') {
    const res = runBench(msg)
    worker.postMessage(res)
    return
  }

  if (msg.type !== 'analyze') return

  const pcm = new Uint8Array(msg.buffer)
  const samples = pcmInt16ToFloat32(pcm)
  const frames = frameAudio(samples, AUDIO_SPEC.frameSamples)
  const frameMs = (AUDIO_SPEC.frameSamples / AUDIO_SPEC.sampleRate) * 1000

  const vad = detectVad(frames, frameMs)
  const pauses = detectPauses(vad, frameMs)
  const contour = pitchContour(frames, AUDIO_SPEC.sampleRate)

  // ---- 本地预检（详见 prd.md 第五节）----
  // ⚠️ 判定标准是「能不能被听懂」，不是「读得标不标准」——后者误伤风险极高
  const expectedMs = msg.expectedWords * MS_PER_WORD
  let pass = true
  let reason: string | undefined

  if (vad.speechMs < PREFLIGHT.minDurationMs) {
    pass = false
    reason = '没检测到语音，请重新朗读'
  } else if (vad.speechMs < expectedMs * PREFLIGHT.minSpeechRatio) {
    pass = false
    reason = '这次好像没读完，再读一遍试试'
  }

  const res: AnalyzeResponse = {
    type: 'result',
    vad: { speechMs: vad.speechMs, speechRatio: vad.speechRatio, pauseCount: pauses.length },
    pitch: { variability: pitchVariability(contour), voicedFrames: contour.filter((hz) => hz > 0).length },
    preflight: { pass, reason },
  }
  worker.postMessage(res)
})

/**
 * 跑一段纯整数算术，测引擎的原始吞吐。
 *
 * ⚠️ 刻意用 SMI 范围内的整数运算 —— 如果引擎有 JIT，这段会被编译成机器码，
 *    速度会有数量级的差别；纯解释执行则慢得多。
 */
function runMicroBench(msg: MicroBenchRequest): {
  type: 'microbenchResult'
  iterations: number
  ms: number
  opsPerMs: number
} {
  const n = msg.iterations
  let acc = 0
  const t0 = Date.now()
  for (let i = 0; i < n; i++) {
    acc = (acc + i * 7) % 1000003
  }
  const ms = Date.now() - t0
  // 防止引擎把整个循环优化掉
  if (acc === -1) console.log('unreachable')
  return {
    type: 'microbenchResult',
    iterations: n,
    ms,
    opsPerMs: ms > 0 ? n / ms : Number.POSITIVE_INFINITY,
  }
}

/** 逐帧跑一次完整的音高检测 + VAD，重复 rounds 轮，统计单帧耗时 */
function runBench(msg: BenchRequest): BenchResponse {
  const samples = pcmInt16ToFloat32(new Uint8Array(msg.buffer))
  const frames = frameAudio(samples, AUDIO_SPEC.frameSamples)
  const frameMs = (AUDIO_SPEC.frameSamples / AUDIO_SPEC.sampleRate) * 1000
  if (frames.length === 0) {
    return { type: 'benchResult', frames: 0, rounds: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, minMs: 0, totalMs: 0 }
  }

  const perFrame: number[] = []
  let totalMs = 0
  for (let r = 0; r < msg.rounds; r++) {
    const t0 = Date.now()
    pitchContour(frames, AUDIO_SPEC.sampleRate)
    detectVad(frames, frameMs)
    const dt = Date.now() - t0
    totalMs += dt
    perFrame.push(dt / frames.length)
  }

  const sorted = [...perFrame].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0

  return {
    type: 'benchResult',
    frames: frames.length,
    rounds: msg.rounds,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    minMs: sorted[0] ?? 0,
    totalMs,
  }
}
