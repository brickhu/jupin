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

interface AnalyzeResponse {
  type: 'result'
  vad: { speechMs: number; speechRatio: number; pauseCount: number }
  pitch: { variability: number; voicedFrames: number }
  preflight: { pass: boolean; reason?: string }
}

worker.onMessage((msg: AnalyzeRequest) => {
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
