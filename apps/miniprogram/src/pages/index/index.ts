import {
  BASE_URL,
  CLOUD_ENV_ID,
  CLOUD_SERVICE,
  ENV,
  ENV_LABEL,
  ENV_VERSION,
  PLATFORM,
  TARGET,
  TRANSPORT,
} from '../../config'
import { health, type HealthResponse } from '../../lib/api/client'

interface Check {
  name: string
  pass: boolean
  detail: string
}

Page({
  data: {
    /** 当前环境（local / dev / prod）—— 由平台 + 版本形态自动判定 */
    env: ENV,
    envLabel: ENV_LABEL[ENV],
    platform: PLATFORM,
    envVersion: ENV_VERSION,
    transport: TRANSPORT === 'container' ? 'wx.cloud.callContainer' : 'wx.request',
    target: TARGET,
    health: { ok: false, pending: true, text: '检查中…', engine: '-', detail: '' },
    /** 数据库子状态：只在有值时展示 */
    db: null as null | { ok: boolean; text: string; detail: string },
    checks: [] as Check[],
  },

  onLoad() {
    void this.checkHealth()
  },

  /**
   * 健康检查。
   * ⚠️ 失败时把 errMsg 原样展示 —— 「请求失败」这四个字对排查毫无帮助。
   */
  async checkHealth() {
    this.setData({
      health: { ok: false, pending: true, text: '检查中…', engine: '-', detail: '' },
      db: null,
    })
    try {
      const res: HealthResponse = await health()
      this.setData({
        health: { ok: res.status === 'ok', pending: false, text: '正常', engine: res.engine, detail: '' },
        db: this.describeDb(res),
      })
    } catch (err) {
      const msg = (err as Error).message || String(err)
      this.setData({
        health: { ok: false, pending: false, text: '连不上', engine: '-', detail: this.explain(msg) },
      })
      console.error('[health] 失败:', msg)
    }
  },

  /** 把 /health 里的数据库字段翻译成一句人话 */
  describeDb(res: HealthResponse): { ok: boolean; text: string; detail: string } | null {
    if (res.envError) {
      return { ok: false, text: '配置错误', detail: res.envError }
    }
    // ⭐ 以**实时探测**为准：db 只是启动时的缓存，数据库后来被销毁/暂停它不会变。
    if (res.dbLive && res.dbLive !== 'ok') {
      return {
        ok: false,
        text: res.dbLive === 'timeout' ? '实时探测超时' : '实时探测失败',
        detail:
          (res.migrateError || res.dbError || '') +
          '\n（启动时状态：' + (res.db ?? '未知') + '）—— 数据库可能已销毁或正在冷启动',
      }
    }
    if (!res.db) return null
    if (res.db === 'ready') {
      return {
        ok: true,
        text: res.migrated ? '已连接 · 迁移完成' : '已连接',
        detail: res.existingTables?.length ? '表：' + res.existingTables.join(', ') : '',
      }
    }
    if (res.db === 'connecting') {
      return { ok: false, text: `连接中（第 ${res.dbAttempts ?? '?'} 次）`, detail: res.dbError ?? '' }
    }
    return { ok: false, text: '连接失败', detail: res.migrateError || res.dbError || '' }
  },

  /** 把常见的 errMsg 翻译成可操作的提示（按当前模式给不同建议） */
  explain(msg: string): string {
    if (TRANSPORT === 'container') {
      return (
        '模式：cloud（wx.cloud.callContainer）\n' +
        '① 服务是否在跑：控制台看 dev 环境的 jushuo 服务\n' +
        '② 服务名必须是 ' + CLOUD_SERVICE + '（写错报 -601031）\n' +
        '③ 环境 ID 必须是 ' + CLOUD_ENV_ID + '（写错报 -601027）\n' +
        '④ 冷启动：缩容到 0 后首次请求要 30 秒，而 callContainer 超时上限只有 15 秒\n' +
        '   → 首次失败属预期，等一会儿重试即可\n\n' +
        '原始错误：' + msg
      )
    }
    if (msg.includes('url not in domain list')) {
      return '原因：域名未在白名单。解决：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」，然后重新编译。\n\n原始错误：' + msg
    }
    if (msg.includes('timeout')) {
      return '原因：请求超时。检查后端容器是否在跑（pnpm dev:docker:ps），以及手机/模拟器与电脑是否同一网络。\n\n原始错误：' + msg
    }
    if (msg.includes('fail')) {
      return (
        '原因：网络不可达。按顺序排查：\n\n' +
        '① ⭐ 最常见：开发者工具走了系统代理，而代理不转发本地地址。\n' +
        '   查：scutil --proxy  →  看 SOCKSEnable / HTTPEnable 是否为 1\n' +
        '   修：开发者工具 → 设置 → 代理设置 → 选「不使用代理」\n' +
        '   ⚠️ curl 默认不读 macOS 系统代理，「curl 能通」不代表工具能通。\n\n' +
        '② 后端是否在跑：pnpm dev:docker:ps（只起了 db 是不够的）\n' +
        '   该地址在浏览器里能否打开：' + BASE_URL + '/health\n\n' +
        '③ 真机模式下 localhost 指向手机自己，必须换成电脑局域网 IP\n' +
        '   （查法：ipconfig getifaddr en0）\n\n' +
        '原始错误：' + msg
      )
    }
    return '原始错误：' + msg
  },

  onRetry() {
    void this.checkHealth()
  },

  /** 去真机自检页（T1–T6） */
  onOpenSelftest() {
    wx.navigateTo({ url: '/pages/selftest/selftest' })
  },

  /** 复制诊断信息，方便贴到对话里 */
  onCopyDiagnostics() {
    const d = this.data.health
    const text = [
      '【句说 小程序诊断】',
      '环境: ' + this.data.env + '（' + this.data.envLabel + '）',
      '平台: ' + this.data.platform + '   版本形态: ' + this.data.envVersion,
      '通道: ' + this.data.transport,
      '目标: ' + this.data.target,
      '状态: ' + d.text,
      '引擎: ' + d.engine,
      '数据库: ' + (this.data.db ? this.data.db.text + ' ' + this.data.db.detail : '未上报'),
      '详情: ' + (d.detail || '无'),
      '系统: ' + wx.getSystemInfoSync().platform,
      '基础库: ' + wx.getSystemInfoSync().SDKVersion,
    ].join('\n')

    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  /**
   * 音频算法自检 —— 用 Worker 跑一遍纯函数。
   * 验证：① Worker 打包是否正常 ② 算法能否在端侧跑通
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
          { name: 'VAD', pass: true, detail: Math.round(r.vad.speechMs) + 'ms 语音' },
          { name: '音高分析', pass: true, detail: '起伏度 ' + r.pitch.variability.toFixed(3) },
        ],
      })
      // ⚠️ 必须 terminate —— Worker 最大并发 1 个，不释放则下次创建失败
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
