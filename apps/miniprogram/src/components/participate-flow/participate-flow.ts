import { plainWordsOf } from '@jushuo/shared'

import { claimCookies, fetchEnergy, fetchSubmissionStatus, submitReading } from '../../lib/api/client'
import { newAttemptId, uploadAudio } from '../../lib/api/upload'
import {
  clearParticipate,
  loadParticipate,
  saveParticipate,
  type ParticipateCache,
} from '../../lib/participate-cache'
import { displayScoreOf, recordStateOf, type PendingSubmission, type RecordState } from '../../lib/record-state'

/**
 * ⭐⭐ **participate-flow —— 一次"参与"的完整编排**（prd §7.2，用户 2026-10 定）。
 *
 * ## 为什么要它
 *
 * 首页的 `lg` 卡要**原地参与**，详情页（`pages/arena`）也要在**同一句**上参与 ——
 * 两条路的流程**一模一样**：弹 recorder → 漏读粗筛 → energy-tips → 提交轮询 → 出分面板 → 确认。
 * ⭐ 各写一份必然长歪（而且"确认才结算"这种口径错一处就是数据问题）⇒ **编排只此一处**。
 *
 * ## 它自己就是那三块浮层的宿主
 *
 * `recorder`（录音）/ `energy-tips`（能量）/ `score-panel`（出分）都在它的 WXML 里，
 * ⚠️ 所以**宿主页面只需要**：① 放一个 `<participate-flow>`；② 点麦时调 `open()`；
 * ③ 听 `state` 事件把状态喂给卡片。**页面里没有一行录音/提交代码**。
 *
 * ## ⚠️⚠️ 状态是「端侧缓存 + 服务端」拼出来的，不是内存里的一次快照
 *
 * | 态 | 来源 |
 * |---|---|
 * | `recoded` | **端侧缓存**（那段没提交的录音） |
 * | `checking` / `scored` | 端侧缓存的 submissionId + **服务端**轮询回来的 status/confirmed |
 * | `retry` / `try` | **服务端**参与记录（宿主通过 `bestScore` 传进来） |
 *
 * ⚠️ 出分那一刻用户可能**不在这个页面上**（甚至关掉小程序）——
 *    所以"未确认的那一把"必须能在下次进来时**重新拼出来**（见 lib/participate-cache.ts）。
 */
/** 不该走 setData 的内部状态（见下面 data.scratch 的说明） */
interface Scratch {
  /** 这一句的端侧缓存（录音 + 幂等键 + submissionId） */
  cache: ParticipateCache | null
  /** 这一把的分数（`scored` 态显示它，还没写进战绩） */
  pendingScore: number | null
  /** 本会话已经真正拿到结果的 submissionId（空 = 还没拿到） */
  resultOf: string
  /** 已经自动弹过面板的 submissionId */
  popped: string
  /** 这一轮轮询是「进页面补问」吗（= 不自动弹面板） */
  silent: boolean
  /** 这一把录音的时长（服务端结果里给的，比本地缓存准） */
  pendingDurationMs: number
  pollTimer: ReturnType<typeof setInterval> | null
  pollCount: number
}

/** 提交之后多久问一次状态 */
const POLL_MS = 1500
/** 最多问这么多次（之后不再自动问；用户可以手动重试，状态仍在，见 prd） */
const POLL_MAX = 80
/** 录音短于这个时长直接判"没读"（绝对下限；再和标准音比一次） */
const MIN_RECORD_MS = 1500

