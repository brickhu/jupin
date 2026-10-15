import { plainWordsOf } from '@jushuo/shared'

import { confirmSubmission, fetchEnergy, fetchSubmissionAudio, fetchSubmissionStatus, submitReading } from '../../lib/api/client'
import { newAttemptId, uploadAudio } from '../../lib/api/upload'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
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
  /**
   * ⭐ 战绩**刚被刷新**、正等着新的 bestScore 回来做数字滚动（见 rollScore）。
   * ⚠️ 它只由 `onPanelConfirm` 置上 —— 别的路径（换页、普通广播）不该触发滚动。
   */
  awaitRoll: boolean
  /** 上一次看到的战绩分（用来判断"这次真的刷新了吗"） */
  prevBest: number | null
  /** 滚动动画的会话令牌 —— 换句子/重录时把在跑的那一段打断（见 rollScore） */
  rollToken: number
}

/**
 * ⚠️ 分数一律 **1 位小数**（与 `shared` 的 `formatScore` 同一口径）——
 *    动画中间帧也一样：那个值会被直接画到卡片上。
 */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/**
 * ⭐⭐ **数字滚动的时长与帧间隔** —— 照搬朗读页那份**已经调过**的实现
 * （`pages/reading` 的 `ROLL_MS` / `ROLL_FRAME_MS`，那一页整体废弃时把它留在这里了）。
 *
 * ⚠️ 600ms：短了看不清"在涨"，长了就变成拖时间（**产品给的区间是 500–700ms**）。
 * ⚠️ 16ms ≈ 60fps：用 `setTimeout` 逐帧推进、**不引任何动画库** ——
 *    小程序端没有可靠的 `requestAnimationFrame` 等价物，而这点计算量足够小。
 */
