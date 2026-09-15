import {
  AUDIO_SPEC,
  computeFrameStats,
  detectPitch,
  frameAudio,
  isIntervalConsistent,
  judgeAudioRate,
  pcmInt16ToFloat32,
  pcmToWav,
  percentile,
  type FrameSample,
  type FrameStats,
} from '@jushuo/shared'
import { BUILD_TIME, ENV, ENV_LABEL, ENV_VERSION, PLATFORM } from '../../config'
import { Recorder } from '../../lib/audio/recorder'

/**
 * 真机自检页 —— 一次点击跑完 T1–T6。
 *
 * ⭐ 为什么这些测试必须真机、且不需要任何后端：
 *    T1–T6 全部只跟「录音 API」和「Worker」有关 ——
 *    不需要云托管、不需要讯飞密钥、不需要局域网、不需要后端。
 *    而 T1（onFrameRecorded 是否稳定回帧）是**方案级风险**：
 *    它挂了，「高频动作边际成本为 0」的前提就不成立，端侧架构要整个重来。
 *
 * ⚠️⚠️ 判定原则：**只检查自洽性，不写死期望值。**
 *    第一版把「帧应为 2048 字节 / 间隔应为 64ms」写死，结果在 iPhone 15 上误报两项失败 ——
 *    实际设备回的是 4096 字节 / 137ms，两者完全自洽，音频本身是对的。
 *    设备回多大一块不由我们决定，所以只能「测出来、再验它自洽」。
 *
 * ⚠️ 开发者工具拿不到麦克风，且 sampleRate 参数在 PC 上无效 —— 必须真机。
 * 依据：docs/experiments/validation-experiment.md
 */

const RECORD_MS = 5000
const BENCH_ROUNDS = 8
const WORKER_CYCLES = 10
/** 单帧处理耗时的上限：分析帧时长的 25% —— 慢 4 倍的设备也还能实时 */
const FRAME_BUDGET_MS = AUDIO_SPEC.frameMs * 0.25

interface Item {
  id: string
  title: string
  expected: string
  actual: string
  /** true 通过 / false 不通过 / null 无法判定 */
  pass: boolean | null
  note?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

Page({
  data: {
    env: '',
    running: false,
    phase: '待开始',
    hint: '点下面的按钮开始。全程约 15 秒，中间会让你朗读一句话。',
    items: [] as Item[],
    done: false,
    report: '',
    sweep: [] as string[],
  },

  onLoad() {
    this.setData({ env: `${ENV}（${ENV_LABEL[ENV]}） · ${PLATFORM}/${ENV_VERSION}` })
  },

  async onRunAll() {
    if (this.data.running) return
    this.setData({ running: true, done: false, items: [], report: '' })

    const items: Item[] = []
    const push = (i: Item) => {
      items.push(i)
      this.setData({ items: [...items] })
    }

    try {
      await this.stepWorkerLifecycle(push)
      await this.stepWorkerConcurrency(push)
      await this.stepBench(push)
      await this.stepRecord(push)
    } catch (err) {
      push({ id: 'FATAL', title: '自检中断', expected: '-', actual: (err as Error).message, pass: false })
    }

    this.setData({
      running: false,
      done: true,
      phase: '完成',
      hint: '点「复制报告」把结果发回来。',
      report: this.buildReport(items),
    })
  },

  // ----------------------------------------------------------------
  // T6 / T6b：Worker 生命周期与并发约束
  // ----------------------------------------------------------------
  async stepWorkerLifecycle(push: (i: Item) => void) {
    this.setData({ phase: 'T6 Worker 生命周期', hint: '自动进行，无需操作' })
    let ok = 0
    let failMsg = ''
    for (let i = 0; i < WORKER_CYCLES; i++) {
      try {
        await this.pingWorker()
        ok++
      } catch (err) {
        failMsg = (err as Error).message
        break
      }
    }
    push({
      id: 'T6',
      title: 'Worker 连续创建/销毁',
      expected: `${WORKER_CYCLES}/${WORKER_CYCLES} 成功`,
      actual: failMsg
        ? `${ok}/${WORKER_CYCLES} 成功；第 ${ok + 1} 次失败：${failMsg}`
        : `${ok}/${WORKER_CYCLES} 成功`,
      pass: ok === WORKER_CYCLES,
      note: '必须配对 terminate()，否则会撞「最大并发 1 个」的限制',
    })
  },

  pingWorker(timeoutMs = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
      let w: WechatMiniprogram.Worker | null = null
      const finish = (fn: () => void) => {
        clearTimeout(timer)
        try {
          w?.terminate()
        } catch {
          /* 已销毁 */
        }
        fn()
      }
      const timer = setTimeout(() => finish(() => reject(new Error('ping 超时'))), timeoutMs)
      try {
        w = wx.createWorker('workers/audio-analysis/index.js')
      } catch (err) {
        finish(() => reject(new Error('createWorker 抛异常：' + (err as Error).message)))
        return
      }
      w.onMessage((res) => {
        if ((res as unknown as { type: string }).type === 'pong') finish(resolve)
      })
      w.onError((err) => finish(() => reject(new Error('Worker onError：' + err))))
      w.postMessage({ type: 'ping', seq: 1 })
    })
  },