Component({
  properties: {
    /** 当前这一句 */
    articleId: { type: String, value: '' },
    /** 正文 —— 粗筛要词数（⚠️ 不能只看词表：词表为空时静音自停会静默失效） */
    text: { type: String, value: '' },
    /** 标准音时长（毫秒）—— 录音面板的静音自停与粗筛都用它 */
    stdDurationMs: { type: Number, value: 0 },
    /** 服务端参与记录里的战绩分（< 0 = 明确没参与过）—— 由宿主从 store 传进来 */
    bestScore: { type: Number, value: -1 },
  },

  data: {
    // ── 录音面板 ──
    recorderVisible: false,
    // ── 能量面板 ──
    energyVisible: false,
    energyPhase: 'precheck' as 'precheck' | 'ask',
    cost: 0,
    balance: 0,
    // ── 粗筛/错误提示（本地小面板，不是组件：它只属于这条流程）──
    notice: '',
    noticeVisible: false,
    // ── 出分面板 ──
    panelVisible: false,
    panelState: 'update' as 'update' | 'keep',
    panelScore: 0,
    panelPrev: -1,
    panelParts: null as unknown,
    panelText: '',
    panelWords: [] as unknown[],
    panelCookies: -1,
    /**
     * ⭐ 词数 —— 录音面板的**静音自停**要用它。
     * ⚠️⚠️ 必须由**正文**兜底算出来：`autoStopAfter` 的第一条就是 `wordCount <= 0 ⇒ false`，
     *    而词表为空时它就是 0 ⇒ **自动结束静默失效**（真实事故：那条文章的 words 是 []）。
     */
    wordCount: 0,
    /** 当前状态（宿主拿去喂卡片） */
    state: 'try' as RecordState,
    /** 参与区显示的分数（< 0 = 不显示） */
    score: -1,
    /**
     * ⚠️ 不走 setData 的内部状态（放 data 只为有个类型明确的家）。
     * ⚠️ 也**不能**用自定义实例字段：小程序的 TS 会因此把 methods 全推成可选。
     */
    scratch: {
      cache: null,
      pendingScore: null,
      /**
       * ⭐ **本会话已经真正拿到结果**的那一把（submissionId）。
       * ⚠️⚠️ 它是 `scored` 与 `checking` 的**唯一**分界 —— 缓存里只有 submissionId 时
       *    **不许**假设已出分（那正是「点完能量就冒出历史最高分」的根因之一）。
       */
      resultOf: '',
      /** 这一把的结果面板已经自动弹过了吗 —— 避免每次进页面都弹一次 */
      popped: '',
      silent: false,
      pendingDurationMs: 0,
      pollTimer: null,
      pollCount: 0,
    } as Scratch,
  },

  observers: {
    /** 换句子 ⇒ 重新拼一次状态（首页会在多张卡之间切换） */
    'articleId, bestScore'() {
      this.setData({ wordCount: plainWordsOf(this.data.text ?? '').length })
      this.restore()
    },
  },

  lifetimes: {
    attached() {
      this.setData({ wordCount: plainWordsOf(this.data.text ?? '').length })
      this.restore()
    },
    detached() {
      this.stopPoll()
    },
  },

  methods: {
    // ── 状态拼装 ───────────────────────────────────────────────
    /**
     * ⭐ 从「端侧缓存 + 服务端战绩」重新拼出五态之一。
     * ⚠️ 每一处会改变状态的地方（录完 / 提交 / 出分 / 确认）都要调它 ——
     *    状态是**拼**出来的，不是一步步改出来的（改出来就会漏一条路径）。
     */
    restore() {
      const articleId = this.data.articleId
      if (!articleId) return
      const cache = loadParticipate(articleId)
      this.data.scratch.cache = cache

      const best = Number(this.data.bestScore)
      const bestScore = best >= 0 ? best : null

      /**
       * ⚠️⚠️ **缓存里只有 submissionId 时，绝不假设「已出分」**（2026-10-15 修的真实 bug）。
       *
       *    原来这里写死 `status: 'scored'` ⇒ 点完能量确认、submissionId 刚落库那一刻，
       *    状态机立刻判成 `scored` ⇒ 卡片显示「分数 + ›」，而那个分数还是**历史最高**
       *    （见 displayScoreOf 的说明）。用户看到的是一把**还没跑完**的检测，
       *    配上一个不属于它的分。
       *
       *    ⇒ 判据只能是「**本会话真的拿到结果了吗**」：
       *       · 拿到了（`scratch.resultOf` 就是它）⇒ `scored`
       *       · 没拿到 ⇒ `scoring` ⇒ 状态是 **`checking`（转圈）** —— 这才是提交后该有的样子
       *    ⚠️ 于是「上次离开时还没结清的那一把」进来时也是 `checking`，
       *       轮询一次之后自然落成 `scored` / `failed`（多一次请求，换的是**不撒谎**）。
       */
      const knownResult = this.data.scratch.resultOf
      const pending: PendingSubmission | null =
        cache && cache.submissionId
          ? {
              submissionId: cache.submissionId,
              status: knownResult === cache.submissionId ? 'scored' : 'scoring',
              confirmed: cache.confirmed,
            }
          : null

      const state = recordStateOf({
        bestScore,
        hasPendingRecording: Boolean(cache && cache.audioPath && !cache.submissionId),
        pending,
      })

      const score = displayScoreOf(state, {
        bestScore,
        pendingScore: this.data.scratch.pendingScore,
      })

      this.setData({ state, score: score === null ? -1 : score })
      /**
       * ⭐ 宿主据此更新卡片（卡片不自己算状态）。
       * ⚠️ 一起给**我那段录音的时长** —— 参与区那颗试听要显示成 00:33（设计稿 539:871）。
       *    优先用"这把结果里的时长"（服务端记录的），否则用本地缓存里那段录音的。
       */
      const durationMs = this.data.scratch.pendingDurationMs || cache?.durationMs || 0
      this.triggerEvent('state', { articleId, state, score, durationMs })

      /** 有在路上的提交 ⇒ 接着问（可能上次离开时还没出分） */
      /**
       * ⚠️ 这一次是「**进来补问**」（不是用户刚提交）⇒ `silent`：
       *    把状态补对就够了，**不要**自动弹面板 —— 用户没在等它。
       */
      if (pending && !cache?.confirmed && this.data.state === 'checking') this.startPoll(true)
    },

    // ── ① 点麦 ────────────────────────────────────────────────
    /** ⭐ 宿主在用户点了参与区那颗麦/胶囊时调它 */
    open() {
      if (!this.data.articleId) return
      const cache = loadParticipate(this.data.articleId)
      /** ⚠️ 已经有一段没提交的录音时不重录（那是"重录"那条路，见 onRedo） */
      if (cache && cache.audioPath && !cache.submissionId) return
      this.setData({ recorderVisible: true })
    },

    /** `recoded` 的 ↺ —— 重录：丢掉旧那段再录（⚠️ 幂等键也跟着换新，因为文件变了） */
    onRedo() {
      const articleId = this.data.articleId
      if (!articleId) return
      /** ⚠️ `checking` 不给退：那一段已经交上去在云里算了（稿里那颗 ↺ 正是禁用态 0.2） */
      if (this.data.state === 'checking') return

      /** ⚠️ 文案跟着**代价**走：`recoded` 丢的是录音，`scored` 丢的是"还没确认的这一把" */
      const scored = this.data.state === 'scored'
      wx.showModal({
        title: scored ? '放弃这一把？' : '重新录音？',
        content: scored
          ? '这一把还没确认，放弃后不会算进战绩，这段录音也会从本机删掉。'
          : '当前这段录音会被删掉，需要重新读一遍。',
        confirmText: scored ? '放弃' : '重新录',
        cancelText: '再想想',
        success: (r) => {
          if (r.confirm) this.discardRecording()
        },
      })
    },

    /**
     * ⭐⭐ **`↺` = 放弃这一把，回到大 `try` / `retry` 态**（用户 2026-10-15 定）。
     *
     *    「↺ 点击后**本质是恢复大 try/retry 状态**，并**清除掉录好的声音**，
     *      建议清除前可以让用户确认下清除。」
     *
     * ⚠️⚠️ **顺序是有讲究的：先问一次 → 确认后清掉 → 回到 `try`/`retry`**，
     *    **不**自动开录音面板。两个理由：
     *    ① 清掉那段录音**不可撤销** ⇒ 不问一次，手一抖就没了；
     *    ② 它是"**我不想录了**"的唯一落脚点 ⇒ 否则用户只能退页面。
     *    要录，用户自己点那颗麦克风（`try`/`retry` 上唯一显眼的动作）。
     *
     * ⚠️ 服务端那一行**不动**：`scored` 放弃之后它永远停在未确认、音频也不清理
     *    —— 这正是 prd §7.2「永不确认 ⇒ 永远停在 scored」。这里清的只是**本机这一份**。
     */
    discardRecording() {
      const articleId = this.data.articleId
      if (articleId) clearParticipate(articleId)
      this.data.scratch.cache = null
      this.data.scratch.pendingScore = null
      this.data.scratch.resultOf = ''
      this.data.scratch.pendingDurationMs = 0
      this.data.scratch.popped = ''
      /** ⚠️ 还在轮询这一把就得停掉 —— 否则清完缓存，轮询回来又会把状态写成 scored */
      this.stopPoll()
      this.restore()
    },

    // ── ② 录完 ────────────────────────────────────────────────
    onRecorderDone(e: WechatMiniprogram.CustomEvent<{ audioPath: string; durationMs: number }>) {
      const { audioPath, durationMs } = e.detail
      const articleId = this.data.articleId
      if (!articleId || !audioPath) return

      /**
       * ⭐ 幂等键在**这一刻**诞生，之后重试一直复用它
       *    （见 lib/api/upload.ts 的 newAttemptId：换了 key 就等于"又提交了一次"）。
       */
      const cache: ParticipateCache = {
        audioPath,
        durationMs,
        attemptId: newAttemptId(),
        submissionId: '',
        confirmed: false,
      }
      saveParticipate(articleId, cache)
      this.data.scratch.cache = cache
      this.setData({ recorderVisible: false })
      this.restore()

      /**
       * ⚠️⚠️ **"录完"就是"录完"，这里不许做任何判定**。
       *
       *    粗筛的唯一触发点是 **`recoded` 上那颗 `✓`**（见 `onConfirm`）——
       *    在录音刚停时就判，等于替用户"提前下结论"，而且它盖在"结束录音"那条路上，
       *    **看起来像录音本身出了问题**（其实录音一切正常，只是短）。
       *    ⚠️ 判据与顺序写在 `precheck()` 上（必须落在 `energy-tips` 之前 —— 粗筛的意义是省能量）。
       */
    },

    onRecorderFail(e: WechatMiniprogram.CustomEvent<{ message?: string }>) {
      this.setData({ recorderVisible: false })
      this.showNotice(e.detail?.message || '录音失败，请重试')
    },

    /**
     * ⭐ **漏读粗筛**（prd §7.2「漏读粗筛」，2026-10 定）—— 点 `✓` 之后、energy-tips **之前**。
     *
     * ⚠️⚠️ **全流程只有这一个触发点**（`onConfirm`）—— **不许**在"录完"那一刻也调一次。
     *    用户 2026-10-15 明确报过这个错：「结束就是结束，声音太短不符合提交
     *    **应该放到 recoded 用户点击确认后提示**」。
     *    ⚠️ 在录音结束时就弹，等于替用户"提前下结论"，而且它盖在"结束录音"那条路上，
     *      看起来像录音本身出了问题（其实录音一切正常，只是短）。
     *
     * ⚠️⚠️ 它**只能用本地现成的数据**（录音时长 vs 标准音时长），因为端侧识别已经砍掉
     *    （`onPartial` 没了 ⇒ `r.text` 恒 null ⇒ 精确到"哪个词漏了"本地判不出来）。
     *    所以这一道是**粗筛**：省能量用的，措辞是"**好像没读完，建议重读**"；
     *    精确到词的漏读反馈归**出分面板**（引擎逐词 `dp` + 完整维度 + 逐词标色）。
     * ⚠️ 判据拿不到（没标准音时长）时**一律放行** —— 宁可不拦，也不猜。
     */
    precheck(recordedMs: number): boolean {
      const std = Number(this.data.stdDurationMs)
      if (recordedMs < MIN_RECORD_MS) {
        this.showNotice('这次只录到 ' + Math.round(recordedMs / 1000) + ' 秒，太短了 —— 请完整读一遍')
        return false
      }
      /**
       * ⚠️ 与标准音比用的是**宽**阈值（0.6）：
       *    录音时长含"开口前的停顿"和收尾窗口，而插件不给逐词时间戳，
       *    拿不到真正的开口时刻 ⇒ 卡太紧会把正常的快读拦下来。
       */
      if (std > 2000 && recordedMs < std * 0.6) {
        this.showNotice('好像没读完，建议重新读一遍')
        return false
      }
      return true
    },

    // ── ③ 提交（`recoded` 的 ✓）────────────────────────────────
    onConfirm() {
      const cache = this.data.scratch.cache
      if (!cache || !cache.audioPath) return
      if (!this.precheck(cache.durationMs)) return
      this.openEnergy()
    },

    showNotice(message: string) {
      this.setData({ notice: message, noticeVisible: true })
    },
    onNoticeClose() {
      this.setData({ noticeVisible: false })
    },

    // ── ④ 能量面板 ────────────────────────────────────────────
    /**
     * ⚠️ 余额**问服务端要**（`fetchEnergy` 顺带做当天补足）——
     *    端侧绝不自己算余额，那是第二份真相。
     */
    async openEnergy() {
      this.setData({ energyVisible: true, energyPhase: 'precheck' })
      try {
        const r = await fetchEnergy()
        this.setData({ energyPhase: 'ask', cost: r.perChallenge, balance: r.energy })
      } catch {
        /**
         * ⚠️ 权威检查没做完（连不上 / 身份过期）⇒ **不摆一个没有出口的弹窗**：
         *    关掉它，在页面上挂一句人话 —— 用户此刻要做的是"检查网络、再点一次"。
         */
        this.setData({ energyVisible: false })
        this.showNotice('没连上服务器，再点一次')
      }
    },

    /** 取消 ⇒ 面板关掉，入口**停在 recoded**（录音还在、状态不变） */
    onEnergyCancel() {
      this.setData({ energyVisible: false })
    },

    onEnergyGo() {
      this.setData({ energyVisible: false })
      wx.navigateTo({ url: '/pages/me/energy/energy' })
    },

    async onEnergyConfirm() {
      this.setData({ energyVisible: false })
      await this.submit()
    },

    // ── ⑤ 上传 + 提交 + 轮询 ──────────────────────────────────
    async submit() {
      const { articleId } = this.data
      const cache = this.data.scratch.cache
      if (!articleId || !cache || !cache.audioPath) return

      try {
        const up = await uploadAudio(cache.audioPath, { articleId, attemptId: cache.attemptId })
        const res = await submitReading(articleId, up.audioKey, up.audioUrl, false, cache.attemptId)

        const next: ParticipateCache = { ...cache, submissionId: res.submissionId, confirmed: res.confirmed }
        saveParticipate(articleId, next)
        this.data.scratch.cache = next
        /**
         * ⚠️⚠️ **刚落库的这一把，结果是"未知"** ⇒ `resultOf` 必须清空，
         *    否则 `restore()` 会以为已经拿到结果、把状态判成 `scored`（那正是"点完能量
         *    就冒出分数"的直接原因）。
         *    ⭐ 清空之后状态就是 **`checking`（转圈）** —— 提交后该有的样子。
         */
        this.data.scratch.resultOf = ''
        this.data.scratch.popped = ''
        /** ⭐ 已有 result（幂等命中，例如同一段音频重发）⇒ 直接进 scored，不必轮询 */
        if (res.result) this.data.scratch.resultOf = res.submissionId
        if (res.status === 'scored' && res.result) this.applyResult(res, true)
        this.restore()
        if (res.status !== 'scored') this.startPoll()
      } catch (err) {
        this.showNotice((err as Error).message || '提交失败，请重试')
      }
    },

    /**
     * 开始轮询这一把的结果。
     * @param silent `true` = **进页面补问**（用户没在等它）⇒ 出分时**不**自动弹面板。
     *   ⚠️ 只有"用户刚点确认提交"那一次才允许自动弹 —— 否则每次进页面都会弹一遍。
     */
    startPoll(silent = false) {
      this.data.scratch.silent = silent
      this.stopPoll()
      this.data.scratch.pollCount = 0
      this.data.scratch.pollTimer = setInterval(() => {
        void this.pollOnce()
      }, POLL_MS)
    },
    stopPoll() {
      if (this.data.scratch.pollTimer !== null) {
        clearInterval(this.data.scratch.pollTimer)
        this.data.scratch.pollTimer = null
      }
    },

    async pollOnce() {
      const cache = this.data.scratch.cache
      if (!cache || !cache.submissionId) return this.stopPoll()
      this.data.scratch.pollCount += 1
      if (this.data.scratch.pollCount > POLL_MAX) return this.stopPoll()
      try {
        const r = await fetchSubmissionStatus(cache.submissionId)
        if (r.status === 'scoring') return
        this.stopPoll()
        if (r.status === 'failed') {
          /** ⚠️ 失败不占状态：清掉 submissionId 之后回到 recoded（录音还在，可以再试） */
          const next: ParticipateCache = { ...cache, submissionId: '' }
          saveParticipate(this.data.articleId, next)
          this.data.scratch.cache = next
          this.restore()
          this.showNotice(r.error || '检测失败，可以再试一次')
          return
        }
        this.data.scratch.resultOf = r.submissionId
        if (r.result) this.applyResult(r, !this.data.scratch.silent)
        this.restore()
      } catch {
        /** ⚠️ 一次问不到不算失败（网络抖一下很正常）—— 下一次接着问 */
      }
    },

    /**
     * ⭐ 出分：入口**立刻**变 `scored`（`restore()` 拼出来的），
     *    而面板**只有当这条流程还在这一页上时才弹**（prd：面板弹出与按钮状态**不耦合**）。
     */
    applyResult(r: { result?: unknown; submissionId: string }, pop = true) {
      const result = r.result as {
        score: number
        parts?: unknown
        text?: string
        words?: unknown[]
        cookies?: { earned?: number }
        previousBest?: number | null
        /** 这段录音多长（毫秒）—— 参与区那颗试听显示成 00:33 */
        durationMs?: number
      }
      const prevRaw = result.previousBest
      const hasPrev = typeof prevRaw === 'number' && prevRaw >= 0
      const prev = hasPrev ? (prevRaw as number) : -1
      const state: 'update' | 'keep' = !hasPrev || result.score > prev ? 'update' : 'keep'

      this.data.scratch.pendingScore = result.score
      /** ⭐ 服务端记的时长比本地那段准（它可能被转码过），有就用它 */
      if (typeof result.durationMs === 'number' && result.durationMs > 0) {
        this.data.scratch.pendingDurationMs = result.durationMs
      }
      /**
       * ⚠️ **面板弹不弹，与"入口变 scored"是两件事**（prd §7.2：这两者不耦合）。
       *    `pop` 为 false 的情形只有一种：**进页面补问**（用户没在等它，弹出来会莫名其妙）。
       *    ⚠️ 同一把**只自动弹一次**（`popped`）—— 否则每次轮询/每次进页面都弹一遍。
       *    用户想再看：点卡片上的分数/›（`onOpenPanel`）。
       */
      const shouldPop = pop && this.data.scratch.popped !== r.submissionId
      if (shouldPop) this.data.scratch.popped = r.submissionId
      this.setData({
        panelVisible: shouldPop,
        panelState: state,
        panelScore: result.score,
        panelPrev: prev,
        panelParts: result.parts ?? null,
        panelText: result.text ?? '',
        panelWords: result.words ?? [],
        /** ⚠️ 没有 cookies 字段就传 -1（= 不给这个字段，整块不渲染），绝不补 0 */
        panelCookies: result.cookies ? result.cookies.earned : -1,
      })
    },

    /** 关掉面板（忽略）⇒ 状态**仍是 scored**，点分数/› 可以再开（见 onOpenPanel） */
    onPanelClose() {
      this.setData({ panelVisible: false })
    },
    onOpenPanel() {
      this.setData({ panelVisible: true })
    },

    // ── ⑥ 确认（唯一真正的结算）──────────────────────────────
    /**
     * ⭐⭐ **只有这一下才算数**：服务端写 `confirmed_at` ⇒ 参与记录更新 + 清语音。
     * ⚠️ 顺序：先确认、**再清本地缓存** —— 反过来万一确认失败，那一把就从端侧消失了
     *    （而服务端那边它还在，用户再也看不到它）。
     */
    async onPanelConfirm() {
      const cache = this.data.scratch.cache
      if (!cache || !cache.submissionId) {
        this.setData({ panelVisible: false })
        return
      }
      try {
        await claimCookies(cache.submissionId)
      } catch {
        /** ⚠️ 确认失败**不清缓存**：那一把仍然是 scored，用户可以再点一次 */
        this.showNotice('确认没成功，再点一次')
        return
      }
      clearParticipate(this.data.articleId)
      this.data.scratch.cache = null
      this.data.scratch.pendingScore = null
      this.data.scratch.resultOf = ''
      this.data.scratch.pendingDurationMs = 0
      this.data.scratch.popped = ''
      this.setData({ panelVisible: false })
      /**
       * ⚠️ 战绩变了 ⇒ 让宿主重拉参与记录（它会回传新的 bestScore，restore 再拼一次状态）。
       *
       * ⭐ 这一条**取代了**旧的 `lib/refresh-previous.ts`（那个"直接拿上一页实例调它的 load()"
       *    的兜底）：那时流程跑在独立的朗读页上，出分后**上一页**（首页/竞技场）得靠人肉通知；
       *    现在流程就在宿主页面里 ⇒ **一个显式事件**比"反查上一页是谁"干净得多
       *    （旧办法还得按 route 分派，因为不同页的 load 参数不一样）。
       */
      this.triggerEvent('settled', { articleId: this.data.articleId })
      this.restore()
    },

    /** 去结果页看完整明细（分项 / 逐词 / 榜单） */
    onPanelDetail() {
      const cache = this.data.scratch.cache
      if (!cache || !cache.submissionId) return
      wx.navigateTo({ url: '/pages/challenge/challenge?id=' + cache.submissionId })
    },

    // ── 内部状态 ──────────────────────────────────────────────
    noop() {},
  },
})
