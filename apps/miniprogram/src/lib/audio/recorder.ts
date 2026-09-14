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
      // ⚠️ 官方限制：duration 最大 600000（10 分钟）
      duration: 60_000,
      // ⚠️ sampleRate 在 PC 上不支持 —— 开发者工具里此参数无效，**必须真机测**
      sampleRate: AUDIO_SPEC.sampleRate,
      // ⚠️ 默认值是 2（双声道）！不显式传 1 会拿到立体声，与引擎要求不符
      numberOfChannels: AUDIO_SPEC.channels,
      // ⚠️ 必须落在 sampleRate 对应的合法区间：16000Hz → 24000 ~ 96000
      encodeBitRate: 48_000,
      // ⭐ 直出裸 PCM，与引擎零转码
      // ⚠️ frameSize 单位是 KB 且必须是整数；官方限定「暂仅支持 mp3、pcm 格式」
      format: 'PCM',
      frameSize: AUDIO_SPEC.frameSizeKb,
    })
  }

  stop(): void {
    this.manager.stop()
  }
}
