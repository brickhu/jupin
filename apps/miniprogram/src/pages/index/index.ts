import { health } from '../../lib/api/client'

interface Check {
  name: string
  pass: boolean
  detail: string
}

Page({
  data: {
    health: { ok: false, text: '检查中…', engine: '-' },
    checks: [] as Check[],
  },

  onLoad() {
    void this.checkHealth()
  },

  async checkHealth() {
    try {
      const res = await health()
      this.setData({ health: { ok: res.status === 'ok', text: '正常', engine: res.engine } })
    } catch (err) {
      this.setData({ health: { ok: false, text: `连不上: ${(err as Error).message}`, engine: '-' } })
    }
  },

  /**
   * 音频算法自检 —— 用小程序 Worker 跑一遍纯函数。
   * 验证两件事：① Worker 打包是否正常 ② 算法能否在端侧跑通
   */
  onRunAudioSelfTest() {
    const w = wx.createWorker('workers/audio-analysis/index.js')

    w.onMessage((res) => {
      const r = res as unknown as {
        type: string
        vad: { speechMs: number; pauseCount: number }
        pitch: { variability: number }
      }
      if (r.type !== 'result') return

      this.setData({
        checks: [
          { name: 'Worker 打包', pass: true, detail: '可加载' },
          { name: 'VAD', pass: true, detail: `${Math.round(r.vad.speechMs)}ms 语音` },
          { name: '音高分析', pass: true, detail: `起伏度 ${r.pitch.variability.toFixed(3)}` },
        ],
      })
      w.terminate()
    })

    // 造 1 秒 440Hz 正弦（模拟浊音）验证算法链路
    const sampleRate = 16000
    const pcm = new Int16Array(sampleRate)
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000)
    }

    w.postMessage({ type: 'analyze', buffer: pcm.buffer, expectedWords: 3 })
  },
})