const ROLL_MS = 600
const ROLL_FRAME_MS = 16

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
    /** 这一把录音的时长（面板头部显示成 00:23） */
    panelDurationMs: 0,
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
      awaitRoll: false,
      prevBest: null,
      rollToken: 0,
    } as Scratch,
  },

  observers: {
    /** 换句子 ⇒ 重新拼一次状态（首页会在多张卡之间切换） */
    'articleId, bestScore'() {
      this.setData({ wordCount: plainWordsOf(this.data.text ?? '').length })
      /**
       * ⭐⭐ **战绩刷新 ⇒ 数字滚上去**（用户 2026-10-15 定：点更新、弹窗关掉之后，
       *    卡片上那个战绩数字要有数字动画）。
       *
       * ⚠️⚠️ 触发的**唯一条件**是「上一次确认之后，战绩真的变了」：
       *    · `awaitRoll` 只由 `onPanelConfirm` 置上（别的路径不滚 —— 换页/普通广播都不该动）；
       *    · 且新的 bestScore **必须高于**上次那个（记录只增不减；没超越时值不变 ⇒ 不滚）。
       *    ⚠️ 少了任一条，就会出现"我没破纪录，数字却在我眼前涨了一截"这种假喜报。
       */
      const next = Number(this.data.bestScore)
      const prev = this.data.scratch.prevBest
      /** ⚠️ 用直接 `if` 收窄 `prev`（写成 `const roll = … && prev !== null` 再传进
       *  `rollScore(from: number)` 是不行的 —— TS 不会跨那个布尔变量收窄，
       *  而那一处类型错会让**整个** `this` 的推断崩掉，满屏 "possibly undefined"） */
      if (this.data.scratch.awaitRoll && prev !== null && next > prev) {
        this.data.scratch.awaitRoll = false
        /**
         * ⚠️⚠️ **观察者里不许 `return` 一个值**（写成 `return this.rollScore(...)` 就中招）：
         *    微信把 `observers` 的类型定成 `=> void`，返回非空表达式会**让整个
         *    Component 字面量的 `this` 类型推断崩掉** —— 症状是**满屏 37 条
         *    「Cannot invoke an object which is possibly 'undefined'」**（`this.restore` /
         *    `this.stopPoll` / `this.precheck` 全都报），**指不到真正的那一行**。
         *    ⇒ 一律"先调用、再空 `return`"。
         */
        this.rollScore(next)
        return
      }
      this.data.scratch.awaitRoll = false
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
      this.noteBest(bestScore)
      this.emitState(state, score)

      /** 有在路上的提交 ⇒ 接着问（可能上次离开时还没出分） */
      /**
       * ⚠️ 这一次是「**进来补问**」（不是用户刚提交）⇒ `silent`：
       *    把状态补对就够了，**不要**自动弹面板 —— 用户没在等它。
       */
      if (pending && !cache?.confirmed && this.data.state === 'checking') this.startPoll(true)
    },

    /**
     * ⭐ 把状态报给宿主（卡片不自己算状态）。
     * ⚠️ 一起给**我那段录音的时长** —— 参与区那颗试听要显示成 00:33（设计稿 539:871）。
     *    优先用"这把结果里的时长"（服务端记录的），否则用本地缓存里那段录音的。
     */
    emitState(state: RecordState, score: number | null) {
      const durationMs = this.data.scratch.pendingDurationMs || this.data.scratch.cache?.durationMs || 0
      this.triggerEvent('state', {
        articleId: this.data.articleId,
        state,
        score: score === null ? -1 : score,
        durationMs,
      })
    },

    /**
     * 记下"上一次看到的战绩分" —— **只有这里写**（滚动判据读它，见观察者）。
     * ⚠️ `-1` 是宿主的哨兵值（= 没有战绩）⇒ 落成 null。
     */
    noteBest(best: number | null) {
      this.data.scratch.prevBest = best === null || best < 0 ? null : best
    },

    /**
     * ⭐⭐ **战绩数字滚动**（用户 2026-10-15 定：点更新、弹窗关掉之后，卡片上那个战绩数字
     *     要有数字动画）。
     *
     * ⚠️⚠️ 形态**照搬朗读页那份已经调过的实现**（`ROLL_MS = 600` / 16ms 帧 / ease-out cubic /
     *    **从 0 滚到最终值** / 末帧无条件写精确值）—— 那一页整体废弃时我把它一起删了、
     *    然后自己编了个"从旧值补间"的版本，被用户当场否掉。**别再自己编时长和曲线**。
     *
     * ⚠️ 为什么在流程里做，而不是给卡片写一套动画：卡片显示的那个分数
     *    **本来就是流程 emit 的** —— 连续 emit 中间值，卡片自然就动起来了。
     *    在组件里再写一遍，等于同一件事做两遍（还会跟状态机抢这个数）。
     *
     * ⚠️⚠️ **必须能被打断**：换句子、用户又录了一把、或又确认了一次 ⇒ `rollToken` 一变就停。
     *    不停的话，旧动画会把一个**过期的分数**写回卡片（"数字自己跳回去"）。
     * ⚠️ 最后一帧**精确落在目标值**上（别停在 84.7 —— 那比不动还糟）。
     */
    rollScore(to: number) {
      const token = ++this.data.scratch.rollToken
      const startedAt = Date.now()
      const flow = this
      /**
       * ⚠️⚠️ **必须是函数声明**（不能写成 `const tick = () => {… setTimeout(tick) }`）——
       *    自引用箭头函数推不出自己的类型，那一处推断失败会让**整个 Component
       *    字面量的 `this` 类型崩掉**（满屏 "possibly undefined"，指不到真凶）。
       */
      function tick(): void {
        /**
         * ⚠️ 判活：销毁 / 换句子 / 又确认了一次 ⇒ 立刻停。
         *    不停的话它会往**已经换掉的界面**上继续写分数（"数字自己跳回去"）。
         */
        if (flow.data.scratch.rollToken !== token) return
        /**
         * ⚠️ 用**墙上时钟**算进度（不是"第几帧"）：定时器抖动不会让动画变慢或变快。
         */
        const t = Math.min(1, (Date.now() - startedAt) / ROLL_MS)
        const done = t >= 1
        /** ⭐ ease-out cubic：开头快、结尾慢 —— 用户对"最后停在哪个数"最敏感 */
        const k = 1 - Math.pow(1 - t, 3)
        /**
         * ⚠️⚠️ **从 0 滚到最终值**，不是"从旧战绩过渡到新战绩"（用户 2026-10-15 明确否掉了后者）。
         * ⚠️⚠️ **末帧无条件写精确值** —— 不能用缓动算出来的近似值：
         *    四舍五入会让 89.46 停在 89.4，而服务端给的是 89.5，
         *    "动画结束时差 0.1"是最不该有的错（朗读页那份实现里就写着这条）。
         * ⚠️ 每一帧都 `round1`：这个值会被直接画到卡片上，浮点就是 `79.43333333`。
         */
        const shown = done ? to : round1(to * k)
        flow.setData({ state: 'retry', score: shown })
        flow.emitState('retry', shown)
        if (done) flow.noteBest(to)
        else setTimeout(tick, ROLL_FRAME_MS)
      }
      tick()
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
      /**
       * ⚠️ `↺` 只在 `recoded` 出现（见 btn-record），但这里是**流程自己的不变量**：
       *    `checking` 那一段已经交上去在云里算了，丢弃它没有意义 —— 谁调都不许。
       */
      if (this.data.state !== 'recoded') return

      wx.showModal({
        title: '抹除录音',
        content: '你确认抹除掉刚才录制的这一段语音吗？',
        confirmText: '确认',
        cancelText: '取消',
        success: (r) => {
          if (r.confirm) this.discardRecording()
        },
      })
    },

    /**
     * ⭐⭐ **`↺` = 放弃这一把，回到大 `try` / `retry` 态**。
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

    /**
     * ⭐ **试听我自己的录音**（参与区中间那格 `▶ 00:33`）。
     *
     * ⚠️ 两段音频**取哪一份，看这一把走到哪一步了**：
     *    · 还没提交（`recoded`）⇒ 播**本机**那一段（就是这份文件本身，不必去服务端转一圈）；
     *    · 已提交（`checking` / `scored`）⇒ 播**服务端存档**的那一份
     *      （本机那份可能已经被清掉/换掉，而服务端那行是这一把的权威）。
     *
     * ⚠️ 播之前先 `stopAudio()`：它和**标准音**是两路声音，同时响不只吵 ——
     *    用户根本分不清现在放的是"标准音"还是"我刚才读的"。
     */
    async playRecording() {
      const cache = this.data.scratch.cache
      if (!cache) return
      stopAudio()
      try {
        if (cache.audioPath && !cache.submissionId) {
          await playAudioUrl(cache.audioPath, '我的录音')
          return
        }
        if (cache.submissionId) {
          const r = await fetchSubmissionAudio(cache.submissionId)
          const src = r.audio?.src
          if (!src) {
            this.showNotice('这一段的录音已经不在了')
            return
          }
          await playAudioUrl(src, '我的录音')
        }
      } catch (err) {
        /** ⚠️ 播不出来就说一句（本地文件可能已被系统清掉）—— 不要静默 */
        this.showNotice((err as Error).message || '这段录音播不出来')
      }
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

    /**
     * ⭐⭐ **能量面板点「确认」** —— 先切 `checking`，再做上传。
     *
     * ⚠️⚠️ 上传是**几秒级**的动作（音频要进对象存储），而 `checking` 才是"这一把已经在路上"
     *    该有的样子。原来是在 `submit()` 里等"上传 + 受理"都回来了才 `restore()`
     *    ⇒ 那几秒卡片**还停在 `recoded`**：界面上什么都不像在处理，
     *    而 **✓ 还在**（用户可以再点一次 ⇒ 重复提交同一段音频）。
     *    ⚠️ 切成 `checking` 之后那颗 ✓ 就不再渲染（设计稿里 `checking` 是「试听 + 转圈」）
     *      ⇒ **重复提交在结构上就不可能发生**，不用再加一把锁。
     */
    async onEnergyConfirm() {
      this.setData({ energyVisible: false })
      /** ⚠️ 没有可提交的东西就什么都别切（否则会永远停在转圈上） */
      const cache = this.data.scratch.cache
      if (this.data.articleId && cache && cache.audioPath) {
        this.setData({ state: 'checking' })
        this.emitState('checking', null)
      }
      await this.submit()
    },

    // ── ⑤ 上传 + 提交 + 轮询 ──────────────────────────────────
    async submit() {
      const { articleId } = this.data
      const cache = this.data.scratch.cache
      if (!articleId || !cache || !cache.audioPath) return

      try {
        const up = await uploadAudio(cache.audioPath, { articleId, attemptId: cache.attemptId })
        const res = await submitReading(articleId, up.audioKey, up.audioUrl, cache.attemptId)

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
        /**
         * ⚠️⚠️ **失败要退回 `recoded`** —— 进来时已经把状态切到 `checking` 了（见 onEnergyConfirm），
         *    不退回就会**永远停在转圈上**，而那段录音明明还在本地。
         *    `restore()` 按缓存重拼：有 `audioPath`、没有 `submissionId` ⇒ `recoded` ✅
         *    （用户可以再点一次 ✓ 重试，不必重录）。
         */
        this.restore()
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
        panelDurationMs: this.data.scratch.pendingDurationMs || this.data.scratch.cache?.durationMs || 0,
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
        await confirmSubmission(cache.submissionId)
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
      /**
       * ⚠️ 先置上「等战绩回来」—— 宿主那次重拉落地后会触发观察者，
       *    它据此决定要不要滚数字（见 observers 里的判据）。
       *    ⚠️ 必须在 `settled` **之前**：事件是同步派发的，置晚了就错过那一次。
       */
      this.data.scratch.awaitRoll = true
      this.triggerEvent('settled', { articleId: this.data.articleId })
      this.restore()
    },

    /** 去结果页看完整明细（分项 / 逐词 / 榜单） */
    onPanelDetail() {
      const cache = this.data.scratch.cache
      if (!cache || !cache.submissionId) return
      /** ⚠️ 成绩单**没有**自己的展示页（用户 2026-10-15 定）⇒ 去看这句的竞技档案 */
      wx.navigateTo({ url: '/pages/arena/arena?articleId=' + this.data.articleId })
    },

    // ── 内部状态 ──────────────────────────────────────────────
    noop() {},
  },
})
