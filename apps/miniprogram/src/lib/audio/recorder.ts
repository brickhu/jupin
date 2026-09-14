import { AUDIO_SPEC } from '@jushuo/shared'

/**
 * 录音适配层 —— 只做「收帧 → 转发给 Worker」，不做任何算法。
 * ⚠️ 所有音频算法都在 @jushuo/shared/audio 里（纯函数，可在 Node 里单测）。
 */
export interface RecorderCallbacks {
  onFrame?: (pcm: ArrayBuffer) => void
  onStop?: (pcm: ArrayBuffer, durationMs: number) => void
  onError?: (err: Error) => void
}

export class Recorder {
  private chunks: ArrayBuffer[] = []
  private startedAt = 0
  private manager = wx.getRecorderManager()
  private wired = false

  constructor(private readonly cb: RecorderCallbacks = {}) {}

  private wire(): void {
    if (this.wired) return
    this.wired = true

    // ⭐ 实时 PCM 帧：端侧分析的数据源
    this.manager.onFrameRecorded((res) => {
      this.chunks.push(res.frameBuffer)
      this.cb.onFrame?.(res.frameBuffer)
    })

    this.manager.onStop(() => {
      const total = this.chunks.reduce((n, b) => n + b.byteLength, 0)
      const merged = new Uint8Array(total)
      let off = 0
      for (const b of this.chunks) {
        merged.set(new Uint8Array(b), off)
        off += b.byteLength
      }
      this.cb.onStop?.(merged.buffer, Date.now() - this.startedAt)
      this.chunks = []
    })

    this.manager.onError((err) => this.cb.onError?.(new Error(err.errMsg)))
  }

  start(): void {
    this.wire()
    this.chunks = []
    this.startedAt = Date.now()
    this.manager.start({
      duration: 60_000,
      sampleRate: AUDIO_SPEC.sampleRate,
      numberOfChannels: AUDIO_SPEC.channels,
      encodeBitRate: 48_000,
      format: 'PCM',                            // ⭐ 直出裸 PCM，与引擎零转码
      frameSize: AUDIO_SPEC.frameBytes / 1024,  // 单位 KB
    })
  }

  stop(): void {
    this.manager.stop()
  }
}