  async stepWorkerConcurrency(push: (i: Item) => void) {
    this.setData({ phase: 'T6b Worker 并发约束', hint: '自动进行，无需操作' })
    let first: WechatMiniprogram.Worker | null = null
    let second: WechatMiniprogram.Worker | null = null
    let outcome = ''
    const pass: boolean | null = null

    try {
      first = wx.createWorker('workers/audio-analysis/index.js')
      await sleep(300)
      try {
        second = wx.createWorker('workers/audio-analysis/index.js')
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('第二个 Worker ping 超时')), 4000)
          second?.onMessage((res) => {
            if ((res as unknown as { type: string }).type === 'pong') {
              clearTimeout(timer)
              resolve()
            }
          })
          second?.postMessage({ type: 'ping', seq: 2 })
        })
        outcome = '未 terminate 也能再建一个，且第二个能正常收发'
      } catch (err) {
        outcome = '未 terminate 时再建失败：' + (err as Error).message
      }
    } finally {
      try {
        second?.terminate()
      } catch {
        /* ignore */
      }
      try {
        first?.terminate()
      } catch {
        /* ignore */
      }
    }

    push({
      id: 'T6b',
      title: 'Worker 并发违规表现',
      expected: '行为待记录（不计通过/失败）',
      actual: outcome,
      pass,
      note: '探测性测试：只要 T6 能稳定配对，本项目就永远不会走到这条路径',
    })
  },

  // ----------------------------------------------------------------
  // T5：Worker 内单帧音高检测耗时
  // ----------------------------------------------------------------
  async stepBench(push: (i: Item) => void) {
    this.setData({ phase: 'T5 Worker 计算耗时', hint: '自动进行，无需操作' })

    // 造 5 秒伪语音：140Hz 基频 + 泛音 + 轻噪声，足够让 YIN 真的跑起来
    const sr = AUDIO_SPEC.sampleRate
    const pcm = new Int16Array(sr * 5)
    for (let i = 0; i < pcm.length; i++) {
      const t = i / sr
      const v =
        Math.sin(2 * Math.PI * 140 * t) * 0.5 +
        Math.sin(2 * Math.PI * 280 * t) * 0.3 +
        Math.sin(2 * Math.PI * 560 * t) * 0.15 +
        (Math.random() - 0.5) * 0.05
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 20000)))
    }

    interface BenchResult {
      frames: number
      p50Ms: number
      p95Ms: number
      maxMs: number
      minMs: number
    }
    const res = await new Promise<BenchResult>((resolve, reject) => {
      const w = wx.createWorker('workers/audio-analysis/index.js')
      const timer = setTimeout(() => {
        try {
          w.terminate()
        } catch {
          /* ignore */
        }
        reject(new Error('bench 超时'))
      }, 30000)
      w.onMessage((msg) => {
        // ⚠️ Worker 回调参数类型与自定义消息结构不重叠，必须过 unknown
        const r = msg as unknown as { type: string } & BenchResult
        if (r.type !== 'benchResult') return
        clearTimeout(timer)
        try {
          w.terminate()
        } catch {
          /* ignore */
        }
        resolve(r)
      })
      w.onError((err) => {
        clearTimeout(timer)
        reject(new Error('bench onError：' + err))
      })
      w.postMessage({ type: 'bench', buffer: pcm.buffer, rounds: BENCH_ROUNDS })
    })

    // ⭐ 顺带测一次「引擎本身有多快」：用来解释 iOS / Android 之间 13 倍的差距
    let micro = ''
    try {
      const m = await this.microBench()
      micro = `；引擎基准 ${m.opsPerMs.toFixed(0)} ops/ms（${m.ms}ms / ${m.iterations / 1000}k 次）`
    } catch {
      micro = '；引擎基准测试失败'
    }

    const usedPct = (res.p95Ms / AUDIO_SPEC.frameMs) * 100
    push({
      id: 'T5',
      title: 'Worker 单帧音高检测耗时',
      expected: `P95 < ${FRAME_BUDGET_MS}ms（分析帧时长 ${AUDIO_SPEC.frameMs}ms 的 25%）`,
      actual:
        `P50 ${res.p50Ms.toFixed(2)}ms / P95 ${res.p95Ms.toFixed(2)}ms ` +
        `→ 占帧预算 ${usedPct.toFixed(0)}%，余量 ${(AUDIO_SPEC.frameMs / res.p95Ms).toFixed(1)}×` +
        `（${res.frames} 帧 × ${BENCH_ROUNDS} 轮）${micro}`,
      pass: res.p95Ms < FRAME_BUDGET_MS,
      note:
        '判据是「能不能实时」：单帧处理必须远快于帧时长。' +
        `P95 只要低于 ${FRAME_BUDGET_MS}ms，即使设备再慢 4 倍也还跟得上。`,
    })
  },

  /** 纯算术微基准 —— 用来判断 iOS / Android 的性能差距是不是引擎级的 */
  microBench(iterations = 1_000_000): Promise<{ iterations: number; ms: number; opsPerMs: number }> {
    return new Promise((resolve, reject) => {
      const w = wx.createWorker('workers/audio-analysis/index.js')
      const timer = setTimeout(() => {
        try {
          w.terminate()
        } catch {
          /* ignore */
        }
        reject(new Error('microbench 超时'))
      }, 8000)
      w.onMessage((msg) => {
        const r = msg as unknown as { type: string; iterations: number; ms: number; opsPerMs: number }
        if (r.type !== 'microbenchResult') return
        clearTimeout(timer)
        try {
          w.terminate()
        } catch {
          /* ignore */
        }
        resolve(r)
      })
      w.onError((err) => {
        clearTimeout(timer)
        reject(new Error('microbench onError：' + err))
      })
      w.postMessage({ type: 'microbench', iterations })
    })
  },

  // ----------------------------------------------------------------
  // T1–T4：真机录音
  // ----------------------------------------------------------------
  ensureRecordPermission(): Promise<void> {
    return new Promise((resolve, reject) => {
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.record']) {
            resolve()
            return
          }
          wx.authorize({
            scope: 'scope.record',
            success: () => resolve(),
            fail: () =>
              reject(new Error('麦克风权限被拒绝。请点右上角「…」→ 设置 → 打开「麦克风」，再重试。')),
          })
        },
        fail: () => resolve(),
      })
    })
  },

  /** 录一段，返回帧样本与总字节数 */
  recordOnce(durationMs: number, frameSizeKb?: number): Promise<{
    samples: FrameSample[]
    totalBytes: number
    durationMs: number
  }> {
    return new Promise((resolve, reject) => {
      const samples: FrameSample[] = []
      const rec = new Recorder({
        onFrame: (buf) => samples.push({ bytes: buf.byteLength, t: Date.now() }),
        onStop: (pcm, durationMs) => resolve({ samples, totalBytes: pcm.byteLength, durationMs }),
        onError: (err) => reject(err),
      })
      rec.start(frameSizeKb === undefined ? {} : { frameSizeKb })
      setTimeout(() => rec.stop(), durationMs)
      setTimeout(() => reject(new Error('录音超时，onStop 未触发')), durationMs + 8000)
    })
  },

  async stepRecord(push: (i: Item) => void) {
    await this.ensureRecordPermission()
    const sentence = 'The only way to do great work is to love what you do.'
    for (let i = 3; i > 0; i--) {
      this.setData({
        phase: `T1–T4 录音（${i} 秒后开始）`,
        hint: '准备好，等下请朗读：' + sentence,
      })
      await sleep(1000)
    }
    this.setData({
      phase: `T1–T4 录音中（${RECORD_MS / 1000} 秒）`,
      hint: '⭐ 现在开始朗读 → ' + sentence,
    })

    const r = await this.recordOnce(RECORD_MS)
    this.analyzeRecording(r.samples, r.totalBytes, r.durationMs, push)
  },

  analyzeRecording(
    samples: FrameSample[],
    fallbackBytes: number,
    fallbackMs: number,
    push: (i: Item) => void,
  ) {
    const s = computeFrameStats(samples, fallbackBytes, fallbackMs)

    // ---- T1：有没有回帧（方案级风险）----
    push({
      id: 'T1',
      title: 'onFrameRecorded 是否回帧',
      // ⚠️ 不写死帧数：帧大小由设备决定，帧数随之变化
      expected: '≥ 1 帧（帧数由设备帧大小决定，不预设）',
      actual: s.count > 0 ? `${s.count} 帧 / ${RECORD_MS}ms` : '0 帧 —— 完全没有回调',
      pass: s.count > 0,
      note: '⚠️ 方案级风险：不回帧则端侧实时分析不可行',
    })
    if (s.count === 0) {
      push({ id: 'T2', title: '帧大小 / 间隔', expected: '-', actual: '无帧数据，无法计算', pass: false })
      return
    }

    // ---- T2a：帧大小（判定稳定性，不判定具体值）----
    push({
      id: 'T2a',
      title: '帧字节数',
      expected: '偶数 + 众数占比 ≥90%（具体大小由设备决定）',
      actual:
        `众数 ${s.frameBytes} 字节（占比 ${(s.frameBytesStability * 100).toFixed(0)}%），` +
        `末帧 ${s.lastFrameBytes} 字节`,
      pass: s.frameBytes > 0 && s.frameBytes % 2 === 0 && s.frameBytesStability >= 0.9,
      note:
        `我们请求 frameSize=${AUDIO_SPEC.frameSizeKb}KB（${AUDIO_SPEC.frameSizeKb * 1024} 字节），` +
        '⛔ 但那是请求值不是契约 —— 设备可能向上取整到原生缓冲大小。此处只验「稳定且是 16bit 整数倍」。',
    })

    // ---- T2b：帧间隔与帧大小是否自洽 ----
    const selfConsistent = isIntervalConsistent(s.intervalP50, s.impliedFrameMs)
    push({
      id: 'T2b',
      title: '帧间隔（与帧大小自洽）',
      expected: `≈ ${s.impliedFrameMs.toFixed(0)}ms（= 帧字节数 ÷ 实测字节率）`,
      actual: s.count >= 2 ? `P50 ${s.intervalP50}ms（${s.intervalMin}–${s.intervalMax}ms）` : '只有 1 帧',
      pass: s.count >= 2 && selfConsistent,
      note:
        '⚠️ 判据是**自洽**而非某个绝对值：帧越大间隔就越长，两者必须对得上。' +
        `若按「分析帧 ${AUDIO_SPEC.frameMs}ms」去套就会误判 —— 第一版就是这么错的。`,
    })

    // ---- T2c：帧完整性（有没有丢帧）----
    const impliedBytes = s.count * s.frameBytes
    const integrity = s.totalBytes > 0 ? impliedBytes / s.totalBytes : 0
    push({
      id: 'T2c',
      title: '帧完整性',
      expected: '帧数 × 帧大小 ≈ 总字节数（±15%）',
      actual: `${s.count} × ${s.frameBytes} = ${impliedBytes} vs 实测 ${s.totalBytes} 字节（比值 ${integrity.toFixed(3)}）`,
      pass: integrity > 0.85 && integrity < 1.15,
      note: '比值明显小于 1 说明有帧被丢弃；明显大于 1 说明统计口径不对',
    })

    // ---- T3+T4：音频速率（采样率 × 声道）----
    const v = s.sampleRateTimesChannels
    // ⭐ 判定逻辑在 @jushuo/shared 里（纯函数，有基于真机数据的回归测试）
    const judged = judgeAudioRate(v)
    const verdict = judged.verdict
    const pass = judged.pass
    push({
      id: 'T3+T4',
      title: '采样率 × 声道',
      expected: '16000（16kHz × 单声道）',
      actual: `${Math.round(v)}  →  ${verdict}（每秒 ${Math.round(s.bytesPerSec)} 字节）`,
      pass,
      note:
        '⭐ 这一项才是判断「音频对不对」的关键（T2a/T2b 只是在验自洽）。' +
        '每秒字节数 ÷ 2（16bit）= 采样率 × 声道。⚠️ 只能测出乘积，用 1kHz 精测可进一步区分。',
    })
  },

  // ----------------------------------------------------------------
  // 帧大小扫描：实测 frameSize 到底有没有被采纳
  // ----------------------------------------------------------------
  async onSweepFrameSize() {
    if (this.data.running) return
    this.setData({ running: true, sweep: [], phase: '扫描 frameSize', hint: '全程约 8 秒，不用出声' })

    const lines: string[] = []
    try {
      await this.ensureRecordPermission()
      for (const kb of [1, 2, 4, 8]) {
        this.setData({ phase: `扫描 frameSize=${kb}KB`, hint: `第 ${[1, 2, 4, 8].indexOf(kb) + 1}/4 次，约 2 秒` })
        const r = await this.recordOnce(1500, kb)
        const s = computeFrameStats(r.samples, r.totalBytes, r.durationMs)
        const line =
          `请求 ${kb}KB（${kb * 1024} 字节）→ 实际 ${s.frameBytes} 字节，` +
          `${s.count} 帧，间隔 ${s.intervalP50}ms`
        lines.push(line)
        this.setData({ sweep: [...lines] })
        await sleep(300)
      }
      this.setData({ running: false, phase: '扫描完成', hint: '看下面的结果判断 frameSize 有没有被采纳' })
    } catch (err) {
      this.setData({ running: false, phase: '扫描失败', hint: (err as Error).message })
    }
  },

  // ----------------------------------------------------------------
  // T3 精测：放 1kHz 标准音同时录音
  // ----------------------------------------------------------------
  async onTestTone() {
    if (this.data.running) return
    this.setData({
      running: true,
      phase: 'T3 精测：播放 1kHz 标准音',
      hint: '手机音量调到 50% 左右，正常拿在手里，等下会自动播一声',
    })

    try {
      await this.ensureRecordPermission()
      const sr = AUDIO_SPEC.sampleRate
      const pcm = new Int16Array(Math.floor(sr * 2.5))
      for (let i = 0; i < pcm.length; i++) {
        const fade = Math.min(1, i / (sr * 0.05), (pcm.length - i) / (sr * 0.05))
        pcm[i] = Math.round(Math.sin((2 * Math.PI * 1000 * i) / sr) * 20000 * fade)
      }
      const wav = pcmToWav(pcm.buffer, sr, 1, 16)
      const path = `${wx.env.USER_DATA_PATH}/tone-1k.wav`
      wx.getFileSystemManager().writeFileSync(path, wav)

      const recording = new Promise<ArrayBuffer>((resolve, reject) => {
        const rec = new Recorder({
          onStop: (all) => resolve(all),
          onError: (e) => reject(e),
        })
        rec.start()
        const audio = wx.createInnerAudioContext()
        audio.src = path
        audio.onError((e) => console.error('[tone] 播放失败', e))
        audio.play()
        setTimeout(() => {
          rec.stop()
          audio.destroy()
        }, 3000)
        setTimeout(() => reject(new Error('录音超时，onStop 未触发')), 11000)
      })

      const all = await recording
      const floats = pcmInt16ToFloat32(new Uint8Array(all))
      const chunks = frameAudio(floats, AUDIO_SPEC.frameSamples)
      const pitches: number[] = []
      for (const f of chunks) {
        const hz = detectPitch(f, sr, { minHz: 300, maxHz: 3000 })
        if (hz > 0) pitches.push(hz)
      }
      pitches.sort((a, b) => a - b)
      const median = percentile(pitches, 0.5)

      let verdict = '没检测到 1000Hz 附近的声音（可能被环境噪声盖过）'
      if (median > 0) {
        if (Math.abs(median - 1000) < 120) {
          verdict = `检测到 ${Math.round(median)}Hz ≈ 1000Hz ✅ 真实采样率确实是 16kHz`
        } else if (Math.abs(median - 500) < 80) {
          verdict = `检测到 ${Math.round(median)}Hz ≈ 500Hz ❌ 真实采样率是 8kHz`
        } else {
          verdict = `检测到 ${Math.round(median)}Hz，不在 1000/500 附近，需人工判断`
        }
      }
      this.setData({ running: false, phase: 'T3 精测完成', hint: verdict })
      wx.showModal({
        title: 'T3 精测结果',
        content: verdict + `\n\n浊音帧 ${pitches.length}/${chunks.length}`,
        showCancel: false,
      })
    } catch (err) {
      const msg = (err as Error).message
      this.setData({ running: false, phase: 'T3 精测失败', hint: msg })
      wx.showModal({ title: 'T3 精测失败', content: msg, showCancel: false })
    }
  },

  // ----------------------------------------------------------------
  // 报告
  // ----------------------------------------------------------------
  buildReport(items: Item[]): string {
    const sys = wx.getSystemInfoSync()
    const mark = (v: boolean | null) => (v === true ? '✅' : v === false ? '❌' : '➖')
    const lines = [
      '【句说 · 真机自检报告】',
      `环境: ${this.data.env}`,
      `平台: ${sys.platform}  ${sys.model ?? ''}`,
      `系统: ${sys.system ?? '-'}`,
      `微信基础库: ${sys.SDKVersion}`,
      `运行时间: ${new Date().toLocaleString()}`,
      `构建时间: ${BUILD_TIME}`,
      '',
    ]
    for (const it of items) {
      lines.push(`${mark(it.pass)} ${it.id} ${it.title}`)
      lines.push(`     期望: ${it.expected}`)
      lines.push(`     实测: ${it.actual}`)
      if (it.note) lines.push(`     备注: ${it.note}`)
    }
    if (this.data.sweep.length > 0) {
      lines.push('', '【frameSize 扫描】', ...this.data.sweep.map((s) => '  ' + s))
    }
    return lines.join('\n')
  },

  onCopy() {
    if (!this.data.report) {
      wx.showToast({ title: '还没有报告', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.report,
      success: () => wx.showToast({ title: '已复制，贴回对话即可', icon: 'none' }),
    })
  },
})
