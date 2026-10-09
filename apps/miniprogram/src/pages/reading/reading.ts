import {
  ENERGY_PER_CHALLENGE,
  PREFLIGHT,
  formatScore,
  resultFormOf,
} from '@jushuo/shared'
import { alignmentDetailOf, missingWordsOf, plainWordsOf, wordProgressOf } from '@jushuo/shared'
import { pointsToConquer, type CookieAwardView, type SubmitResponse } from '@jushuo/shared'

import { PLATFORM } from '../../config'
import {
  ApiError,
  claimCookies,
  fetchParticipationSubmissions,
  fetchSubmissionStatus,
  getUserId,
  submitReading,
} from '../../lib/api/client'
import { historyRowsOf, historySummaryOf, type HistoryRow } from '../../lib/article-history'
import { newAttemptId, uploadAudio } from '../../lib/api/upload'
import { playAudioUrl, playBeep, playDing, playWhoosh, stopAudio } from '../../lib/audio/play'
import { speak } from '../../lib/audio/tts'
import { createSpeechSession, type SpeechResult, type SpeechSession } from '../../lib/audio/speech-session'
import { isSlowReading, submitHintOf, type SubmitHintLevel } from '../../lib/submit-hint'
import { fetchArticleContent } from '../../lib/content'
import { CHALLENGE_PAGE, openChallengePage } from '../../lib/challenges'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'
import { refreshPreviousPage } from '../../lib/refresh-previous'
import {
  clearLastRecording,
  loadLastRecording,
  recordingKeyOf,
  saveLastRecording,
} from '../../lib/audio/last-recording'
import { AUTH_RETRY_HINT, ensureAuthed, isAuthed, isUnregistered } from '../../lib/auth'
import { ensureParticipation } from '../../lib/participation'
import { openEnergyPage } from '../../lib/challenges'
import { clearLastResult, loadLastResult, saveLastResult } from '../../lib/audio/last-result'
import { renderWordColors } from '../../lib/word-colors'
import { decodeFrameToSamples } from '../../lib/audio/frame-decode'
import { WAVE_GAIN_ZERO, advanceWaveGain, applyWaveGain, peakBars } from '../../lib/audio/wave'
import { AUTO_STOP_SILENCE_MS, VAD_STATE_ZERO, advanceVad, autoStopAfter, classifyChunk } from '../../lib/audio/vad'
import type { VadState } from '../../lib/audio/vad'
import type { ColoredWord } from '../../lib/word-colors'
import { ensureLocalAudio, prefetchAudio } from '../../lib/audio/standard'

/**
 * ⭐⭐ 朗读页 —— 状态机（规格：docs/design/reading/SPEC.md）。
 *
 *   s1 未录音 ──点麦克风──▶ s2 录音中 ──停止──▶ s3 录音预览
 *    ▲                                             │ ✓（确认 = 提交评测）
 *    │                                             ▼
 *    │                                  ╔═══ 评测弹窗（components/eval-dialog）═══╗
 *    │                                  ║ uploading 上传中 ──▶ scoring 评测中      ║
 *    │                                  ║        │                    │          ║
 *    │                                  ║  评分成功│                    │失败/超时  ║
 *    │                                  ║        ▼                    ▼          ║
 *    │                                  ║   s5 成功（出分）        s6 失败         ║
 *    │                                  ╚═══════════「确认」═══════════════════════╝
 *    └────────「确认」= 关窗 + 清缓存回 s1（s3 的 ↺ 重录走同一段代码）
 *
 * ⚠️⚠️ **s4 这个名字已经没有了**（用户 2026-09 把提交之后那一段搬进弹窗）：
 *    原来的 s4 = 现在的 'uploading' + 'scoring' 两态；s5 / s6 仍在，但画在弹窗里。
 *    弹窗的四种 phase 与页面的 Phase 是**同一份枚举** —— 不再有第二套命名。
 *
 * ⚠️ 另有两个**不属于状态机**的东西，别混进来：
 *    · loading —— 句子还没拉到（拉失败也停在这里，给「重试」）；
 *    · error   —— 一句人话，横跨所有状态（麦克风没授权 / 能量不够 / 上传失败…），
 *                它**不改变状态**，只是多一条红条（见 WXML 末尾）。
 *
 * ⚠️⚠️ 提交被拒**不都是错误**：能量不够是业务规则、不是故障，必须和真错误分开说，
 *    否则用户以为小程序坏了，然后反复重试（而那正是要拦的行为）。
 *
 * ⚠️ 为什么弹窗里的两个等待态要拆开：合成一个的时候，"卡在 0%（网络慢）"和
 *    "卡在 99%（引擎慢）"在屏幕上长得一模一样（见 Phase 的说明）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **这里曾经有一整套「实时逐词跟随」，已经作为产品决策整体摘掉。**
 *
 *    摘掉的原因不是它坏了，是**这条路本身有天花板**：
 *    用 DTW 把用户音频对齐到参考音，本质是**间接代理** ——
 *    它只会回答「你的音频最像参考音的哪一段」，
 *    而**说不出「你读的是另一个词」**。你读成 an，它也必须给你找个对应的参考片段，
 *    于是"经过就算匹配"、读得越多绿得越多、最后全绿。
 *
 *    业界做实时逐词标注的（Google Read Along 等）用的都是 **ASR**；
 *    而多邻国**刻意不做**实时跟随 —— 说完给判定。
 *    小程序主包 2MB 装不下端侧 ASR 模型，云端流式 ASR 每用户每次都在烧钱。
 *
 *    ⇒ 实时跟随不做。力气花在「说完之后的权威反馈」（讯飞 ISE）上，
 *      也就是 s5/s6 与 pages/challenge 那一段。
 * ══════════════════════════════════════════════════════════════════
 */

/**
 * ⭐ 页面状态。
 *
 * ⚠️⚠️ 'uploading' / 'scoring' 就是**原来的 s4**（提交评测那一段等待），用户 2026-09
 *    把它拆成了两个、并搬进弹窗（见 components/eval-dialog）：
 *      · 'uploading' —— 录音正在传，有真实百分比；
 *      · 'scoring'   —— 已经受理，正在等云端打分（只能转圈）。
 *    拆开的理由：合成一个态时，"卡在 0%（网络慢）"和"卡在 99%（引擎慢）"
 *    在屏幕上长得一模一样，而它们该说的话完全不同。
 *    ⚠️ 页面上真正"盖住一切"的那一层由组件按这两个值 + s5/s6 决定画不画。
 */
/**
 * ⭐⭐ **卡片形态**（用户 2026-10 定的新流程）—— 只有这四种，`reading.wxml` 只认它。
 *
 * ## 为什么要把「卡片」和「弹窗」拆成两个值
 *
 * 原来只有一个 `phase`，九种值里前四种是卡片、后五种是弹窗 —— 两者**共用一个变量**。
 * 后果：点下确认之后 `phase` 变成 'uploading'，卡片于是**离开了 s3** ⇒
 * 那颗 ✓（检测）、↺（重录）、试听**整排消失**，页面被弹窗接管。
 *
 * ⭐ 用户 2026-10 定的新流程要求：**确认之后弹窗关掉、卡片留在 s3**，
 *    靠卡片上的按钮表达"正在检测"（✓ 转圈、↺ 变灰）。
 *    ⇒ 于是"这一把在检测中"必须与"卡片长什么样"**解耦**。
 *
 * ⚠️ 做法是**保留 `phase` 的九种值不变**（弹窗那边一行都不用改），
 *    另加一个**派生**的 `cardPhase`：检测中的三个值（precheck / uploading / scoring）
 *    以及结果态（s5 / s6）一律映射成 `'s3'`。
 *    ⚠️ 结果态也映射成 s3 是**故意**的：那时弹窗盖着，卡片本来就看不见；
 *       万一弹窗被关掉，露出来的是"这一把还能重录"的 s3，而不是一张空的句子卡。
 */
type CardPhase = 'loading' | 's1' | 's2' | 's3'

/** ⭐ `phase` → `cardPhase` 的映射（唯一一处；别在别处再算一遍） */
const CARD_OF: Record<Phase, CardPhase> = {
  loading: 'loading',
  s1: 's1',
  s2: 's2',
  s3: 's3',
  // ⚠️ 下面这些都不是"卡片的形态"，卡片停在 s3 不动
  precheck: 's3',
  uploading: 's3',
  scoring: 's3',
  s5: 's3',
  s6: 's3',
}

/**
 * ⭐ 改 `phase` 时**必须**走这里 —— 它顺手把派生的 `cardPhase` 一起写进去。
 *
 * ⚠️⚠️ 不要手写 `{ ...phasePatch('s3') }`：那样 `cardPhase` 会**停在旧值**，
 *    而 TypeScript 抓不到（两个字段都是合法的）—— 症状是"卡片忽然变了个样子"，
 *    而且只在某几条路径上出现（比如"检测失败 → 重录"之后卡片停在检测中的样子）。
 *    ⇒ 全文件只有这一处把两者绑在一起，改的时候 `grep "phase: '"` 应该**只在 CARD_OF 里**命中。
 */
function phasePatch(p: Phase): { phase: Phase; cardPhase: CardPhase; detecting: boolean } {
  return {
    phase: p,
    cardPhase: CARD_OF[p],
    /**
     * ⭐ **这一把正在检测中**（上传或等打分）—— 卡片上那三颗钮靠它决定样子：
     *   · ✓  → 转圈 + 禁用（"正在检测"）
     *   · ↺  → 禁用（⚠️ 检测中绝不能重录，见 clearAttempt 的守卫）
     *   · 试听 → 照常（听自己刚录的那一遍，正是这时候想听的）
     * ⚠️ 由这里派生而不是各写一处：它与 `phase` 必须**永远一致**，
     *    而"某个 setData 忘了带上它"正是这类派生字段最典型的错法（卡片会停在转圈上）。
     */
    detecting: p === 'uploading' || p === 'scoring',
  }
}

type Phase =
  | 'loading'
  | 's1'
  | 's2'
  | 's3'
  /**
   * ⭐ 提交前的**身份 / 能量确认**（用户 2026-09 定的三份检查里的第 1、3 份）。
   * ⚠️ 'precheck' 是"正在问服务端权威余额"那一下（几百毫秒）——
   *    它**不是**可以随便关掉的中间态：关掉的话用户会以为点了没反应。
   */
  | 'precheck'
  | 'uploading'
  | 'scoring'
  | 's5'
  | 's6'

/**
 * ⭐ 等待态的**超时** —— 到点即进 s6（用户 2026-09 定：等待期不做手工取消，只做超时兜底）。
 *
 * ⚠️⚠️ 这个数**不是**「打分最多能跑多久」的估计，而是「人盯着转圈能忍多久」。
 *    服务端那条链路**刻意没有时长上限**（靠心跳判活，见 apps/server 的 services/scoring.ts：
 *    心跳 5 秒一次、30 秒没动静才算进程死了）——
 *    所以客户端在这里掐时间，**一定**存在「分其实马上就要算出来了，只是我们不等了」的可能。
 *    ⇒ 取值必须**宽**：正常一次 10–20 秒、长句更久，冷启动还要再加十几秒。2 分钟足够。
 *    ⚠️ 真撞上它时，s6 的副标题会明说「分数可能还在云端算」，
 *       而不是把锅扣在「录音不符合规范」上（那句是引擎判失败的文案）。
 */
const SCORING_TIMEOUT_MS = 120_000

/**
 * ⭐ 波形画布**准备失败时重试几次**。
 * ⚠️ 实测过：`fields({size:true})` 偶尔量到 0（尤其是卡片刚切到 s2、还没布局完）——
 *    不重试的话波形永远是空白，而看不出是"没准备好"还是"没声音" ✗
 */
/**
 * ⭐⭐ **录音的硬上限（超时兜底）** —— 到点自动结束，进 s3。
 *
 * ⚠️ 为什么必须有：静音自停里有一条"**解不出来就当成他在说话**"（见 vad.ts）——
 *    那在环境噪音大、或解码不工作时意味着**永远不会自动结束** ✗
 *    没有硬上限的话用户会一直录下去，直到自己想起来要点结束 ✓
 *
 * ⭐ 取 30 秒：沿用原来插件那条路的 `ASR_MAX_RECORD_MS`（那个数当初的理由是
 *    "纯粹为了不让界面挂住" ✓ 这里同样成立）。句子本身 5~10 秒，
 *    30 秒足够慢的人读完再想一会儿 ✓
 */
const MAX_RECORD_MS = 30_000

const WAVE_PREPARE_TRIES = 3
/** 波形柱子最多几根（太多会糊成一块，太少看不出起伏） */
const WAVE_MAX_BARS = 64
/** 波形颜色 = 品牌色（与按钮、进度条同一套） */
const WAVE_COLOR = '#4f46e5'
/**
 * ⚠️ 帧间隔的**兜底值**：mp3 下 1KB ≈ 170ms（见 RECORD_SPEC 的说明）。
 *    正常情况下用手表量出来的真实间隔（见 onRecordFrame），这个只在第一次用得上。
 */
const FRAME_MS_FALLBACK = 170

/**
 * ⭐ 波形用到的 2d 画布接口 —— **只列我们真的调的那几个**。
 *
 * ⚠️ 不用 `CanvasRenderingContext2D`：小程序的类型里没有这个全局名 ✗
 *    （那是 DOM 的；小程序的 2d canvas 在 `WechatMiniprogram` 里另有类型，
 *      而它把 `getContext('2d')` 标成 any —— 用一个结构类型反而更清楚：
 *      **这里到底依赖了画布的哪几个能力**，加一个方法就要在这里加一行 ✓）
 */
interface WaveCtx {
  scale(x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: string
}

/**
 * ⚠️ 超时进 s6 时**要换一句副标题**（见 SCORING_TIMEOUT_MS 的说明）。
 */
const TIMEOUT_HINT = '评测等太久了，这次先按失败处理 —— 分数可能还在云端计算，回首页就能看到'

/**
 * ⭐ 秒表 / 时长 → `00:23` —— **恒有值**。
 *
 * ⚠️⚠️ 不能直接用 shared 的 formatDuration：它对 0 与不足半秒返回**空串**
 *    （那是给「算不出来的音频时长」用的，界面上宁可空着也不显示 00:00）。
 *    而 s2 的计时器必须**一进来就有值** —— 否则录音的头半秒里那一格是空的，
 *    看起来像计时器坏了。
 */
function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}


/**
 * ⭐ 结果页那**一行**饼干（规格：prd §7.6）。
 *
 * ⚠️ 只有两种形态：拿到了就是 `+20 🍪`（大号墨色），
 *    没拿到就是「再高 3 分就能攻克」（灰色小字）。
 *    **没有第三种** —— 屏幕上永远不出现「0 🍪」。
 */
interface CookieLine {
  text: string
  cls: string
}

/**
 * ⭐ **结果页那一行饼干** —— 拿到就显示 +N，没拿到显示"还差多少"。
 *
 * ⚠️⚠️ 屏幕上**永远不出现「0 🍪」**（prd §7.6 的硬口径）：
 *    "0 🍪"是把"你什么都没得到"说出来；"还差 3 分"说的是同一件事，
 *    但它是**邀请**（目标梯度），不是判决。
 *
 * ⚠️ 数据来自服务端刚下发的 `SubmitResponse.cookies`（submissions 的快照）。
 *    拿不到时（结算与「status 置为 scored」之间的窗口 / 老数据）返回 **null** ⇒
 *    **整块不渲染** —— 原来这里是三张恒为 +0 的灰卡，那是**三次**"你什么都没得到"的宣告。
 *
 * ⚠️ 不要拿主页那个**累计值**顶上来：这一行回答的是「**这一把**赚了多少」，
 *    累计值放上去会是 +1240 这种数。
 */
function cookieLineOf(
  award: CookieAwardView | null | undefined,
  score: number | null | undefined,
): CookieLine | null {
  if (!award) return null

  if (award.earned > 0) return { text: '+' + award.earned + ' 🍪', cls: 'text-40rpx font-bold text-ink' }

  // ⚠️ 没攻克：不显示 0，改说"还差多少"。分数拿不到就整块不渲染（宁可不显示，也不显示错的）
  if (score === null || score === undefined) return null
  const gap = pointsToConquer(score, award.passLine)
  if (gap <= 0) return null
  return { text: '再高 ' + gap + ' 分就能攻克', cls: 'text-26rpx text-muted' }
}

/**
 * ⭐ s5 数字滚动（大分数 + 三张卡的 +N）的时长与帧间隔。
 *
 * ⚠️ 600ms：短了看不清"在涨"，长了就变成拖时间（产品给的是 500–700ms）。
 * ⚠️ 16ms ≈ 60fps。用 setData + 定时器逐帧推进、**不引任何动画库** ——
 *    小程序端没有可靠的 requestAnimationFrame 等价物，而这点计算量足够小。
 */
const ROLL_MS = 600
const ROLL_FRAME_MS = 16

/** 只在开发者工具里为真 */
const IS_DEVTOOLS = PLATFORM === 'devtools'

/** 逐词视图 —— 词 + 它自己的音标（音标开关打开时挂在词下面） */
interface WordView {
  /** 稳定的 key（同一个词可能出现多次，不能用 text 当 key） */
  i: number
  text: string
  /**
   * ⭐ 这个词的国际音标（来自正文 JSON 的 words[i].ipa，形如 /ˈɛvriˌθɪŋ/）。
   * ⚠️ 查不到时是空串（老正文 / 生僻词）—— 那时**不渲染**这一行，不占位。
   */
  ipa: string
  /**
   * ⭐ **定稿后的预检结果**（与提交后那套评分色**完全无关**，见 prd 7.2）。
   * 两态**互斥**（一个词要么完全没对上、要么对上了但词不一样），视觉也分开：
   *
   * | | 含义 | 长什么样 |
   * |---|---|---|
   * | `missed` | **没读到** —— 那一位上什么都没有 | **灰色 + 灰色点线**（虚＝"这儿空着"） |
   * | `misread` | **没读准** —— 读到了，但机器听到的是别的词 | **黄色 + 黄色实线**（实＝"有东西，但存疑"） |
   *
   * ⚠️ 只在**定稿那一刻**算一次 —— **录音过程中不逐词变色**
   *    （用户 2026-10 定：实时标色的延迟体验不理想，整套去掉）。
   */
  missed: boolean
  misread: boolean
}

Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    articleId: '',
    /** 六态 + 一个「句子还没拉到」的前置态，见文件头的状态机说明 */
    /**
     * ⚠️ **卡片的形态**（reading.wxml 只认它）—— 由 `phasePatch()` 与 `phase` 一起写。
     *    检测中它**停在 's3'**：用户要求确认之后弹窗关掉、卡片留在 s3，
     *    靠 ✓ 转圈 / ↺ 变灰来表达"正在检测"（见 CardPhase 的说明）。
     */
    cardPhase: 'loading' as CardPhase,
    /** ⭐ 正在检测（上传 / 等打分）—— 与 phase 一起由 phasePatch() 写 */
    detecting: false,
    phase: 'loading' as Phase,
    /** 横跨所有状态的一句人话（不改变状态） */
    error: '',

    translation: '',

    /** 逐词渲染（点词听发音 + 音标挂载都靠它） */
    words: [] as WordView[],
    /**
     * ⭐ IPA 胶囊 = 在**单词下方显示音标**（用户 2026-09 确认的语义）。
     * ⚠️ 数据本来就有（正文 JSON 的 words[] 每项带 ipa），不需要新接口。
     * ⚠️ s2 录音中即使开着也不显示（设计稿口径：录音时少一层干扰，见 WXML）。
     */
    ipaOn: false,

    /**
     * ⚡ 能量点数 —— s3 / s5 / s6 与弹窗底部那行小字要用它。
     * ⚠️ 只从服务端给的 profile 里读（每次 /me 顺手补足到 3 点），端侧不自己算余额。
     */
    energy: 0,
    /**
     * ⭐ 底部那行小字的**成品文本**（在 TS 里拼，不在 WXML 里拼）。
     * ⚠️ 为什么不给 WXML 拼：它要判断「这一态算不算已消耗」，
     *    而且那个数字必须来自 ENERGY_PER_CHALLENGE（端侧不写死 2）。
     */
    energyNote: '',

    /**
     * ⭐ 能不能播标准音。
     * ⚠️ 由**内容接口**说了算（它返回云存储 fileID）：没有音频时这里就是 false，
     *    整个播放入口都不渲染 —— 而不是给一个点了没反应的图标。
     */
    canPlayAudio: false,
    /**
     * ⭐ 标准音播放钮的配色 —— **与列表页那颗完全一致**（用户 2026-10 定）。
     *
     * 列表页（`arena-card`）传的是「**卡片的前景色 / 底色**」：
     *   描边／圆底 = 前景色，实心播放时的图标 = 底色。
     *   默认主题下就是 黑描边 + 白图标 —— 用户说的"黑边按钮"。
     *
     * 朗读页的卡片是普通白卡（**没有**主题色）⇒ 取主题的兜底值：
     *   前景 `#111111`（uno.config.mjs 的 theme.colors.ink）、底色 `#ffffff`。
     *
     * ⚠️ 组件属性只收字符串，吃不到 uno 的 token ⇒ 这两个值是把主题色**抄**过来的，
     *    改主题色时这里要一起改（`challenge.ts` 的 cardBg / cardFg 是同一个处境）。
     */
    playFill: '#111111',
    playInk: '#ffffff',

    /** 整句标准音（fileID 或服务端路径，由 audioKind 决定怎么解释） */
    fullAudio: '',
    /** 'cloud' | 'http' —— 见 shared 的 AudioRef */
    audioKind: 'http' as 'cloud' | 'http',
    /**
     * ⭐ 标准音时长（毫秒）—— **直接交给 audio-button 的 durationMs**，由它统一格式化成 `00:23`。
     *
     * ⚠️ 数据来自详情接口的 audio.durationMs（= shared 的 StandardAudio，
     *    服务端用同一个 standardAudioOf 拼，与列表接口同源）。
     *    拿不到（老服务端 / 文件缺失 / 解析失败）就是 0 —— `formatDuration(0)` 返回空串，
     *    于是那几个字**不渲染**（不是显示 00:00：那看着像音频坏了）。
     * ⚠️ 页面里**不再自己拼时长字符串**：格式只由 audio-button 定一次，
     *    各页各拼会出现 `0:03` / `3.0 秒` 并存，看起来像在量不同的东西。
     */
    stdDurationMs: 0,

    /** 正在播的单词下标；-1 表示没在播单词 */
    playingWord: -1,
    /** ⭐ 顶行那颗标准音播放钮的状态（播 / 停 / 取音中都在这一个字段上） */
    sentenceState: 'unplay' as 'unplay' | 'loading' | 'playing',
    /** ⭐ 试听（我自己这段录音）的状态 —— 同一套手感 */
    replayState: 'unplay' as 'unplay' | 'loading' | 'playing',

    /**
     * ⭐ 这段录音是从**上次的缓存**恢复来的（不是刚录的）。
     * ⚠️ 必须让用户看见（s3 里一行小字）：他会以为是自己刚录的，然后直接提交 ——
     *    而他并不记得那段音频里读的是什么。
     */
    restored: false,

    /** 录音落地的原始文件 —— **上传用**（试听也用它） */
    audioPath: '',
    /**
     * ⭐⭐ 这一次提交尝试的**稳定 id**（32 hex）——**重试必须复用**，重录才换新的。
     *
     * ⚠️⚠️ 它是服务端的幂等键（见 db/schema.ts 的 attemptId，也是上传路径的第三段）。
     *    没有它的时候：用户按界面提示"再点一次"重试 → 客户端重新上传（路径含时间戳、变了）
     *    → 服务端按 audioKey 判重落空 → **第二条成绩 + 第二次扣 2 点能量**，
     *    而界面写着"不会重复计费"。
     *    ⇒ 所以它**只在录音落地那一刻生成一次**（onStopRecord），开始重录与整页重来
     *      （onStartRecord / onRestart）以及提交成功后才清空；
     *      **千万别在 startSubmit 里生成** —— 那正好退回到出事的行为。
     */
    attemptId: '',
    /** 老版本留下的「帧拼 WAV」副本 —— **试听兜底用**（新录音恒为空串） */
    playPath: '',
    durationMs: 0,
    /** 我的录音时长 `00:23` —— s3 那颗 outline 胶囊上显示的就是它 */
    recordDurationText: '',
    /** s2 顶行那个红色计时器 `00:23`（在 TS 里按毫秒格式化，见 mmss） */
    elapsedText: '00:00',
    /** 上传进度（0–100）—— 'uploading' 那一态给真实进度（别让「AI评测中」盖住还在传的那几秒） */
    uploadPercent: 0,

    /** ⭐ s5 的成品：大号总分（formatScore，一位小数） */
    scoreText: '',
    /** ⭐ s5 的副标题（三档：首次 / 突破最高分 / 未突破，见 subtitleOf） */
    scoreSubtitle: '',
    /**
     * ⭐ s5 左上角那行标题：**第 N 次朗读**（用户 2026-09 要求，替换原来的「AI口语测评」）。
     *    ⚠️ N 用服务端给的 attempts（这一把是这句的第几次，**服务端现算**，库里没有这一列）——
     *       端侧一个数都不算，与副标题里那个「第 K 次挑战」同一个来源。
     *    ⚠️ 只给 s5 用：s6（失败）仍显示「AI口语测评」（WXML 按态取值，
     *       所以这里**不需要**在失败态重置它，天然不会串）。
     */
    attemptTitle: '',
    /**
     * ⭐ 成长值三卡。
     *   · s5：服务端下发了这一把的增量（SubmitResponse.growth）就是三张 +N；
     *         拿不到（还没结算 / 老数据）时是**空数组** ⇒ 整块不渲染；
     *   · s6：恒为三张 +0（灰）—— 且**不做数字滚动**（没有"涨"这回事，
     *         见 cookieLineOf 与 WXML 里 s6 那一块）。
     */
    cookieLine: null as CookieLine | null,

    /**
     * ⭐⭐ **结果弹窗底部那颗状态胶囊**（用户 2026-10 定的新结果弹窗）。
     *
     * 它有四种形态（alert1–4），由 `resultFormOf`（@jushuo/shared）按
     * 「这一把攻没攻克」×「之前攻克过没有」判出来 —— 判据**不在模板里**，
     * 因为其中"已经攻克过的人目标换成刷新记录"那条是有前提的，写进 wxml 就没人测得到。
     */
    resultLine: null as { form: string; text: string } | null,
    /** ⭐ 结果弹窗里那句**逐词着色**的原文（与评测详情页共用 lib/word-colors） */
    resultWords: [] as ColoredWord[],

    /**
     * ⭐ **这一句我一共攒了多少饼干**（用户 2026-10 定）—— 由**轮询响应的
     *    `sentenceCookies`** 带回来（服务端按 article 汇总，只算已领取的）。
     *
     * ⚠️ 口径是「这一句」不是「这一局」：同一句话会在不同的参与里被反复挑战，
     *    而用户想问的是"这句我总共练出来多少" ✓
     * ⚠️ null = 还不知道（还没出过分）；0 = 真的还没攒到 —— 两者要分开，
     *    因为界面上「0 🍪」**永远不出现**（那是把"你什么都没得到"说出来）✓
     */
    sentenceCookies: null as number | null,

    /**
     * ⭐ **波形条画不画** —— 只在**这一轮真的收到了能解码的帧**之后才画（用户 2026-10 定）。
     *
     * ⚠️ 不写成"录音中就画"：拿不到帧的环境（或解码不出来的环境）会留一条**空白的横条** ✗，
     *    那看起来像"麦克风没工作"，比不画更让人不安 ✓
     * ⚠️ 代价是录音开始后约 170ms 它才出现（一帧的间隔）—— 那是**对的**：
     *    它出现 = "话筒确实在收你的声音" ✓ 这是个**正反馈**，不是布局抖动 ✓
     */
    waveOn: false,

    /**
     * ⭐ s6 的副标题。
     *   默认是设计稿那句「录音不符合规范，无法检测发音」；
     *   但**超时**进 s6 时会换成一句真话（分数可能还在云端算）—— 见 SCORING_TIMEOUT_MS。
     */
    failDetail: '',

    /**
     * ⭐⭐ 下方「历史挑战」—— **我在这一句上还读过哪几次**（SPEC 施工计划第 4 步）。
     *
     * ⚠️⚠️ 列表里**不含「当前这一次」**（SPEC 已定口径，实现见 lib/article-history.ts）：
     *    用户正看着 s5 那个大号分数，下面再列一条一模一样的会让他以为多了一次。
     *    ⚠️ 因此「历史」与「我在这句上的总次数」是**两个数**，别拿 historyAttempts
     *      去说总量（总量在 s5 标题那句「第 N 次朗读」里，来自服务端的 seq）。
     */
    historyRows: [] as HistoryRow[],
    /** 历史还在路上（第一次进页面时为 true）—— 骨架那句「正在取…」 */
    historyLoading: false,
    /** 历史取失败的一句话；**列表已有内容时也照常说**（不清列表，见 loadHistory） */
    historyError: '',
    /** 免掉当前这一次之后还剩几次（= historyRows.length，给表头用） */
    historyAttempts: 0,
    /** 这些历史里的最高分（'89.5'）；一次都没有时是空串 */
    historyBestText: '',
    /**
     * ⭐ 「我的参与」摘要卡的四个数（挑战 / 最高 / 位列 / 最低）。
     * ⚠️ 与历史行的口径不同：**含当前这一把**（见 lib/article-history.ts 的 historySummaryOf）。
     * ⚠️ 名次 / 参与人数 / 最低分只能来自服务端（`rank` / `participantCount` / `lowestScore`）。
     */
    summary: { attemptsText: '0 次', bestScoreText: '—', rankText: '—', lowestScoreText: '—' },
    /**
     * ⭐ 摘要卡的数据到手过没有。
     * ⚠️ 没拿到就**不画那张卡**（而不是画一张全是「—」的）——
     *    后者会让人以为"我这句一次都没读过"，而真相是"这次没问到"。
     */
    historyReady: false,

    /**
     * ⭐⭐ 提交前那层「确认能量」的开关（用户 2026-09 定）。
     *    false = 不显示；true = 显示（内容看 phase：'precheck' 问余额中 / s3 等确认）。
     * ⚠️⚠️ 它**必须和 phase 分开**：用户在确认弹窗里点「去补能量」时，
     *    我们既要保持"用户不在看页面"（这层不关），又不能让朗读页停在 precheck —— 
     *    他是去能量页了，回来该看到 s3（录音还在、随时能再点 ✓）。
     *    一个字段表达不了这两件事，所以用两个。
     */
    confirmOpen: false,
    /**
     * ⭐ 权威余额（GET /api/user/me 给的，**不是**本机缓存）——
     *    确认弹窗里那行「消耗 2 点，确认后剩 1 点」用它。
     *    ⚠️ 只在这一层打开时才可信（见 onConfirmStart 里那次 setData）。
     */
    confirmEnergy: 0,
    /**
     * ⭐ 确认弹窗里那句「本次评测消耗 N 点」的 N —— 取自 shared 的 ENERGY_PER_CHALLENGE。
     * ⚠️ 端侧**不写死 2**（同 syncEnergyNote 的口径）；它是常量，所以放 data 里给 WXML 用。
     */
    costEnergy: ENERGY_PER_CHALLENGE,
    /**
     * ⭐⭐ **提交按钮下面那一行提示**的文案（见 lib/submit-hint.ts）。
     * ⚠️ 只在 s3 显示；s1/s2 是空串（那时还没有判据）。
     */
    hintText: '',
    /**
     * ⭐ 这一句**是什么性质**（用户 2026-10 定）—— 它同时决定**颜色**和**提交按钮能不能按**：
     *    `ok` ⇒ 绿 + 可提交；`warn` ⇒ 黄 + 可提交（只是建议）；`block` ⇒ **红 + 按钮禁用变灰**。
     * ⚠️ 由 `submitHintOf` **连同文案一起返回**，界面不自己判 ——
     *    各判一次会出现"文字是红的、按钮却能按"这种自相矛盾。
     */
    hintLevel: 'ok' as SubmitHintLevel,
    /**
     * ⭐ 提交按钮能不能按 —— **从 hintLevel 派生**（`block` 就不能按）。
     * ⚠️ 单独存一份而不是让 WXML 写 `hintLevel !== 'block'`：
     *    按钮的 `disabled` 和 `color` 两处都要用它，写两遍迟早只改一处。
     */
    canSubmit: true,
    /**
     * ⭐ **这一遍正在定稿**（已经说了停、但还没拿到结果）—— 按钮显示「识别中…」。
     * ⚠️ 它必须**立刻**有反应：用户点了结束之后如果按钮还写着「结束」，会以为自己没点上。
     */
    releasePending: false,
  },

  /** 这一轮朗读的录音会话（只剩我们自己的录音器，见 speech-session）—— 开始时建，结束后作废 */
  session: null as SpeechSession | null,

  /**
   * ⭐ 句子**原文** —— 判据（missingWordsOf / wordProgressOf）要的是原文不是词数组。
   * ⚠️ 不拿 `plainWords.join(' ')` 回拼：那要再过一次切词，两次结果未必逐字相同。
   */
  refText: '',

  /**
   * ⭐ 定稿时判为「没读到」的那些词 —— 提交门禁读它。
   * ⚠️ 空数组 = 没有拦的理由（包括"这一轮根本没做判断"，比如开发者工具里没有识别）——
   *    两种情况都放行，见 onSubmit 的门禁。
   */
  missedIdx: [] as number[],

  /** ⭐ 波形画布（2d canvas）—— 拿到 node 之前一直是 null */
  waveCanvas: null as WechatMiniprogram.Canvas | null,
  waveCtx: null as WaveCtx | null,
  waveW: 0,
  waveH: 0,
  /** ⚠️ 画布准备的重试次数：尺寸偶尔量到 0（见 prepareWave 的说明） */
  waveTries: 0,
  /** ⭐ 静音自停的两个计数器（见 lib/audio/vad.ts） */
  vad: { ...VAD_STATE_ZERO } as VadState,
  /**
   * ⭐ 波形的**自动增益**（"这一轮见过的最强音" = 满格）。
   * ⚠️⚠️ 它**只作用于画图** —— 静音判据吃的仍是原始采样 ✓
   *    （把增益套到判据上会让它永远判不出静音 ⇒ 永不自动结束 ✗，见 wave.ts）
   */
  waveGain: { ...WAVE_GAIN_ZERO },
  /** ⭐ 录音超时的定时器（见 MAX_RECORD_MS） */
  recordTimeout: null as ReturnType<typeof setTimeout> | null,
  /** 上一帧的时刻 —— 用它量出**真实**的帧间隔（比写死 170ms 准） */
  lastFrameAt: 0,

  /**
   * ⭐ **没读准**的那些：对到的参考词下标 + **识别到的那个词**。
   * ⚠️⚠️ 措辞只能是「识别成 X」（机器听到了什么），**不能**写成「你读错了」：
   *    替换的成因里混着"真的读错了"和"ASR 听错了"两种，从转写里分不出来
   *    （2026-10 实测：正常读 `simpler`，ASR 听成 `similar` / `as simple` / `by the seminar` 都出现过）。
   * ⚠️ 存**下标**不存词：句子里重复词很常见，反查会标错那一个（见 LastRecording 的说明）。
   */
  misreadList: [] as { at: number; heard: string }[],

  /**
   * ⭐ **已经说了停，但这一遍还没定稿** —— 从点结束那一刻起，一直**留到真的出结果**。
   *
   * ⚠️⚠️ 它驱动按钮的「识别中…」文案与 disabled，**必须活到 phase 变 s3 为止**：
   *    提前清掉会让按钮在等待期间退回「松开结束」（见 finishRecording 的说明）。
   *    清除点只有三个：handleSpoken · onError · 停止看门狗超时。
   */
  releasePending: false,

  /** 已经跟会话说过"停"了 —— finishRecording 可能被两条路调到，只真的停一次 */
  stopSent: false,

  /** ⚠️ 松手缓冲期的定时器 —— 缓冲本身已删（识别随插件一起去掉），这个字段现在恒为 null */
  releaseTimer: null as ReturnType<typeof setTimeout> | null,

  /**
   * ⭐⭐ **正在起录**（从点按钮到会话真的建起来，中间隔着一次麦克风授权）。
   *
   * ⚠️⚠️ 为什么需要它（删掉"按住"那套之后**新出现**的风险）：
   *    授权是异步的，那几百毫秒里 `phase` **还是 s1** ⇒ 用户再点一下，
   *    `onTapRecord` 会再走一遍 `startRecording` ⇒ **建出第二个会话** ✗
   *    （两个录音器抢麦克风，而且第一个永远停不下来。）
   *    ⚠️ 按住时代不需要这个：那时"手指还在不在"顺手就挡住了重复触发 ✗
   */
  starting: false,


  /** 页面已销毁 —— 录音回调不再往页面上写（见 onUnload 的说明） */
  gone: false,

  /**
   * 「历史挑战」那一拉**已经因为冷启动重试过一次了**（见 loadHistory 的 catch）。
   * ⚠️ 只重试一次：真的服务挂了时，无限重试会把请求风暴和"永远在转圈"一起送上来。
   * ⚠️ 换句子（loadContent）时复位 —— 那是新的一次加载，理应再有一次冷启动兜底。
   */
  historyRetried: false,



  // ⚠️ 这里原来有一个页面私有的 InnerAudioContext —— 已搬到 lib/audio/play.ts，
  //    因为「我的挑战」列表也要播录音，两个实例会互相抢（见那个文件的说明）。
  /** s2 的计时器（每 100ms 刷一次） */
  timer: null as ReturnType<typeof setInterval> | null,
  /** ⭐ s5 数字滚动的定时器（见 rollNumbers）—— 页面销毁 / 换态时必须清掉 */
  rollTimer: null as ReturnType<typeof setInterval> | null,
  /** 原始词表（不带样式）—— 点词 TTS 用它 */
  plainWords: [] as string[],
  /**
   * 本次提交的 id —— s5 的「评测详情」要靠它去 pages/challenge。
   * ⚠️ 不能从结果里取：SubmitResponse 里没有它（那是给页面看的业务结果，
   *    id 是协议层的，由受理那一步记下来更直接）。
   */
  submissionId: '',

  /**
   * ⭐ 这句录音的**缓存键** = hash(句子原文) + uid（见 last-recording 的边界 ①）。
   *
   * ⚠️ 用内容而不是 articleId：决定录音能不能用的是**参考文本**，
   *    而 articleId 只是它在库里的编号 —— 同一段文本重新导入、或换个环境，
   *    编号就变了，那段录音其实照样有效。
   * ⚠️ uid 必须带上：开发者工具里多个测试账号共用同一份本地存储。
   * ⚠️ 内容加载出来之前是空串；此时不给录音（也就不会写缓存）。
   */
  recordingKey: '',

  /** 本次录音开始时刻 */
  startedAt: 0,
  /**
   * 停止看门狗。
   * ⚠️ manager.onStop 万一不回调（设备异常、录音被系统抢走），
   *    界面会**永远停在 s2**，用户唯一能做的是杀掉小程序。
   *    宁可 3 秒后给一句明确的错误，也不能挂死。
   */
  stopWatchdog: null as ReturnType<typeof setTimeout> | null,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      // ⭐ articleId 是内容 hash（字符串）—— 原样取；缺省退回 '1'（老行为：开发时直接进页也能开）
      articleId: query.id || '1',
      navTop: navPadTop(),
      // ⚠️ 先拿缓存里的值画出来（store 里有上次 /me 的结果），不必等一次往返
      energy: me.getState().userInfo?.energy ?? 0,
    })
    // ⚠️ **不再有 `?date=`**（2026-09 删）：这次挑战归哪一天由**服务端**在受理提交时取它的今天，
    //    端侧不传、也不拿本地时钟算（手机时间可以随便改，见 shared/day.ts）。
    void this.loadContent()
  },

  /**
   * ⭐ 回到这一页就把「历史挑战」重拉一次。
   *
   * ⚠️ 为什么必须重拉：从结果屏（pages/challenge）返回时，用户可能刚在那边
   *    点过「重新挑战」／改过公开设置；更常见的是**刚从这一页提交完**——
   *    那一条必须出现在下面的历史里（见 applyResult 里那次调用）。
   * ⚠️ 首次进入时 onShow 会先于内容到达跑一次（articleId 那时已经有了）：
   *    这次请求不算白费 —— 它和 loadContent 里那次要的是同一份数据，
   *    谁先回来都只是把同一份列表写上。
   */
  onShow() {
    void this.loadHistory()
  },

  /**
   * 页面滚动 → 导航栏（白底什么时候出现，见 lib/nav.ts 的 navSolidFrom）。
   *
   * ⚠️ 必须由页面来转这一手：小程序里**只有页面**有 onPageScroll，
   *    组件没有这个生命周期，而 fixed 的导航栏自己不动、也观察不到页面在滚。
   */
  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  onUnload() {
    // ⚠️ 历史里那段录音也要停：用户已经离开这一页了，声音不该跟着走
    stopAudio()
    /**
     * ⭐ 打完分（s5）、又离开了这一页 → 本地这段录音才算**真正消费掉**。
     *
     * ⚠️⚠️ 为什么是 s5 而不是「提交成功那一刻」：
     *    清掉会把槽位目录整个删除（录音原件 + 试听副本），
     *    而 s5 上那个「试听」按钮播的正是它。删早了 = 按钮点了没反应。
     *    放在这一页的生命周期末尾，两条目的同时满足：
     *      · 用户在结果屏上还能回听自己刚读的；
     *      · 下次进这一句不会再恢复出旧录音（防「隔天点一下提交」白拿 streak）。
     *    ⚠️ s6（失败）**不清**：那段录音没被消费掉，下次进来还能接着用
     *       （设计稿口径：失败后点「重新挑战」才清缓存回 s1）。
     */
    if (this.data.phase === 's5' && this.recordingKey) {
      clearLastRecording(this.recordingKey)
    }

    /**
     * ⭐ 先立旗子再停录音。
     *
     * ⚠️⚠️ 顺序反了会报错：录音一停就会回 onStop，而那条回调里有一堆 setData。
     *    声波那条路更密 —— 它是**每 64ms 一次**，页面销毁后还会继续往一个
     *    不存在的页面上写。
     *
     * ⚠️ 为什么必须真的停：不停的话它会在后台继续录到 60 秒上限，
     *    用户以为"退出就不录了"，而麦克风其实还开着。
     */
    this.gone = true
    // ⚠️ 缓冲定时器也要清：页面没了它还会回来调 finishRecording
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
    this.session?.stop()
    // ⚠️ 还要把它从「当前那个录音器 / 识别管理器」上摘下来：两者都是全局单例、
    //    监听摘不掉，留着它下一帧还会往这个已经没了的页面上写（见 recorder.ts / asr.ts）
    this.session?.dispose()
    this.stopTimer()
    // ⚠️ 数字滚动的定时器也要停：它每 16ms setData 一次，
    //    页面销毁后不停会一直往已销毁的页面上写（rollNumbers 里还有一道 gone 判活）
    this.stopRoll()
    if (this.stopWatchdog !== null) {
      clearTimeout(this.stopWatchdog)
      this.stopWatchdog = null
    }
    // ⚠️ 停掉正在播的声音：用户已经离开这一页了，声音不该跟着走
    stopAudio()
  },

  // ----------------------------------------------------------------
  // 内容
  // ----------------------------------------------------------------
  /**
   * ⭐⭐ 拉「我在这一句上的历史挑战」—— 页面下方那一段（SPEC 施工计划第 4 步）。
   *
   * ⚠️⚠️ 列表**都不含「当前这一次」**（`this.submissionId` 原样传进去免掉）——
   *    口径见 lib/article-history.ts 的说明。恢复出来的 s5 也照这条走：
   *    两种 s5 在界面上长得一模一样，用户分不出是哪一种，列表就不该有两种样子。
   *
   * ⚠️ 失败**不清已有列表**：拉不到新的不该把已经看到的记录也抹掉
   *    （同 pages/me/challenges 的 load）。第一次就失败时列表本来就是空的，
   *    那就是一句错误 + 重试。
   * ⚠️ 页面销毁后不再 setData（同页面上其它异步回调的规矩，见 onUnload）。
   */
  async loadHistory() {
    const articleId = this.data.articleId
    // ⚠️ 只有**第一次**拉才显示「正在取…」：后面每次回页都会重拉，
    //    每次都闪一下那句骨架，会让已经看到的内容像在抖。
    if (this.data.historyRows.length === 0 && !this.data.historyError) {
      this.setData({ historyLoading: true })
    }
    try {
      const res = await fetchParticipationSubmissions(articleId)
      // ⚠️ 期间用户可能已经换了页面 / 这一页销毁了
      if (this.gone || this.data.articleId !== articleId) return
      const { rows, attempts, bestScoreText } = historyRowsOf(res, this.submissionId)
      this.setData({
        historyLoading: false,
        historyError: '',
        historyRows: rows,
        historyAttempts: attempts,
        historyBestText: bestScoreText,
        // ⭐ 摘要卡：四个数直接从接口读（口径见 data 里的说明）
        summary: historySummaryOf(res),
        historyReady: true,
      })
    } catch (err) {
      if (this.gone || this.data.articleId !== articleId) return
      /**
       * ⚠️ 未注册（403 NOT_REGISTERED）：这一句上**必然没有我的历史** ——
       *    它不是一个该显示的错误，按"空历史"处理（这一页本来是受保护页，
       *    未注册的人会被 route guard 送去加入页，这里只是兜底）。
       */
      if (isUnregistered(err)) {
        this.setData({ historyLoading: false, historyError: '', historyReady: true })
        return
      }
      /**
       * ⭐⭐ 冷启动兜底：云托管 `MinReplicas = 0`，闲置后**第一个请求**要等容器起来
       *    （实测 30 秒级，见 api/client 的 LAUNCH_BUDGET_MS）。
       *    正文那一次已经拿了 50 秒预算（它把容器**叫醒了**），而这一条走的是默认 12 秒 ——
       *    所以「刚点进朗读页」那一次多半会先失败。
       *
       *    ⇒ 第一次失败**自己再试一次**（这时实例已经热了，几百毫秒就回来），
       *      用户什么都不会看到。⚠️ 只重试一次：真的连不上时不要变成无限重试。
       *    ⚠️ 正文那次成功（容器已热）就不需要这一手。
       */
      if (!this.historyRetried) {
        this.historyRetried = true
        setTimeout(() => {
          if (!this.gone) void this.loadHistory()
        }, 1500)
        return
      }
      this.setData({
        historyLoading: false,
        historyError: (err as Error).message || '取不到历史记录',
      })
    }
  },

  onRetryHistory() {
    void this.loadHistory()
  },

  /**
   * ⭐ 历史行那颗播放钮报错时，替它说一句话。
   *
   * ⚠️ 组件**只发事件、不弹 toast**（怎么说是宿主的界面语言）—— 这一页是 toast。
   * ⚠️ 取音 / 播放 / "录音不在了"三种情况组件都已经翻成人话了，这里原样展示。
   */
  onHistoryAudioError(e: WechatMiniprogram.CustomEvent<{ message?: string }>) {
    wx.showToast({ title: e.detail?.message || '播放失败', icon: 'none', duration: 2000 })
  },


  /**
   * 点一条历史 → 看**那一次**的结果屏（pages/challenge?sid=…）。
   *
   * ⚠️ 用 navigateTo 而不是 onOpenDetail 那个 redirectTo：那边是「这一把刚读完，
   *    退回来不该对着一个已经交掉的录音界面」；而这里用户是**在页面上翻历史**，
   *    退回来必须还在这一页（他还要接着看别的几次 / 重新挑战）。
   */
  onOpenHistory(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.historyRows[i]
    if (!row) return
    // ⚠️ 别把正在响的声音带进详情页（历史行那颗播放钮的声音也算）
    this.stopAllAudio()
    openChallengePage(row.submissionId)
  },

  async loadContent() {
    // ⚠️ 新的一次加载 ⇒ 「历史那一拉」的冷启动重试机会也要复位（见 historyRetried）
    this.historyRetried = false
    /**
     * ⚠️⚠️ **换句子必须先把饼干数清掉** ✗ —— 否则上一句的数字会留在屏幕上 ✓
     *    ⚠️ 而下面那次拉取**只在拿到时才写** ✗ ⇒ ⚠️ 新句子若是 0，旧数字就永远赖着 ✗✓
     *    ⭐ 所以这里先归 null（⭐ 与"还没拉回来"同一种表现 ✓ 卡片不画 ✓）
     */
    this.setData({ ...phasePatch('loading'), error: '', sentenceCookies: null })
    try {
      const content = await fetchArticleContent(this.data.articleId)
      // ⚠️⚠️ 这条切词规则必须与生成脚本、服务端拼 fileID 的那两处**完全一致** ——
      //    否则点第 3 个词会听到第 4 个词的音，而界面上完全看不出来。
      // ⚠️ 切词走唯一实现：这个下标同时决定「第 i 个词 ↔ 第 i 个音标 / 第 i 个逐词分数」
      this.plainWords = plainWordsOf(content.text)
      // ⭐ 判据要用原文（见 refText 字段的说明）
      this.refText = content.text
      // ⭐ 缓存键由**句子原文 + uid** 决定（不是 articleId）—— 见字段上的说明
      this.recordingKey = recordingKeyOf(content.text, getUserId())
      /**
       * ⭐ 音标跟着词走：words[i].ipa 与 plainWords[i] 是**同一个下标**
       *    （正文生成时就按这条切词规则对齐了）。
       * ⚠️ 老正文可能没有 ipa（空串）→ WXML 里那一行不渲染。
       */
      const words: WordView[] = this.plainWords.map((text, i) => ({
        i,
        text,
        ipa: content.words[i]?.ipa ?? '',
        // ⭐ 一进来默认"读到了" —— 没有预检结果时不该有任何标记
        missed: false,
        misread: false,
      }))
      const stdMs = readStdDurationMs(content.audio)
      this.setData({
        translation: content.translation,
        words,
        // ⚠️ audio 为 null = 这篇还没灌标准音（服务端就是这样表达的，不是 full=null）
        canPlayAudio: !!content.audio,
        fullAudio: content.audio?.full ?? '',
        audioKind: content.audio?.kind ?? 'http',
        // ⚠️ 详情接口**没有**时长（见 stdDurationMs 的说明）—— 有就显示，没有就空着
        stdDurationMs: stdMs,
        ...phasePatch('s1'),
      })

      // ⭐ 内容一到就**后台**把标准音拉到本地 —— 用户点那颗圆钮时就不用等网络了
      this.prefetchStandardAudio()

      // ⭐ 这句子上次录的那段还在吗？在就**直接进入 s3（录音预览）**——
      //    用户不必为了接个电话就重读一遍。
      //    ⚠️ 按**句子**匹配：同一句换个日期再轮到，参考文本一字不差，
      //       那段录音照样是有效的（见 last-recording 的边界 ①）。
      /**
       * ⭐⭐ 上一把已经出分、但用户**没点「重新挑战」就离开了** —— 再进来还停在 s5。
       *
       * ⚠️ 为什么必须这么做：出分那一刻用户可能被叫走 / 顺手退出。
       *    下次进来如果回到 s1，他会以为「白读了、分也没了」（用户 2026-09 的要求）。
       * ⚠️ 判据只用**本地记的 submissionId**，拿它问一次服务端状态：
       *      - scored ⇒ 照旧停在 s5（顺带把 store 刷新一遍）
       *      - 失败 / 查不到 ⇒ 把这条清掉（别每次进来都白问一次），继续走正常流程
       * ⚠️ 顺序在「恢复录音成 s3」**之前**：s5 比 s3 更靠后，也更该被恢复。
       */
      const pending = this.recordingKey ? loadLastResult(this.recordingKey) : null
      if (pending && pending.articleId === this.data.articleId) {
        /**
         * ⚠️⚠️ 这里**必须**接住异常（用户 2026-09 报的「提交记录不存在」就是这个）。
         *
         *    本地记的 submissionId 可能已经不在库里了（清过历史 / 换过环境 /
         *    后台删过那条提交）—— 服务端回 404「提交记录不存在」。
         *    不接住的话它会一路抛到 loadContent 的 catch，整页停在
         *    「提交记录不存在」，连重录都做不了。
         *    **一条本地缓存过期，不该让整个页面打不开。**
         */
        try {
          const st = await fetchSubmissionStatus(pending.submissionId)
          if (st.status === 'scored' && st.result) {
            // ⚠️ 先记住 id：s5 的「评测详情」靠它去 pages/challenge（applyResult 里也要用它存缓存）
            this.submissionId = pending.submissionId
            // ⚠️ roll=false：这是**二次进入**恢复出来的 s5，不播数字滚动
            this.applyResult(st.result, false)
            // ⭐ 这一句共攒了多少（服务端按 article 汇总）—— 与结果一起摆出来
            this.setData({ sentenceCookies: st.sentenceCookies ?? 0 })
            return
          }
          /**
           * ⭐⭐ **上次那一把还在检测中** ⇒ 恢复成等待态**接着等**（用户 2026-09 问的"中途退出"）：
           *
           * ⚠️⚠️ 这里**绝不能**落到下面的"恢复录音成 s3"：那样用户看到的是「请再确认提交」，
           *    而一点 ✓ 就是**第二次提交** —— 新 attemptId、再扣一次能量、历史里多一条
           *    （服务端那条其实还在后台跑，也会出分）。一次朗读被算成两次挑战。
           * ⚠️ 这正是服务端"受理后不写缓存"那个空档的另一半。
           * ⚠️ 轮询会自己判超时与失败（见 pollResult），这里只负责把状态摆回等待态。
           */
          if (st.status === 'scoring') {
            this.submissionId = pending.submissionId
            // ⚠️ uploadPercent=100：上传早就完成了，弹窗该显示"AI 评测中"而不是进度条
            this.setData({ ...phasePatch('scoring'), uploadPercent: 100 })
            void this.pollResult(pending.submissionId)
            return
          }
        } catch (err) {
          // ⚠️ 只警告、不抛：这是一条**过期缓存**，下面清掉它，流程照常往下走
          console.warn('[reading] 恢复上次结果失败（按过期缓存清掉）：' + (err as Error).message)
        }
        if (this.recordingKey) clearLastResult(this.recordingKey)
      }

      const last = this.recordingKey ? loadLastRecording(this.recordingKey) : null
      if (last) {
        /**
         * ⚠️⚠️ **判据要跟着一起恢复** —— 恢复的录音没走过识别，
         *    不恢复的话 `missedTexts` 是空的，**漏读门禁对它完全失效**：
         *    用户读了一半、退出、再进来，就能直接提交。
         *    音频还是那一段，判据当然也还是那一条（见 LastRecording.missedTexts）。
         * ⚠️ 老缓存没有这个字段 ⇒ 空数组 = 「没判过」⇒ 放行（不硬拦没见过的数据）。
         */
        /**
         * ⚠️⚠️ **判据存的是下标**，所以这里直接就能用 ——
         *    不需要拿词去正文里反查（那样在重复词上会标错，见 LastRecording 的说明）。
         */
        this.missedIdx = last.missedIdx ?? []
        this.misreadList = last.misreadPairs ?? []
        const missSet = new Set(this.missedIdx)
        const misreadSet = new Set(this.misreadList.map((m) => m.at))
        this.setData({
          ...phasePatch('s3'),
          restored: true,
          audioPath: last.audioPath,
          playPath: last.playPath,
          durationMs: last.durationMs,
          recordDurationText: mmss(last.durationMs),
          words: this.data.words.map((w, i) => ({
            ...w,
            missed: missSet.has(i),
            misread: misreadSet.has(i),
          })),
        })
        // ⭐ 恢复出来的那一次也要有提示（时长一起恢复了，所以能重算）
        this.syncSubmitHint(last.durationMs)
      }
      this.syncEnergyNote()
      /**
       * ⭐ 这一句的**参与状态**也写进全局 store（用户 2026-09 口径：详情同样走
       *    `GET /api/user/participation/{articleId}`）—— 首页/竞技场读的是同一份。
       * ⚠️ 不 await：它供的是别的页面的角标，不该拖住朗读页的出句。
       */
      /**
       * ⭐⭐ **饼干数就从这一份参与状态里读**（⭐ 用户 2026-10-09 指出的 ✓）
       *
       * ⚠️⚠️ 我原来为这件事**新造了一个接口** ✗（`/api/user/sentence-cookies/{id}` ✓）——
       *    ⭐ 而 `GET /api/user/participation/{articleId}` 的响应里**早就有 `cookies`** ✓✓
       *    （⭐ shared 的 ParticipationRecord.cookies ✓ 注释：「这一句累计赚到的饼干」✓）
       *    ⇒ ⚠️ 接口、字段、客户端封装**全是现成的** ✗ ⇒ ⭐ 那个新接口已删掉 ✓
       *
       * ⚠️ 为什么挂在这里：⭐ 这一行本来就在拉参与状态 ✓（用户 2026-09 口径 ✓）
       *    ⇒ ⭐ 顺手把结果读出来即可，⭐ 零新增请求 ✓
       * ⚠️ `loaded` 这个标记很重要：⭐ 它区分「还没拉到」和「明确没参与」✓
       *    （⭐ 后者 record 是 null ⇒ 给 0 ✓；前者什么都不做 ✓ 保持 null ⇒ 不画那行 ✓）
       */
      // ⚠️ 先记下是【哪一句】—— 请求回来时 this.data.articleId 可能已经变了 ✓
      const cookiesFor = this.data.articleId
      void ensureParticipation([cookiesFor]).then(() => {
        // ⚠️ 期间换句子了（⭐ 用户点了下一句 ✓）⇒ 丢掉这一份 ✓
        if (this.gone || this.data.articleId !== cookiesFor) return
        const { loaded, record } = me.participationOf(cookiesFor)
        // ⚠️ loaded=false = 还没拉到（⭐ 别写 0 ✗ 那会把"不知道"说成"没有"✓）
        if (!loaded) return
        this.setData({ sentenceCookies: record?.cookies ?? 0 })
      })
      /**
       * ⭐ 历史也拉一遍 —— 与 onShow 那次是**同一份数据**（重复一次请求，很便宜）：
       *    这是"一定会拉"的那一条路，而 onShow 只保证"回到页面时"会拉。
       * ⚠️ 放在恢复出来那个 s5 的 return **之后**，所以恢复 s5 时不会走到这里 ——
       *    那条路靠 onShow 那次（它跑在 loadContent 之前）。
       */
      void this.loadHistory()
    } catch (err) {
      this.setData({ ...phasePatch('loading'), error: (err as Error).message })
    }
  },

  onReload() {
    void this.loadContent()
  },

  // ----------------------------------------------------------------
  // 派生展示文本
  // ----------------------------------------------------------------
  /**
   * ⭐ 底部那行能量小字 —— **在 TS 里算好**，WXML 只负责摆。
   *
   *   等待中（uploading 上传中 / scoring 评测中）：评测消耗能量2，剩余3
   *   出了结果（s5 成功）：                        本次评测消耗能量2，剩余3
   *   失败（s6）：                                 本次评测消耗能量0，剩余5
   *
   * ⚠️⚠️ **只在评测弹窗里说**（用户 2026-09 定：把 s3 卡片上那一行删掉）：
   *    提交前那一刻，能量归**确认弹窗**管，而且那里用的是**服务端权威余额**
   *    （见 onSubmit 里 ensureAuthed 顺带拿回的 /me），比拿缓存估的准。
   *    卡片上再挂一行只会变成和弹窗重复的第二个说法。
   *
   * ⚠️⚠️ 端侧**不做结算**（受理时锁 2 点、失败释放都在服务端）：这里显示的「剩余」
   *    是拿手上这份余额减去本次会消耗的点数**预估**出来的。
   *    真正的余额仍以服务端为准（下次 /me 会覆盖它）。
   * ⚠️ 那个 2 取自 shared 的 ENERGY_PER_CHALLENGE，端侧**不写死**。
   */
  syncEnergyNote() {
    const phase = this.data.phase
    const energy = this.data.energy || 0
    const left = Math.max(0, energy - ENERGY_PER_CHALLENGE)
    /**
     * ⚠️ 措辞按设计稿分两种（不是随手加的「本次」）：
     *    预览 / 等待（'uploading' 上传中、'scoring' 评测中）说的是**还没落定**的一次
     *    消耗 ——「评测消耗能量2，剩余3」；
     *    出了结果（s5 / s6）才谈得上「**本次**评测消耗能量…」。
     */
    const head = phase === 's5' || phase === 's6' ? '本次评测消耗能量' : '评测消耗能量'
    /**
     * ⚠️ 「余额不够」这件事**不在这里说**：它由**提交前的确认弹窗**负责
     *    （「现在有 0 点，本次需要 2 点 / 明天会补到 3 点；也可以现在充值」+【去补能量】），
     *    那里用的是服务端权威余额，而且给了能走的出口。
     *    ⚠️ 原来这里给 s3 挂了一句「（不够了，明天会补到 3 点）」—— 它随 s3 那行小字
     *      一起删掉了（**整条分支一起删**，不是留个空变量）：
     *      留着"永远拼不出来的一段文本"是死代码，下次改文案的人会被它骗一次。
     */
    this.setData({
      energyNote:
        phase === 's6'
          ? head + '0，剩余' + energy
          : head + ENERGY_PER_CHALLENGE + '，剩余' + left,
    })
  },

  // ----------------------------------------------------------------
  // s1 交互：IPA 开关 / 开始录音
  // ----------------------------------------------------------------
  /**
   * ⭐ IPA 胶囊 = 切换「单词下方显示音标」。
   * ⚠️ 只是一个显示开关：不动数据、不发请求（音标本来就在正文里）。
   */
  onToggleIpa() {
    this.setData({ ipaOn: !this.data.ipaOn })
  },

  async onStartRecord() {
    // ⚠️⚠️ 防连点：见 starting 的说明。**必须在 await 之前置位**
    if (this.starting) return
    this.starting = true

    const ok = await this.ensureRecordAuth()
    if (!ok) {
      this.starting = false
      this.setData({ error: '需要麦克风权限：请在小程序设置里打开「录音」' })
      return
    }

    /**
     * ⭐⭐ **建会话**（用户 2026-10 定：点一下开始、点一下结束、读完/超时自动结束）。
     *
     * ⚠️ 只剩**一套后端**（我们自己的录音器，见 lib/audio/speech-session）——
     *    插件的流式识别已经砍掉，所以这里不再需要"这一轮是哪个后端"那种判断 ✗
     *    （那段判断是旧的：真机走插件时永远没有帧，所以要按后端分支。
     *      现在每一轮都有帧 ✓）
     */
    this.session = createSpeechSession({
      /**
       * ⚠️⚠️ **`onPartial` 已经没有了**（2026-10：插件被砍，见 lib/audio/speech-session 的文件头）。
       *    逐词上色那条路随之休眠：`r.text` 恒为 null ⇒ 标色不渲染、漏读门禁也不拦 ✓
       *    （它们的数据源就是识别文本，没有识别就没有判据 ✓）
       */
      /**
       * ⭐⭐ **录音帧**（mp3 码流，~170ms 一帧）—— 波形与"读完自动结束"**都靠它**。
       * ⚠️ 帧是压缩码流，要采样得先 decodeFrameToSamples（见 frame-decode 的文件头）。
       */
      onFrame: (f) => this.onRecordFrame(f),
      onDone: (r) => this.handleSpoken(r),
      onError: (e) => {
        this.stopTimer()
        // ⚠️ 会话作废，否则下一次开始会被"上一次还没结束"挡住
        this.session?.dispose()
        this.session = null
        // ⚠️ 同样是 releasePending 的清除点：出错也要把「识别中…」收掉
        this.releasePending = false
        this.setData({ ...phasePatch('s1'), releasePending: false, error: e.message })
      },
    })

    /**
     * ⭐ 每一轮录音都要复位的三样（波形与静音自停的状态机）：
     *   · waveOn —— 上一轮的波形条不能留到这一轮（这一轮还没收到帧呢）
     *   · vad —— 静音/时长计数器从零开始（上一轮的数字会让这一轮被**立刻**判成读完 ✗）
     *   · lastFrameAt —— 帧间隔要重新量（跨轮的间隔是几分钟，不能用）
     */
    this.vad = { ...VAD_STATE_ZERO }
    this.waveGain = { ...WAVE_GAIN_ZERO }
    this.lastFrameAt = 0
    this.waveCtx = null
    this.waveCanvas = null
    this.waveW = 0
    this.waveH = 0
    this.waveTries = 0
    if (this.data.waveOn) this.setData({ waveOn: false })

    // ⚠️ 每一轮录音重置这几个私有计数（放在 setData 外面：它们不进渲染数据）
    // ⚠️ 上一轮的漏读结论也要清：录音若中途报错，旧的判据会把这一次也拦住
    this.missedIdx = []
    this.misreadList = []
    // ⚠️ 词上的标记也一起清（见 clearWordMarks）：判据清了、颜色还挂着的话，
    //    按住之后句子上仍然显示着**上一次**的黄标 / 灰标（同一种"第二份真相"）
    this.clearWordMarks()
    // ⚠️ 提示同理：这一遍还没判过，不能挂着上一遍那句
    this.setData({ hintText: '', hintLevel: 'ok', canSubmit: true })
    // ⚠️ 收尾状态也复位：上一轮的缓冲定时器若还挂着，会把这一轮提前停掉
    this.releasePending = false
    this.stopSent = false
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }

    /**
     * ⚠️⚠️ **开始录新音 = 上一次那次结果作废**：把本地的「上次结果」缓存也清掉。
     *
     *    不清的后果（用户报的"每次都在显示前一次的结果"）：这一页重新 load 时，
     *    `loadContent` 会先查这份缓存、命中就**直接恢复成 s5 并 return** ——
     *    于是"重录 → 提交"根本没机会发生，屏幕上永远是上一次那个分。
     *    （缓存本身是必需的：出分那一刻用户被叫走，回来要能看到分。
     *      所以只在"用户明确开始新一次录音"时清。）
     */
    /**
     * ⚠️⚠️ **清掉结果缓存之前，先把这一把的饼干领了**（用户 2026-10 定）。
     *
     * 这是"离开结果态"的第二条路：用户没点那颗胶囊，直接又录了一遍。
     * 缓存一清，端侧就再也没有指针指向那条提交 ⇒ 不在这里领，他**永远拿不到** ✗
     * （服务端 cookies_earned 还躺着，但没有任何入口会去看它。）
     * ⚠️ 领取是幂等的：点过胶囊的人再走这条路也不会多发 ✓
     * ⚠️ 不 await：领饼干不该挡住"开始录音"这件用户已经决定的事 ✓
     */
    void this.claimCookiesIfAny()

    if (this.recordingKey) clearLastResult(this.recordingKey)

    this.setData({
      ...phasePatch('s2'),
      error: '',
      // ⚠️ 起新录音 = 上一次的门禁提示作废（否则它会挂在新一轮上）
        elapsedText: '00:00',
        // ⚠️ 一旦开始录新的，上一段的提示就不该再挂着
        restored: false,
        audioPath: '',
        // ⚠️ 开始重录 = 上一次尝试作废（旧 attemptId 不能带到新录音上，
        //    否则新音频会顶着旧键提交，命中的是上一次的行）
        attemptId: '',
        playPath: '',
        durationMs: 0,
        recordDurationText: '',
        uploadPercent: 0,
        scoreText: '',
        scoreSubtitle: '',
        cookieLine: null,
        // ⚠️ 同 onRestart：入场开关要复位
        failDetail: '',
      },
    )

    const startedAt = Date.now()
    this.startedAt = startedAt
    this.timer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000
      // ⚠️ 计时器这一格必须**每 100ms 都有值**（mmss 恒返回，不像 formatDuration 会给空串）
      this.setData({ elapsedText: mmss(Date.now() - startedAt) })

      // ⚠️ 这里原来有一条"录了 2 秒还没收到帧"的诊断 —— 波形删掉之后它没有意义了
    }, 100)

    this.session.start()

    /**
     * ⭐⭐ **超时兜底**：到点自动结束（见 MAX_RECORD_MS 的说明）。
     * ⚠️ 从**真的起录之后**开始算，不是从点按钮那一刻 ——
     *    麦克风授权可能要几百毫秒，算进去等于偷偷扣掉用户的朗读时间 ✗
     * ⚠️ 与静音自停共用 `stopSent` 防重入（谁先到谁说了算）✓
     */
    if (this.recordTimeout !== null) clearTimeout(this.recordTimeout)
    this.recordTimeout = setTimeout(() => {
      this.recordTimeout = null
      if (this.data.phase !== 's2' || this.stopSent) return
      console.warn('[reading] 录音超时（' + MAX_RECORD_MS / 1000 + 's）—— 自动结束')
      this.stopSent = true
      this.onStopRecord()
    }, MAX_RECORD_MS)

    // ⚠️ 会话真的建起来了 ⇒ 解除防连点（此后由 phase === 's2' 挡重复开始 ✓）
    this.starting = false
  },

  /**
   * ⭐⭐ **点一下那颗按钮**（用户 2026-10 定：去掉按住说话）—— 同一个按钮两种含义：
   *
   *     s1（待录）⇒ 开始录音
   *     s2（录音中）⇒ 结束录音
   *
   * ⚠️ 用 `bindtap` 而不是 touchstart/touchend：点击是**一次动作** ✓
   * ⚠️ 另外两种"结束"不归它管：**静音自停**（读完了，见 lib/audio/vad.ts）
   *    与 **30 秒超时兜底**（见 MAX_RECORD_MS）✓
   */
  onTapRecord() {
    if (this.data.phase === 's1') {
      /**
       * ⭐ **「嘟」** —— 录音开始的听觉确认（⭐ 用户 2026-10-09 要的 ✓）
       *
       * ⚠️⚠️ **必须挂在"点击"这一层**（⭐ 用户指出 ✓）：
       *    原来放在 `startRecording()` 里 ✗ —— 而那个函数**别处也会被调用** ✗
       *    （⭐ 比如自动接续下一句 ✓）⇒ ⚠️ 于是"嘟"会响在**没有点击**的时候 ✗✓
       *    ⭐ 而它要表达的是"**你按了，麦克风开了**" ✓ ⇒ ⭐ 就得跟点击绑定 ✓
       *
       * ⚠️ 位置：在 `startRecording()` **之前** ✓
       *    ⚠️ 里面第一件事是 `stopAllAudio()`（⭐ 正在响的会被麦克风录进去 ✓），
       *       所以这样排下来：先停掉旧声音 ✓ 再"嘟" ✓ 再开麦克风 ✓
       *    ⇒ ⭐ "嘟"是唯一会被录进去的声音（⭐ 0.13s ✓ 对自动结束门槛可忽略 ✓）
       */
      playBeep()

      this.startRecording()
      return
    }
    if (this.data.phase === 's2') this.stopRecordingByUser()
    // ⚠️ 其余状态（precheck / uploading / scoring / s5 / s6）什么都不做 ✓
  },

  /**
   * ⭐ **开始录音**（用户点了「开始朗读」）—— 点击模式，没有"按住/松手"这回事 ✓
   * ⚠️ 从按下算起的三百毫秒里用户点了别的？不存在这个状态：
   *    点击是一次动作，`s2` 才是"正在录"，中途没有"手指还压着吗"要判 ✓
   */
  startRecording() {
    /**
     * ⚠️ `phase === 's2'` 这一条**同时挡掉了「识别中…」那一态** ——
     *    那时手已松、正在定稿，但 phase 还是 s2（要到 handleSpoken 才变 s3）。
     *    ⇒ 功能上本来就按不动；界面上也把按钮 disabled 了（见 WXML），两处对齐。
     */
    if (this.data.phase === 's2' || this.data.phase === 'precheck') return

    /**
     * ⚠️⚠️ **按下录音前必须把正在响的声音全停掉**（用户 2026-10 定）。
     *
     *    理由不只是"别吵" —— **麦克风就在旁边，正在响的声音会被原样录进这一段**：
     *      · 标准音还在播 ⇒ 录进去的是标准音，识别出来的转写当然全对，
     *        而用户自己根本没出声（漏读判据与打分全废，却查不出原因）；
     *      · 试听自己的录音还在播 ⇒ 等于把上一遍又录了一遍；
     *      · 逐词发音还在响 ⇒ 录进去一两个孤立的单词。
     *    这三件事**用户完全不知道为什么**，只会觉得"这个打分不准"。
     *
     * ⚠️ 放在 startRecording 的最前面（**在 await 麦克风授权之前**）——
     *    而声音必须**在手按下的那一刻**就停 —— 否则那几百毫秒还在往麦克风里灌。
     */
    this.stopAllAudio()

    void this.onStartRecord()
  },

  /**
   * ⭐ **用户点了「结束」** —— 说完了（也可以什么都不点：读完会静音自停 ✓）。
   */
  stopRecordingByUser() {
    if (this.data.phase !== 's2') return

    /**
     * ⚠️⚠️ **原来这里要白等 600ms**（那个缓冲已经删掉了）——
     *    理由是"读完立刻松手，最后 1–2 个词还没进转写，直接停会判成漏读"。
     *    ⭐ 那是**为流式识别存在的**缓冲：识别没了（见 lib/audio/speech-session），
     *      这个等待就只是让用户多盯 600ms 的「识别中…」✗
     *    ⇒ 直接停 ✓ 底层录音器的 onStop 本来就会等文件落完 ✓
     *
     * ⚠️ `releasePending` **仍然要置**：它表示"这一遍正在定稿"，
     *    按钮据此显示「识别中…」并禁用 —— 那段时间是真的存在
     *    （要等录音器回调），只是**不再人为拉长** ✓
     */
    this.releasePending = true
    this.setData({ releasePending: true })
    this.finishRecording()
  },

  /**
   * ⭐ 真正结束这一轮录音 —— 三个"该结束了"（用户点击 / 静音自停 / 超时）都汇到这里。
   * ⚠️ 与 onStopRecord 分开是为了让"只停一次"这件事只有一个出口。
   *
   * ⚠️⚠️ **它只负责"跟会话说停"，不负责关掉「识别中…」** —— 这是踩过的坑：
   *    原来这里把 `releasePending` 置回 false 再停，而**停止是异步的**
   *    （要等插件的 onStop 回来、走 handleSpoken 才变 s3）。
   *    ⇒ 从清掉标记到结果到达之间，`phase` 还是 s2，按钮的文案三元就落到了
   *      「松开结束」——**用户看到按钮"退回"到录音态**，而不是进 s3。
   *      识别越慢这个窗口越长，看起来就像"松手没生效"。
   *    ⇒ 所以 `releasePending` 的**唯一清除点**是"真的定稿了"：
   *      handleSpoken（s3）· onError · 停止看门狗超时。三个出口见各自的注释。
   */
  finishRecording() {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
    /**
     * ⚠️ 定时器与"追上就提前收工"两条路都会走到这里，**只真的停一次**。
     *    原来靠 `releasePending` 兼职这个判断，现在它得一直留到定稿，
     *    所以另立一个只进不出的标记。
     */
    if (this.stopSent) return
    this.stopSent = true
    this.onStopRecord()
  },

  /**
   * ⭐ 准备波形画布（2d canvas）—— 幂等，可以反复调。
   *
   * ⚠️ 尺寸**偶尔量到 0**（卡片刚切到 s2、布局还没完）⇒ 重试几次（老版本踩过这个坑）。
   * ⚠️ backing store 要按 **dpr** 开、再 `scale(dpr)`，否则在高分屏上糊成一块。
   */
  prepareWave() {
    if (this.waveCtx || this.gone) return
    this.createSelectorQuery()
      .select('#wave')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (this.gone) return
        const info = res?.[0] as
          | { node?: WechatMiniprogram.Canvas; width?: number; height?: number }
          | undefined
        const node = info?.node
        const w = Math.round(info?.width ?? 0)
        const h = Math.round(info?.height ?? 0)
        if (!node || w <= 0 || h <= 0) {
          if (this.waveTries++ < WAVE_PREPARE_TRIES) setTimeout(() => this.prepareWave(), 60)
          return
        }
        const dpr = wx.getWindowInfo?.().pixelRatio || 2
        node.width = w * dpr
        node.height = h * dpr
        // ⚠️ 运行期给的就是 2d 上下文；类型上小程序标的是 DOM 那个类型 ⇒
        //    显式转到 WaveCtx（只声明我们真调的那几个方法，见它的定义）
        const ctx = node.getContext('2d') as unknown as WaveCtx
        ctx.scale(dpr, dpr)
        this.waveCanvas = node
        this.waveCtx = ctx
        this.waveW = w
        this.waveH = h
      })
  },

  /**
   * ⭐⭐ **每来一帧就做两件事**：画波形、累计静音（判"读完"）。
   *
   * 一次解码两处用 —— 见 lib/audio/wave.ts 与 lib/audio/vad.ts。
   *
   * ⚠️ 判"静音/有声音"用的是**音量能量**（RMS），不是识别 —— 见 lib/audio/vad.ts ✓
   * ⚠️ `classifyChunk` 给的是**三态**：拿不到采样时走 'undecodable'（当成他在说话）✓
   *    那是安全方向 —— 绝不因为"读不出数据"就把用户的录音掐断 ✗
   */
  async onRecordFrame(frame: ArrayBuffer) {
    if (this.gone) return

    /**
     * ⭐ **一条读法**（2026-10 定）—— 帧交给 `decodeAudioData` 解成采样。
     *
     * ⚠️⚠️ 这里曾经按"帧的实际内容"分过两条路（裸 PCM 直读 / 压缩块走解码）——
     *    **拆掉了** ✗：那是**为环境差异准备的分支**（模拟器的帧是 WebM），
     *    而分支解决不了环境差异（工具那边两条路都拿不到采样 ✓），
     *    只让代码多了一倍路径、还多一层"这一轮到底走哪条"的状态 ✗
     *
     * ⭐ 平台差异如实写在这里，不用代码去绕：
     *    · **真机**：解得开 ⇒ 波形 ✓ + 静音自停 ✓（用户实测确认 ✓）
     *    · **开发者工具**：帧是 WebM/Opus（平台行为）⇒ 解不开 ⇒ 返回 null
     *      ⇒ 波形不画、静音不判（**安全方向**：绝不会因为读不出数据就掐断录音 ✓）
     *      ⚠️ 这个功能只能在真机上验 —— 这不是 bug，也不去绕它 ✓
     */
    const samples = await decodeFrameToSamples(frame)
    if (this.gone) return

    // ── ① 波形 ──────────────────────────────────────────────
    /**
     * ⚠️ 画不画由 `waveOn` 决定，而它**只在真的解出采样之后**才置真 ✓
     *    —— 不这么做的话，拿不到帧的环境会留一条**空白横条** ✗
     *    （看起来像"麦克风没工作"，比不画更让人不安。）
     */
    if (samples) {
      if (!this.data.waveOn) {
        this.setData({ waveOn: true })
        // ⚠️ 等这一帧渲染出 canvas 节点之后再去找它（同一帧里 query 不到）
        setTimeout(() => this.prepareWave(), 0)
      }
      this.drawWave(samples)
    }

    // ── ② 静音自停（"读完了"）────────────────────────────────
    /**
     * ⚠️ 帧间隔**用手表量**，不用写死的 170ms：
     *    设备忙的时候帧会变稀，写死会让"静音 1.2 秒"实际只过了 0.8 秒 ✗
     */
    const now = Date.now()
    const frameMs = this.lastFrameAt > 0 ? Math.min(1000, now - this.lastFrameAt) : FRAME_MS_FALLBACK
    this.lastFrameAt = now

    this.vad = advanceVad(this.vad, classifyChunk(samples), frameMs)

    /**
     * ⭐ 判据：说够了时长（标准音 × 1.2）**且**连续静音 1.2 秒 ⇒ 自动结束
     * ⚠️ 拿不到标准音时长时 autoStopAfter 一律返回 false（宁可让用户自己点）✓
     */
    if (autoStopAfter({ ...this.vad, wordCount: this.data.words.length })) {
      /**
       * ⚠️⚠️ **必须防重入**：满足条件之后**每一帧**都会再判一次 ✓ ⇒
       *    不拦的话会连着调好几次 `session.stop()` ✗（并反复重置那个 3 秒看门狗，
       *    真有异常时反而永远触发不了）。
       * ⭐ 复用 `stopSent`：它本来就是"停已经发出去了"这个意思 ✓
       *    （用户先松手/先点结束时它已经被置真 ⇒ 这里自然不会再发一次 ✓）
       */
      if (this.stopSent) return
      this.stopSent = true
      console.log('[reading] 静音自停：已录 ' + this.vad.recordedMs + 'ms，静音 ' + this.vad.silentMs + 'ms')
      this.onStopRecord()
    }
  },


  /** ⭐ 把这一帧的采样画成柱子（直接画在 canvas 上，**不走 setData**） */
  drawWave(samples: Float32Array) {
    const ctx = this.waveCtx
    const w = this.waveW
    const h = this.waveH
    if (!ctx || w <= 0 || h <= 0) return

    const barCount = Math.max(8, Math.min(WAVE_MAX_BARS, Math.floor(w / 8)))
    const raw = peakBars(samples, barCount)
    if (raw.length === 0) return

    /**
     * ⭐⭐ **按"见过的最强音"放大再画** —— 人说话的峰值通常只到满量程的 0.2~0.5，
     *    照原样画柱子只有半高的两三成（用户真机实测：「其它都对，就是幅度不够」）✓
     * ⚠️⚠️ 增益**只在这里用** —— 上面喂给 VAD 的 `samples` 是**原始**的 ✓
     *    （VAD 的阈值 0.02 是绝对值；把增益套上去会让静音判不出来 ✗）
     */
    this.waveGain = advanceWaveGain(this.waveGain, raw)
    const heights = applyWaveGain(raw, this.waveGain)

    const mid = h / 2
    const step = w / heights.length
    const barW = Math.max(1, step * 0.6)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = WAVE_COLOR
    for (let i = 0; i < heights.length; i++) {
      // ⚠️ 留 1px 上下边距：柱子贴边会被裁掉半个像素，看起来像在抖
      const peak = Math.max(1, Math.min(mid - 1, (heights[i] ?? 0) * mid))
      ctx.fillRect(i * step, mid - peak, barW, peak * 2)
    }
  },

  onStopRecord() {
    /**
     * ⭐ **「叮」** —— 录音结束的听觉确认（⭐ 用户 2026-10-09 要的 ✓）
     *
     * ⚠️ 放在这里是因为它**正好是两条结束路径的共同出口** ✓：
     *    · 静音自停（⭐ 读完了 ✓）· 用户点结束 ✓
     * ⚠️ 而**不是**放在"进入 s3"那几处 ✗ ——
     *    s3 是**识别回来之后**才到的（⭐ 慢一拍 ✗），
     *    而"叮"要的是**结束那一刻**的即时确认 ✓✓
     * ⚠️ 全链路 try/catch 在 playDing 内部 ✓：「叮」失败绝不影响录音流程 ✓
     */
    playDing()
    // ⚠️ 停下来了就不该再有超时：不清的话它会在进了 s3 之后突然再来一次
    if (this.recordTimeout !== null) {
      clearTimeout(this.recordTimeout)
      this.recordTimeout = null
    }
    this.session?.stop()

    if (this.stopWatchdog !== null) clearTimeout(this.stopWatchdog)
    this.stopWatchdog = setTimeout(() => {
      this.stopWatchdog = null
      if (this.data.phase !== 's2') return
      this.stopTimer()
      // ⚠️ 这里也要关掉「识别中…」：这是 releasePending 的清除点之一，
      //    漏了它按钮会永远停在"识别中"（而 phase 已经回 s1 了）
      this.releasePending = false
      this.setData({ ...phasePatch('s1'), releasePending: false, error: '录音没有正常结束（3 秒内没收到停止回调），请重试' })
    }, 3000)
  },

  /** s2 → s3：录音落地，进预览 */
  handleSpoken(r: SpeechResult) {
    /**
     * ⚠️ 页面已经销毁就什么都别做。
     *
     *    录音在 onUnload 里会被停掉，而停掉就会**回一次 onStop** ——
     *    那次回调落在已经没了的页面上，里面每一句 setData 都会报
     *    「setData on destroyed page」。守卫放在最前面，后面的逻辑不必各自提防。
     */
    if (this.gone) return

    // ⚠️ 收到回调就把看门狗撤掉，否则 3 秒后它会误报「没正常结束」
    if (this.stopWatchdog !== null) {
      clearTimeout(this.stopWatchdog)
      this.stopWatchdog = null
    }
    this.stopTimer()

    /**
     * ⭐⭐ **定稿**：把流式那套"三种状态"收成"两种"。
     *
     * ⚠️ 为什么必须重算、而不是沿用流式最后一帧的颜色：
     *    流式里"最后一个匹配之后"的词一律算**还没读到**（因为分不清用户是跳过了还是没读到那儿）。
     *    现在读完了 ⇒ **不再有"还没读到"**，剩下的缺位全都是**漏读**。
     *    这就是 `missingWordsOf` 与 `wordProgressOf` 的分工（见 shared/word-align.ts）。
     *
     * ⚠️ **没有识别文本时（开发者工具 / 插件降级）什么都不标**：
     *    那种环境压根没做判断，标出来的任何东西都是编的。`missedIdx` 保持空 ⇒ 门禁放行。
     */
    const words = this.data.words
    if (r.text === null) {
      this.missedIdx = []
      this.misreadList = []
      this.clearWordMarks()
    } else {
      /**
       * ⭐⭐ **一次对齐，两列结果**：没读到的（缺位）与没读准的（替换 + 识别到的词）。
       * ⚠️ 但**只有"没读到"拦提交** —— 替换不可靠（见 AlignmentDetail.substituted 的说明），
       *    拿它拦人会把"ASR 听错"变成"用户交不上去"。
       */
      const detail = alignmentDetailOf(this.refText, r.text.split(/\s+/).filter(Boolean))
      const missSet = new Set(detail.missing)
      /**
       * ⚠️ 只给**真的会显示出来的**那些打黄标 —— 与弹窗用同一条列表：
       *    两边不一致会出现"字是黄的、弹窗里却没提它"（或者反过来）。
       */
      const misreadList = detail.substituted
        .map((sp) => ({ at: sp.at, heard: sp.heard }))
        .filter((x) => (words[x.at]?.text ?? '') && x.heard && words[x.at]?.text !== x.heard)
      const misreadSet = new Set(misreadList.map((x) => x.at))
      this.missedIdx = detail.missing
      this.misreadList = misreadList
      this.setData({
        words: words.map((w, i) => ({
          ...w,
          missed: missSet.has(i),
          misread: misreadSet.has(i),
        })),
      })
    }

    // ⭐ 判据变了 ⇒ 提示跟着重算（唯一出口，见 syncSubmitHint）
    this.syncSubmitHint(r.durationMs)

    /**
     * ⭐ 试听播的就是**录音落地的那个文件**，不再从帧拼 WAV。
     *
     * ⚠️ 原来要拼 WAV 是因为：真机落盘的是**裸 PCM**（没有文件头），
     *    InnerAudioContext 播不了，只能拿帧自己造一个。
     *    现在落盘的是 mp3，**两个平台都能直接播** ——
     *    那一整套绕法连同它的坑一起没了。
     */
    const playPath = ''

    // ⭐ 落盘 —— 万一片子丢了、页面退了，下次进同一句挑战还能捡回来
    if (this.recordingKey) {
      saveLastRecording({
        key: this.recordingKey,
        tempFilePath: r.audioPath,
        playPath,
        durationMs: r.durationMs,
        // ⭐ 判据跟着录音一起存 —— 否则从缓存恢复的那一次会**绕过漏读门禁**
        //    （恢复的录音没走过识别，missedTexts 会是空的）。见 LastRecording.missedTexts
        missedIdx: this.missedIdx,
        misreadPairs: this.misreadList,
      })
    }

    this.setData({
      ...phasePatch('s3'),
      /**
       * ⚠️⚠️ **「识别中…」在这里才收掉**（与 phase 变 s3 同一帧）——
       *    这是它最主要的清除点：早一步清，按钮就会在等待期间退回「松开结束」。
       */
      releasePending: false,
      restored: false,
      // ⭐ 新录音 = 新的一次尝试（幂等键在这里诞生，之后重试一直用它）
      attemptId: newAttemptId(),
      // ⚠️ 两个路径是两个用途，别混：
      //    audioPath → 录音落地文件：**上传**给对象存储 + **试听**都是它
      //    playPath  → 老版本留下的「帧拼 WAV」副本，新录音恒为空串
      audioPath: r.audioPath,
      playPath,
      durationMs: r.durationMs,
      recordDurationText: mmss(r.durationMs),
      replayState: 'unplay',
      error: '',
    })
    this.syncEnergyNote()
  },

  /**
   * 试听**我的录音**（s3 那颗 outline 胶囊）。
   *
   * ⭐ 录音格式是 mp3 之后，这件事**变简单了**：落盘的那个文件本身就是能播的容器，
   *    两个平台播的都是它。
   *
   * ⚠️ 但**老缓存**还得照顾：以前录的是裸 PCM，真机播不了，
   *    那份「帧拼 WAV」的副本还在槽位目录里（playPath）——
   *    所以下面那套「主音源播不出来就换备用」的逻辑留着，
   *    它现在的唯一用途就是把老录音放出来。
   */
  async onReplay() {
    // 再点一次 = 停（与卡片、结果页的播放钮同一套手感）
    if (this.data.replayState === 'playing') {
      stopAudio()
      this.setData({ replayState: 'unplay' })
      return
    }
    // 取音途中再点 = 忽略（还没出声）
    if (this.data.replayState === 'loading') return

    const primary = IS_DEVTOOLS ? this.data.audioPath : this.data.playPath
    const fallback = IS_DEVTOOLS ? this.data.playPath : this.data.audioPath
    const src = primary || fallback

    if (!src) {
      this.setData({
        error: this.data.audioPath ? '试听文件没生成成功 —— 请重录' : '还没有录音',
      })
      return
    }

    // ⚠️ 标准音 / 单词 / 试听**共用同一个播放器**，开播前先把别人的标记清掉，
    //    否则会出现「试听在播」和「标准音在播」两颗钮同时亮着
    this.setData({ replayState: 'loading', sentenceState: 'unplay', playingWord: -1 })

    /**
     * ⚠️⚠️ 这一步**不能省**：`replayState` 是三态 unplay → loading → playing，
     *    而 UI 只认 'playing' 才画停止字形（见 WXML 的 icon 三元）。
     *
     *    之前这里漏了它 —— 点下去永远是转圈，因为 `loading` 一律被
     *    `ui-button` 翻译成"转圈 + 吞掉点击"（用户 2026-09 报的
     *    「点击播放后一直显示 spinner 而不是停止」）。
     *
     *    ⚠️ 为什么这里可以**立刻**置 'playing'，而标准音那条路要等取音完：
     *       · 试听播的是**本机文件**（audioPath / playPath），没有取音过程 ——
     *         真出错会走 onError，下面的 catch 会把状态收回 unplay；
     *       · 标准音要先 ensureLocalAudio（可能要下载），那段时间是真"loading"。
     *      ⇒ 状态的含义是「**用户看到的**该是什么」，不是"内部走到哪一步了"。
     *    ⚠️ 与 onPlaySentence 的写法保持一致（那里也是先置 playing 再 playUrl）。
     */
    this.setData({ replayState: 'playing' })

    try {
      await this.playUrl(src, '试听')
      return
    } catch (err) {
      /**
       * ⚠️⚠️ 只有**确认播不出来**（onError）才换另一个音源。
       *
       *    这不违反上面那个「按平台选主音源」的原则 ——
       *    那条原则禁止的是「先试一个、能播就用」：帧拼的 WAV 在模拟器里是
       *    **能播的噪声**，「能播」区分不了「播的是对的音频」和「播的是垃圾」。
       *    而这里换的条件是**报错**，不是「没出声」。
       *
       *    ⭐ 之所以需要它：从缓存恢复的录音，主音源是复制过来的文件，
       *       而复制品和原件在扩展名/路径上总有差异（见 last-recording.ts）。
       *       原件能播不等于复制品也能播 —— 这时备用音源是唯一的出路。
       */
      if (!fallback || fallback === src) {
        this.setData({ replayState: 'unplay', error: (err as Error).message })
        return
      }
      console.warn('[reading] 主音源播不出来，改用备用：' + (err as Error).message)
    }

    try {
      await this.playUrl(fallback as string, '试听')
    } catch (err) {
      this.setData({ replayState: 'unplay', error: (err as Error).message })
    }
  },

  /**
   * ⭐ 播一个音频地址 —— 实现已搬到 lib/audio/play.ts（**全站共用一个播放器**）。
   *
   * ⚠️ 为什么不再各页自建 InnerAudioContext：小程序对同时存在的实例数有限制，
   *    反复建而不 destroy，点到第七八个词就会静默不播。
   *    「我的挑战」列表也要播录音，那份逻辑必须是**同一份**。
   *
   * ⚠️ 这里只把「播完清掉正在播的标记」这件事接上来。
   */
  /**
   * ⭐⭐ **把正在响的声音全停掉** —— 标准音 / 逐词发音 / 试听，三路。
   *
   * ⚠️ 三路**共用同一个播放器**（lib/audio/play.ts 里那一个），但界面上是**三个独立状态** ——
   *    只 `stopAudio()` 而不复位状态，按钮会永远停在"播放中"（那颗钮再也回不到 ▶）。
   *    ⇒ 两件事必须一起做，所以收敛成一处（这个组合在页面里重复过好几处）。
   *
   * ⚠️⚠️ 它**同时是"取消正在取音、还没出声的那一路"的手段**：
   *    三路的出声都是异步的（标准音要下载、逐词发音要 TTS 合成约 1s），
   *    状态一旦被复位，"await 回来的那条路"会**自己放弃出声**（见下面两处守卫）。
   *    ⇒ 所以**顺序要紧：先 stopAudio、再复位状态**，反过来会有"停完又被播起来"的窗口。
   */
  stopAllAudio() {
    stopAudio()
    const d = this.data
    // ⚠️ 已经是干净的就别 setData（这条路会被"按下录音"这种高频动作调到）
    if (d.playingWord !== -1 || d.sentenceState !== 'unplay' || d.replayState !== 'unplay') {
      this.setData({ playingWord: -1, sentenceState: 'unplay', replayState: 'unplay' })
    }
  },

  playUrl(src: string, what: string, segment?: { startMs: number; endMs: number }): Promise<void> {
    // ⚠️ 播成功就把上一次的错误提示清掉 —— 这是原来那个实现里的一句
    //    setData({ error: '' })，搬走之后漏了它的话，
    //    症状是「重试成功了，红框还挂在那儿」。
    return playAudioUrl(src, what, () =>
      // ⚠️ 播完把三个播放标记都清掉：标准音 / 逐词 / 试听共用播放器，谁先停都要回到「没在播」
      this.setData({ playingWord: -1, sentenceState: 'unplay', replayState: 'unplay' }),
      // ⭐ segment：只播这个词那一段（见 onPlayWord）
      segment,
    ).then(() => {
      if (this.data.error) this.setData({ error: '' })
    })
  },

  /**
   * ⭐ 进页面就**后台预拉取**整句标准音。
   *
   * ⚠️ 预拉取只影响"快不快"，不影响"能不能"：
   *    失败时 ensureLocalAudio 会退回远端地址，用户照样能听，只是慢一点。
   */
  prefetchStandardAudio() {
    if (!this.data.canPlayAudio || !this.data.fullAudio) return
    const kind = this.data.audioKind
    // ⚠️ 只预拉整句：逐词音是**点的时候才合成**的（TTS），没法预拉 ——
    //    合成结果按词缓存在 wordVoiceCache 里，第二次点同一个词就秒出。
    prefetchAudio([{ src: this.data.fullAudio, kind }])
  },

  /** ⭐ s1 / s3 顶行那颗圆钮：播整句标准音 */
  async onPlaySentence() {
    if (!this.data.fullAudio) return
    // ⚠️ 先读进局部量再判断：await 之后还要再看一次「用户有没有取消」，
    //    而直接用 this.data 判断会让 TS 把后面的比较窄化成恒真/恒假
    const st = this.data.sentenceState
    // 再点一次 = 停 —— 与卡片、结果页的播放钮同一套手感
    if (st === 'playing') {
      stopAudio()
      this.setData({ sentenceState: 'unplay' })
      return
    }
    /**
     * ⚠️⚠️ 取音途中再点 = **重试**，不是忽略。
     *
     * 这里原来是 return（忽略），配上 ui-button 的 loading 会一起吞掉点击 ——
     * 一旦某次取音卡住（下载挂住 / 抛异常），这颗钮就**永远点不动了**，
     * 而界面上只看到一个转圈（用户 2026-09 报的"播放按钮不能播放"）。
     * 宁可重复发起：ensureLocalAudio 对同一个 src 有 in-flight 去重，
     * 重复点不会真的多下一遍。
     */
    this.setData({ playingWord: -1, replayState: 'unplay', sentenceState: 'loading', error: '' })

    let url = ''
    try {
      url = await ensureLocalAudio(this.data.fullAudio, this.data.audioKind)
    } catch (err) {
      // ⚠️ 它理论上不抛，但**绝不能让它把状态留在 loading**（那就是按钮死掉）
      console.warn('[reading] 标准音取音抛错：' + (err as Error).message)
    }
    if (!url) {
      /**
       * ⚠️ 把足够排查的上下文打到控制台（用户能直接把这一行发回来）：
       *    · kind = cloud  ⇒ 服务端把它当云文件（本机拿不到，多半是 STORAGE 配错）
       *    · kind = http 且 src 是相对路径 ⇒ 本机地址没拼上 / 没勾「不校验合法域名」
       */
      console.warn(
        '[reading] 标准音取不到：kind=' + this.data.audioKind + ' src=' + this.data.fullAudio,
      )
      this.setData({ sentenceState: 'unplay', error: '标准音取不到，请稍后再试' })
      return
    }
    // ⚠️ 等待期间用户可能已经取消了 —— 那就别再出声
    if (this.data.sentenceState !== 'loading') return
    this.setData({ sentenceState: 'playing' })
    this.playUrl(url, '标准音').catch((err: Error) =>
      this.setData({ sentenceState: 'unplay', error: err.message }),
    )
  },

  /**
   * ⭐ 点某个词听它的发音 —— 走**微信同声传译插件**（免费、不占外网域名、不依赖第三方）。
   *
   * ⚠️⚠️ 这里**以前**是在整句标准音上定位到该词的 startMs→endMs 播放。改成 TTS 之后：
   *    · 听到的是**词典式的孤立读音**，不是句中的连读/弱读形 —— 这是刻意的取舍
   *      （用户 2026-09 的决定：点词给"这个词怎么念"，整句给"这句话怎么念"）；
   *    · 正文里因此不再需要逐词时间戳与音频切片（见 types/content.ts 的 ArticleWordItem）。
   * ⚠️ 下标由 **dataset** 带来（WXML 里 data-i），不能靠遍历 words 现找 ——
   *    词的文本可能重复（"the" 在一句里出现两次），按文本找必然指向错的那个。
   * ⚠️ 插件拿不到（app.json 没声明 / 版本不对）时**明确报错**，不静默失败。
   */
  async onPlayWord(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    if (!Number.isInteger(i) || i < 0) return

    // ⚠️ 先把高亮打上：合成要等 ~1s，没有即时反馈会让人以为"点了没反应"
    this.setData({ playingWord: i, sentenceState: 'unplay', replayState: 'unplay', error: '' })

    let src: string
    try {
      src = await speak(this.plainWords[i] ?? '')
      /**
       * ⚠️⚠️ **取音期间可能已经被叫停** —— 那就别再出声。
       *    逐词发音要先过 TTS 合成（约 1s），**这个窗口是三路里最大的**：
       *    没有这道守卫，用户按下录音之后，那个词的声音才会响起来，
       *    然后**被原样录进这一遍录音**。
       * ⚠️ 判据与 onPlaySentence 同一套写法（await 之后重新看一眼状态）；
       *    这里看的是 `playingWord` 还是不是自己 —— 被停掉时它会被复位成 -1。
       */
      if (this.data.playingWord !== i) return
    } catch (err) {
      /**
       * ⚠️⚠️ 失败时必须**把高亮清掉**。漏掉这一步的症状：那一个词永远亮着，
       *    看起来像页面卡住了 —— 而真正的原因（插件没在公众平台添加）被埋在高亮下面。
       * ⚠️ message 由 lib/audio/tts.ts 写好（含"去哪添加插件"），这里直接展示。
       */
      this.setData({ playingWord: -1, error: (err as Error).message })
      return
    }

    try {
      await this.playUrl(src, '单词发音')
    } catch (err) {
      // ⚠️ 播失败也一样要清（playAudioUrl 的 onEnded 不会在 error 路径上被调用）
      this.setData({ playingWord: -1, error: (err as Error).message })
    }
  },

  stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  // ----------------------------------------------------------------
  // s3 → 弹窗：提交评测（**先三份检查，再上传**）
  // ----------------------------------------------------------------
  /**
   * ⭐⭐ 点 s3 那颗绿 ✓ —— **提交前的三份检查**（用户 2026-09 定）。
   *
   * 顺序是刻意的（先便宜后贵、先本地后网络、最后才锁能量）：
   *   ① **时长**（本地、零成本）：录音太短是**技术无效**，不该走到上传 ——
   *      原来它只在页面底部挂一条红字，用户得自己低头看；现在它在**弹窗正文**里
   *      说清"你录了 0.8 秒、至少要说满 1.5 秒"。
   *   ② **身份**（一次权威 /me，顺带拿到余额）—— 判据与**导航栏那一格完全相同**：
   *      "服务端应答过我吗"。本机连身份都没有（uid = 0）或 /me 问不到 → 拦住这次提交，
   *      给一句人话。⚠️ 与昵称 / 头像**毫无关系**（那是"补资料"，不是前置条件）。
   *   ③ **能量**：余额够 → 列清「消耗 2 / 确认后剩 1」等用户点确认；不够 → 【去补能量】。
   *      ⚠️ 用的是 /me 那份**权威余额**（它会顺手把当天该补的补上），不是本机缓存 ——
   *        否则会出现"本机以为够 → 白传一次 → 被服务端打回"。
   *
   * ⚠️ 三份都过了才进 onConfirmStart()（那一步才真的锁能量、开评测弹窗）。
   */
  async onSubmit() {
    const { audioPath, durationMs, phase } = this.data
    if (!audioPath) return
    // ⚠️ 弹窗里的按钮已经盖住了页面（✓ 点不到第二次）；这里再挡一道是防连点
    //    （会白烧一次上传流量 + 白锁一次能量）
    if (phase === 'uploading' || phase === 'scoring' || phase === 'precheck') return

    /**
     * ⭐⭐ **第 0 道：漏读门禁**（用户 2026-10 定：「没读到的都不允许提交」）。
     *
     * ⚠️ 放在最前面：它不花一分钱（判断在录音结束那一刻就算好了，这里只是读一下状态），
     *    而它问的正是"你确定读完了吗" —— 比时长、身份、能量都更该先回答。
     *
     * ⚠️⚠️ **误拦是这道门禁唯一的致命错误**（读对了却交不上去），而判据的假阳性率样本还小
     *    ⇒ 必须留出口。⭐ 那个出口**同时是假阳性率的测量仪器**：每一次被点，
     *    就是一条已知误报，上线后能持续量到真实误报率（见 prd 7.3）。
     */
    /**
     * ⚠️⚠️ **拦下但不弹窗**（用户 2026-10 定）—— 该说的话已经在按钮下面那行提示里了，
     *    再弹一次是同一件事的第二个说法。
     *
     * ⚠️ 现在按钮本身已经是 **disabled + 灰**（见 WXML），所以正常按不到这里 ——
     *    这一道是**兜底**（比如将来有别的入口调 onSubmit）。改成"强调提示"那一套已经不需要了：
     *    按钮都灰了，"点了没反应"的困惑不存在。
     * ⚠️ 判据用 `canSubmit` 而不是再数一遍 missedIdx —— 与按钮、与文案**同一份真相**。
     */
    if (!this.data.canSubmit) return

    // ⭐ 检查 1：时长 —— 不合格时**留在 s3**（不是进 s6）：s6 是「引擎判失败」的结果屏，
    //    而这一条在提交之前就能拦住，用户重录一遍再点就是了。
    //    ⚠️ 它刻意**不进确认弹窗**：那会变成"打开一个弹窗只为了报错"，
    //      而这一条根本不需要用户做决定（他只需要重录）。
    if (durationMs < PREFLIGHT.minDurationMs) {
      this.setData({
        error:
          '录音太短（' + (durationMs / 1000).toFixed(1) + ' 秒），至少要说满 ' +
          PREFLIGHT.minDurationMs / 1000 + ' 秒',
      })
      return
    }

    /**
     * ⭐ 检查 2 / 3：先开确认层，再问服务端要权威余额。
     * ⚠️ 先开层（phase='precheck' + confirmOpen）再 await：这几百毫秒里用户
     *    必须看到"在处理"，而不是点了一下什么都没发生。
     */
    this.setData({
      confirmOpen: true,
      ...phasePatch('precheck'),
      error: '',
      confirmEnergy: this.data.energy,
    })

    /**
     * ⚠️⚠️ 这里调的是**统一的 auth**（`lib/auth.ts`），它自己会：
     *    · 已经有身份 → 顺带把 `/me` 拿回来（提交前那次确认要的是里面的权威余额）；
     *    · 还没有 → 静默登录 + 注册，再取资料；
     *    · 都不行 → **把用户送去加入页**并返回 false。
     *    ⇒ 页面这里不再自己判断 uid、也不再自己跳页（用户 2026-09 定：只留一处实现）。
     */
    const auth = await ensureAuthed({ needProfile: true })
    // ⚠️ 期间用户可能已经退出了这一页（或者重录了）—— 那就不再往下走
    if (this.gone || this.data.phase !== 'precheck') return

    if (auth !== 'joined') {
      /**
       * ⚠️ 两种可能，都是"这一次先不提交"，但**界面要能说清是哪一种**：
       *    · 'not-joined' —— 服务端说认不出我，auth 已经把人送到加入页：
       *      关掉这一层、回 s3（他从加入页返回时看到的是录音预览，还能再点 ✓）；
       *    · 'unknown'    —— 没问到（断网）：留在 s3，给一句"检查网络、再点一次"。
       */
      this.setData({
        confirmOpen: false,
        ...phasePatch('s3'),
        error: auth === 'unknown' ? AUTH_RETRY_HINT : '',
      })
      this.syncEnergyNote()
      return
    }

    /**
     * ⭐ 权威余额从**刚写回 store 的那份 /me** 里读（auth 顺带做的事）——
     *    这里不再单独发一次请求：权威值的来源只有一个（服务端），拉法也只有一处（auth）。
     * ⚠️ 读不到就**当故障收手**，不能 `?? 0`：那会把"拿不到余额"显示成"余额 0"，
     *    于是用户看到一个假的「能量不够」并被引去买能量 —— 比报错更坏。
     */
    const balance = me.getState().userInfo?.energy
    if (typeof balance !== 'number') {
      this.setData({
        confirmOpen: false,
        ...phasePatch('s3'),
        error: '暂时取不到能量余额，检查网络后再点一次',
      })
      this.syncEnergyNote()
      return
    }

    // ⚠️ 够不够**不在这里判**：给 WXML 的是余额本身，比大小是模板里的事（两个数都来自服务端）
    this.setData({
      // 停在 s3 等用户决定：够 → 「确认提交」；不够 → 「去补能量」
      ...phasePatch('s3'),
      confirmEnergy: balance,
      // ⚠️ 顺手把权威余额写进页面那一格（底部那行小字当场跟着变，见 syncEnergyNote）
      energy: balance,
    })
    this.syncEnergyNote()
  },

  /**
   * ⭐ 确认层上那颗「确认提交」—— 到这里才真的开始上传 / 锁能量。
   *
   * ⚠️ 顺序：先关掉确认层、**再同步进 'uploading'**（同一个 setData 里做完）——
   *    两帧之间不能让用户看到"遮罩没了、页面回来了"那一瞬间的空档。
   * ⚠️ 确认弹窗里显示的那份余额是几分钟前问的（用户可能去充过值又回来）——
   *    真正的判断仍在服务端（ENERGY_EXHAUSTED 那条分支会把权威余额给回来）。
   */
  onConfirmStart() {
    if (this.data.phase !== 's3' || !this.data.confirmOpen) return
    this.setData({ confirmOpen: false })
    void this.startSubmit()
  },

  /** 确认层上那颗「取消」—— 什么都没发生：不锁能量、不上传，录音还在 */
  onConfirmCancel() {
    this.setData({ confirmOpen: false, ...phasePatch('s3') })
  },

  /** 确认层上那颗「去补能量」—— 这一层**不关**（回来接着确认），有余额了再点 ✓ */
  onConfirmGoEnergy() {
    openEnergyPage()
  },

  /**
   * ⭐⭐ 三份检查都过了 —— 真的开始提交（上传 → 受理 → 轮询）。
   *
   * ⚠️ 从这里开始能量就会被锁（服务端在受理时锁 2 点），所以它只能由
   *    onConfirmStart() 进来 —— 别的入口一律先走 onSubmit() 那三份检查。
   */
  async startSubmit() {
    const { audioPath, articleId } = this.data
    if (!audioPath) return

    this.setData({
      /**
       * ⭐⭐ 弹窗在这里**就打开了**（用户 2026-09：「在 s4 之前」）——
       *    点下 ✓ 的同一帧，整页被遮罩盖住：等待期禁止点击这条口径由浮层天然保证。
       * ⚠️ 'uploading' 与 'scoring' 是**弹窗自己的两个等待态**（原来的 s4 拆成了它们）：
       *    上传有真实百分比、打分只能转圈 —— 合成一个态会让"卡在 0%"和"卡在 99%"
       *    在屏幕上长得一模一样。页面状态机里它们仍然统称等待。
       */
      ...phasePatch('uploading'),
      error: '',
      uploadPercent: 0,
      restored: false,
      // ⚠️ 进等待态前先把播放停掉：录音还在响的话，那颗「试听」钮的状态会留在 playing
      replayState: 'unplay',
    })
    stopAudio()
    this.syncEnergyNote()

    try {
      /**
       * ⚠️⚠️ 用 `this.data.attemptId`（录音时生成的那个），**不要在这里 newAttemptId()**。
       *    重试路径（轮询失败 / 受理失败退回 s3，用户再点 ✓）会再次执行到这里 ——
       *    复用同一个键，服务端才能认出"这是刚才那一次"并返回同一个 submissionId。
       */
      const attemptId = this.data.attemptId || newAttemptId()
      if (!this.data.attemptId) {
        // ⚠️ 理论上不该发生（录音成功就生成了）。真发生了也必须**记住**这个补的值，
        //    否则这次提交后一重试又会换键 —— 静默多扣一次能量。
        console.warn('[reading] attemptId 缺失（录音恢复路径？），已临时补一个并记住')
        this.setData({ attemptId })
      }
      const { audioKey, audioUrl } = await uploadAudio(audioPath, {
        articleId,
        attemptId,
        onProgress: (p) => this.setData({ uploadPercent: p }),
      })
      // ⚠️ 上传完了就换「AI评测中」：不换的话进度条会停在 100%，而后面还有十几秒打分
      if (this.data.phase === 'uploading') this.setData({ ...phasePatch('scoring') })

      // ⭐ 只受理，不等打分（打分要 10–20 秒，见 lib/api/client.ts 的注释）
      // ⚠️ **不传日期**（2026-09 删）：归哪一天由服务端受理时取它的今天，端侧不碰这个决定。
      // ⚠️ 不传 isPublic —— 提交时**不问**用户，用服务端默认值（false）落库，
      //    结果页（pages/challenge）再给那个开关。
      const task = await submitReading(articleId, audioKey, audioUrl, false, attemptId)
      // ⭐ 记住它：弹窗里「评测详情」要靠它去 pages/challenge
      this.submissionId = task.submissionId
      // ⚠️ 受理阶段就被判失败（音频不合规 / 文章不存在）→ 直接进 s6
      if (task.status === 'failed') {
        this.toFail('')
        this.setData({ error: task.error ?? '' })
        return
      }
      // 幂等命中：这段音频早就打过分，结果直接就在包里
      // ⚠️ roll=true：用户刚点完提交、正盯着转圈 → 这就是「刚出分」那一刻
        /**
         * ⭐⭐ **立刻把"这一把正在进行"记到本地**（用户 2026-09 问的"中途退出怎么办"）。
         *
         * ⚠️⚠️ 为什么必须在这里写：原来只在**出分那一刻**（applyResult）才写缓存 ⇒
         *    用户在"检测中"退出再进来，本地没有任何线索 ⇒ 页面回到 s3 并请他再确认一次，
         *    而那一点 ✓ 就是**第二次提交**：新 attemptId、再扣一次能量、历史里多一条。
         *    写上这一条之后，再进来会拿这个 submissionId **接着等**（见 loadContent 的恢复分支）。
         * ⚠️ 它和"出分后的恢复"用的是**同一份缓存、同一个键**（句子 + 用户）——
         *    所以一句话最多一条记录，不会被提交次数撑大。
         */
        if (this.recordingKey) {
          saveLastResult(this.recordingKey, {
            submissionId: task.submissionId,
            articleId,
            at: Date.now(),
          })
        }
      if (task.status === 'scored' && task.result) {
        this.applyResult(task.result, true)
        return
      }
      await this.pollResult(task.submissionId)
    } catch (err) {
      const e = err as ApiError
      /**
       * ⚠️⚠️ 能量不够**不是错误，是业务规则**。
       *    所以提示语要说「接下来怎么办」，而不是「请求失败」——
       *    后者会让用户以为小程序坏了，然后反复重试（那正是要拦的行为）。
       *
       * ⚠️ 提示语里必须带上**明天**：这是他会再回来的唯一理由（每日补足到 3 点）。
       *    只说「能量不够」听着像封号，说「明天会补到 3 点」才是可预期的。
       * ⚠️ 服务端已经把余额放在 payload.energy 里，直接用它，不要在端侧自己减。
       */
      // ⚠️ 一律退回 s3：那段录音还在手上，用户点一下 ✓ 就能重试（不用重读一遍）
      if (e.code === 'ENERGY_EXHAUSTED') {
        const p = e.payload as { energy?: number } | undefined
        this.setData({
          ...phasePatch('s3'),
          error:
            '能量不够了（还差 ' + Math.max(0, ENERGY_PER_CHALLENGE - (p?.energy ?? 0)) +
            ' 点）—— 明天会补到 3 点，也可以充值',
        })
      } else {
        this.setData({ ...phasePatch('s3'), error: e.message })
      }
      this.syncEnergyNote()
    }
  },

  /**
   * ⭐ 轮询打分结果 —— 直到服务端给出终态（scored / failed）或**超时**。
   *
   * ⚠️⚠️ 服务端那条链路**刻意没有时长上限**（靠心跳判活，见 services/scoring.ts）：
   *    句子更长、引擎更慢，也不该撞上一个人为的上限 ——
   *    撞上去的表现是「用户永远拿不到分」，那是最糟的失败方式。
   *    ⚠️ 但产品上不能让用户对着转圈无限等（设计稿口径：等待期禁止点击，
   *      所以**只做超时兜底**、不做手工取消）。⇒ 客户端这一侧有个宽上限
   *      （SCORING_TIMEOUT_MS，2 分钟），到点进 s6，并且**明说**分数可能还在云端算。
   *
   * ⚠️ 每轮都检查 phase 与 gone：用户中途退出页面 / 状态已经变了就立刻停下，
   *    不能在后台一直空转轮询，更不能往已经销毁的页面上 setData。
   */
  async pollResult(submissionId: string) {
    this.submissionId = submissionId
    const startedAt = Date.now()
    // ⚠️ 连续失败计数 —— 它限制的是「轮询」这一侧，**不是打分**：
    //    网络断了不该让用户对着转圈无限等，但也不能因此丢掉云端的结果。
    //    所以放弃轮询时说清楚「成绩还在云端算，回首页能看到」，
    //    而不是模棱两可地报一句「失败」。
    let failedPolls = 0

    for (let round = 0; ; round++) {
      // 轮询节奏：前几轮密一点（好让大多数人在 1 秒内就感到「有反应」），
      // 之后放缓 —— 打分本身要十几秒，1 秒一次纯属白烧请求。
      const wait = round < 4 ? 1_000 : 2_500
      await new Promise((r) => setTimeout(r, wait))
      // ⚠️ 这里原来只判 phase；页面被销毁时 phase 不会变，于是轮询会继续往
      //    一个已经没了的页面上 setData（报错刷屏）。必须把 gone 也判上。
      // ⚠️ 判 'scoring'（不是原来的 's4'）：上传与打分现在是两个等待态，
      //    等待期间**只有 'scoring' 该继续轮询** —— 还在上传时不该问结果。
      if (this.gone || this.data.phase !== 'scoring') return

      // ⭐ 超时兜底（见本函数的说明）：到点就按失败处理，但**换一句副标题**
      if (Date.now() - startedAt > SCORING_TIMEOUT_MS) {
        this.toFail(TIMEOUT_HINT)
        return
      }

      let st
      try {
        st = await fetchSubmissionStatus(submissionId)
        failedPolls = 0
      } catch (err) {
        failedPolls++
        console.warn('[reading] 轮询失败 ' + failedPolls + ' 次：' + (err as Error).message)
        if (failedPolls >= 5) {
          // ⚠️ 退回 s3：录音还在手上，用户点一下 ✓ 就能重新提交（幂等，不会重复计费）
          this.setData({
            ...phasePatch('s3'),
            error: '网络不稳定，暂时取不到打分结果。分数仍在云端计算，回到首页就能看到。',
          })
          this.syncEnergyNote()
          return
        }
        continue
      }

      if (st.status === 'scored' && st.result) {
        // ⚠️ roll=true：轮询拿到分 = 刚出分（等待态 → s5），要播数字滚动
        this.applyResult(st.result, true)
        // ⭐ 这一句共攒了多少 —— 注意它**不含刚领取的这一把**（那时还没点那颗钮，
        //    账本里还没有这一笔；点完之后 dismissResult 会再拉一次历史，口径就对了）
        this.setData({ sentenceCookies: st.sentenceCookies ?? 0 })
        return
      }
      if (st.status === 'failed') {
        this.toFail('')
        this.setData({ error: st.error ?? '' })
        return
      }
    }
  },

  /**
   * ⭐ 等待态 → s6：评测失败（引擎判失败 / 受理就失败 / 客户端超时）。
   *
   * ⚠️ 弹窗**不关**：失败也是「这一把的结果」，用户要看着它、再决定重录还是走开
   *    （关掉它只发生在「确认」那一下，见 onConfirmResult）。
   *
   * @param detail 副标题。空串 = 用设计稿那句「录音不符合规范，无法检测发音」；
   *               **超时**时传一句真话进来（分数可能还在云端算）——
   *               那句设计稿文案只适用于「引擎说这段音频不行」，超时不是那个原因。
   */
  toFail(detail: string) {
    // ⚠️ 失败三张卡恒为 +0 且**不做数字滚动**（没有"涨"这回事）；
    //    万一上一轮的滚动还在跑（重新挑战后立刻又失败），必须停掉
    this.stopRoll()
    stopAudio()
    this.setData({
      ...phasePatch('s6'),
      failDetail: detail || '录音不符合规范，无法检测发音',
      scoreText: '',
      scoreSubtitle: '',
      // ⚠️ 失败态**整块不出现**（prd §7.6）：原来这里是三张恒为 +0 的灰卡，
      //    那是三次「你什么都没得到」的宣告。
      cookieLine: null,
      playingWord: -1,
      sentenceState: 'unplay',
      replayState: 'unplay',
    })
    this.syncEnergyNote()
  },

  /**
   * ⭐ 等待态 → s5：云端权威结果到手的这一刻。
   *
   * ⚠️ 顺序不能换：store 与刷新必须**先**做完 —— 用户可能立刻点「确认」或退出，
   *    那时再想补写就没有机会了（首页会一直停在旧数据上）。
   *
   * @param roll 要不要播「数字滚动」。**只有刚出分（等待态 → s5）才传 true**：
   *   两个调用点是「提交受理时幂等命中」与「轮询拿到 scored」。
   *   二次进入从本地缓存恢复出来的 s5 传 false —— 用户已经看过一次，
   *   再滚一遍只是拖慢他（见 onLoad 的恢复分支）。
   */
  applyResult(result: SubmitResponse, roll: boolean) {
    // ⭐⭐ 把结果写进全局 store —— **这一步就是「提交完返回首页会更新」的保证**。
    //     首页订阅着它，此刻数据已经是新的了，不用等 onShow、不用再刷新一次网络。
    //     ⚠️ 分数与 streak 全部用服务端给的，端侧一个数都不算。
    me.applySubmissionResult({
      // ⚠️⚠️ 键是**句子**（服务端回传的 articleId），不是日期。
      //    竞技数据跟着句子走 —— 同一句排在多天时，它们本来就是同一份战绩。
      //    用日期当键曾经导致「提交完参与状态不刷新」：客户端日期来自 URL、
      //    服务端来自自己的时钟，差一个字符就永远匹配不上。
      articleId: result.articleId,
      score: result.score,
      streak: result.streak,
    })

    // ⭐ 第三道保障：直接让上一页重新拉一次 —— 不看订阅、不看生命周期、不看时序
    refreshPreviousPage()

    /**
     * ⭐⭐ 把「这一把的结果」记到本地 —— 再进这一页时要能**恢复成 s5**。
     *    ⚠️ 只在成功态写（s6 不写：那段录音已经废了，恢复了也没意义）。
     *    ⚠️ 键用 recordingKey（句子 + 用户），一句话最多一条。
     */
    if (this.recordingKey && this.submissionId) {
      saveLastResult(this.recordingKey, {
        submissionId: this.submissionId,
        articleId: result.articleId,
        at: Date.now(),
      })
    }

    stopAudio()
    // ⚠️ 上一次的滚动可能还在跑（重新挑战后立刻又出分）—— 先停掉
    this.stopRoll()
    /**
     * ⭐⭐ 拿到分数 = 这段录音**已经被消费掉了**。
     *    ⚠️ 但**不在这里清缓存**：s5 上那颗「试听」播的就是本地这份文件，
     *       清早了按钮就点了没反应。真正的清理在 onUnload（见那里的说明）。
     */
    const cookie = cookieAwardOf(result)
    /**
     * ⭐⭐ 结果弹窗的两样新数据（用户 2026-10 定的那四种形态）。
     *
     * ⚠️ 形态文案由 `resultFormOf` 判（@jushuo/shared，有测试）——
     *    判据是**两个布尔**：这一把攻没攻克、之前攻克过没有。
     *    最容易错的是"已经攻克过的人"：那时"离 85 分还差多少"对他没有意义，
     *    目标该换成**刷新自己的记录**（否则一句话就把整套规则说穿了）。
     */
    const line = resultFormOf({
      score: result.score,
      /**
       * ⚠️⚠️ **"攻没攻克"只能用实际发了多少来判断** —— 即 `cookie.earned > 0`。
       *
       * ## 为什么不能用 `result.isConquered`（我现在踩了这个坑）
       *
       * 那个字段的名字**撒谎**：服务端给的是
       *     `isConquered: row.status === 'scored'`
       * —— 它的真实含义是「**这条提交打完分了**」（一个遗留名字，
       * 旁边注释还写着"不读老的 is_conquered 列"）。
       * ⇒ 拿它当"攻克"用，**只要出分就恒为 true** ✗
       * ⇒ 界面上就是：68.1 分（前高 82.6、攻克林 85）也显示「超越前高，+0 🍪」✗✗
       *
       * ⭐ `cookie.earned` 是 `computeCookies` 算出来的（那条规则唯一的实现），
       *    `earned > 0` 与 `score > max(85, 个人最好)` **严格等价** ✓
       * ⚠️ 拿不到奖励数据（cookie 为 null）时按"没攻克"处理 —— 宁可少说一次"攻克了"，
       *    也不能把没攻克的说成攻克了（那是把规则说穿了 ✗）
       */
      conquered: (cookie?.earned ?? 0) > 0,
      earned: cookie?.earned ?? 0,
      // ⚠️ 不传 passLine：那个值是 max(85, 前高)，拿它判"过没过线"会错（见 resultFormOf 的说明）
      previousBest: result.previousBest ?? null,
    })
    this.setData({
      ...phasePatch('s5'),
      resultLine: line,
      // ⚠️ 逐词用 lib/word-colors（与评测详情页**同一个函数**）——
      //    各写一遍的话，同一个词会在弹窗和详情页显示成两种颜色 ✗
      /**
       * ⭐ **结果里的逐词要和阅读时长得一模一样**（⭐ 用户 2026-10-09 明确要求 ✓）
       *    ⚠️ 字体 / 字号 / 间距 / 音标行全部对齐 ⇒ ⭐ 出分那一刻字不会"跳" ✓
       * ⚠️ 音标在这里合并：`renderWordColors` 只拿得到评分结果（⭐ 没有 ipa ✓），
       *    而 `this.data.words[i].ipa` 与它的下标**一一对应** ✓
       *    （⭐ 正文生成时就按同一套切词规则对齐了 ✓ 见 plainWords 的说明 ✓）
       */
      resultWords: renderWordColors(result.text ?? '', result.words ?? []).map((w, i) => ({
        ...w,
        ipa: this.data.words[i]?.ipa ?? '',
      })),
      error: '',
      // ⚠️ 先落**最终值**：数字滚动只是"盖在上面"的临时显示，
      //    任何一帧被打断（定时器被清）都不能让界面停在半路。
      scoreText: formatScore(result.score),
      scoreSubtitle: this.subtitleOf(result),
      attemptTitle: (result.attempts ?? 0) > 0 ? '第' + (result.attempts ?? 0) + '次朗读' : 'AI口语测评',
      cookieLine: cookieLineOf(cookie, result.score),
      failDetail: '',
      playingWord: -1,
      sentenceState: 'unplay',
      replayState: 'unplay',
    })
    /**
     * ⭐ 分数从 0 滚到最终分（只在这一把**刚出分**时演）。
     *
     * ⚠️ 原来这里靠 setData 回调先摆一帧"透明 + 下移"的卡片再置 cardsIn ——
     *    卡片搬进弹窗之后，弹窗自己有一次进出场过渡（见 eval-dialog 的 entered），
     *    再给卡片加一层淡入是两次动画叠在一起，所以那一套整个删了。
     */
    if (roll) this.rollNumbers(result.score, cookie)
    this.syncEnergyNote()
    /**
     * ⭐⭐ 出了分 = 这一句的历史多了一条 —— 立刻重拉。
     *
     * ⚠️⚠️ 必须在这里拉，不能只靠 onShow：用户在评测中等到出分、**从没离开过这一页**，
     *    不拉的话下方那段历史会一直停在"进页面时"的样子 ——
     *    刚读完这一次却在历史里找不到它，看起来就像记录丢了。
     * ⚠️ 这一条**不会出现在列表里**（submissionId 正是要免掉的那一个，见 loadHistory）——
     *    大号分数就在上面，下面再列一遍等于把同一次说了两遍。
     *    它要的效果是：历史的**表头计数与最高分**跟着这次成绩更新。
     */
    void this.loadHistory()
  },

  /**
   * ⭐ s5 的数字滚动：大分数从 0 滚到最终分，三张卡的 +N 从 0 滚到最终值。
   *
   * ⚠️ 缓出（ease-out cubic）：开头快、结尾慢 —— 用户对"最后停在哪个数"最敏感，
   *    匀速滚到底会显得很赶。
   * ⚠️⚠️ 末帧**无条件写精确值**，不能用缓动函数算出来的近似值：
   *    四舍五入会让 89.46 停在 89.4，而服务端给的是 89.5 ——
   *    "动画结束时差 0.1"是最不该有的错。
   * ⚠️ 分数一位小数（走 formatScore 的统一口径）、饼干取整（Math.round）。
   *
   * @param score  最终分（0–100，一位小数）
   * @param cookie 这一把的饼干快照；null = 服务端还没给，那就只滚分数
   */
  rollNumbers(score: number, cookie: CookieAwardView | null) {
    this.stopRoll()
    const startedAt = Date.now()
    this.rollTimer = setInterval(() => {
      // ⚠️ gone 判活：页面销毁后一帧都不能再写（见 onUnload）——
      //    定时器与 onUnload 之间总有几十毫秒的窗口
      if (this.gone) {
        this.stopRoll()
        return
      }
      const t = Math.min(1, (Date.now() - startedAt) / ROLL_MS)
      const k = 1 - Math.pow(1 - t, 3)
      const done = t >= 1
      this.setData({
        scoreText: done ? formatScore(score) : formatScore(score * k),
        ...(cookie
          ? {
              // ⚠️ 只滚"拿到了多少"；没攻克那一档是文字（"还差 X 分"），不参与滚动
              cookieLine: cookieLineOf(
                done ? cookie : { ...cookie, earned: Math.round(cookie.earned * k) },
                score,
              ),
            }
          : {}),
      })
      if (done) this.stopRoll()
    }, ROLL_FRAME_MS)
  },

  /**
   * 停掉数字滚动的定时器。
   * ⚠️ 三个入口都要停：页面销毁（onUnload）/ 重新挑战（onRestart）/ 失败（toFail）——
   *    否则它会在已经换了状态的界面上继续写 scoreText。
   */
  stopRoll() {
    if (this.rollTimer !== null) {
      clearInterval(this.rollTimer)
      this.rollTimer = null
    }
  },

  /**
   * ⭐ 成功态副标题：首次挑战，打败5人，位列第5 / 第3次挑战，打败5人，位列第5。
   *
   * ⚠️ 首次的判据是 **previousBest === null**（服务端给的上一次成绩）——
   *    它比「端侧算第几次」可靠得多，SPEC 里也是这么定的。
   * ⚠️ 第 K 次的 K **直接读服务端给的 attempts**（服务端按行序现算，库里没有这一列），
   *    不再从 store 的缓存里猜：那个缓存里没有这句的旧战绩时会猜成第 1 次，
   *    与「不是首次」自相矛盾，于是上一版只能夹一个下限 2 —— 拿一个谎补另一个谎。
   *    ⚠️ attempts 只数**有结论**的行（含引擎判无效那些），与「我在这句打过几次分」
   *      不是同一个数；这里要的正是「第几次挑战」。
   */
  beatClauseOf(result: SubmitResponse): string {
    /**
     * ⚠️⚠️ 分母是**除我之外**的参赛者（participantCount - 1）：
     *    「对手」不该包含我自己 —— 拿 participantCount 当分母，
     *    一个人参赛时会显示「击败 0% 的对手」，而场上其实一个对手都没有。
     * ⚠️ 只有我一个（participantCount <= 1）⇒ 这一小段**整个不出现**
     *    （而不是显示 100% 或 0%：那两种都是在编一个不存在的对手）。
     * ⚠️ 取整用 Math.round：「击败 79%」比「78.94736842%」可读。
     */
    const opponents = result.participantCount - 1
    if (opponents <= 0) return ''
    return '击败' + Math.round((result.beatenCount * 100) / opponents) + '%的对手，'
  },

  subtitleOf(result: SubmitResponse): string {
    /**
     * ⭐ s5 的副标题（用户 2026-09 定的三档口径）：
     *   ① 首次出分      ：首次挑战，击败N%的对手，位列第N
     *   ② 非首次且破纪录：突破最高分N，击败N%的对手，位列第N
     *   ③ 非首次未破纪录：未突破最高分N，目前位列第N
     *
     * ⚠️ 两处口子的 N 都是**你此前的最高分**（previousBest = 排除这一把的最好成绩，
     *    见 services/submission-view.ts 的 getBestExcluding）：
     *      · 破了 → 那是**被破掉的那个旧纪录**（「突破最高分88.5」）
     *      · 没破 → 那是**你还没够到的那个分**（「未突破最高分91.0」）
     *    新分数不在这里说 —— 它就在上面那个大号数字上，重复一遍是噪声。
     * ⚠️ 「首次」的判据仍是 previousBest === null（SPEC 定的）：
     *    它说的是"这句上第一次出分"，比"第几次提交"更贴近用户的理解。
     * ⚠️ ③ 里**没有**击败百分比那一段（用户口径如此）：既然没破纪录，
     *    再说击败了多少人只是安慰，不如直说现在第几。
     */
    const beat = this.beatClauseOf(result)
    if (result.previousBest === null) {
      return '首次挑战，' + beat + '位列第' + result.rank
    }
    if (result.isPersonalBest) {
      return '突破最高分' + formatScore(result.previousBest) + '，' + beat + '位列第' + result.rank
    }
    return '未突破最高分' + formatScore(result.previousBest) + '，目前位列第' + result.rank
  },

  /**
   * 「评测详情」—— 详细结果在 pages/challenge（五个分项 / 逐词上色 / 榜单 / 分享）。
   *
   * ⚠️⚠️ 用 **navigateTo**（不是原来那个 redirectTo）：用户 2026-09 定的出口是
   *    弹窗底部那两个按钮，而用户看完详情按返回时，应该回到**还开着的结果弹窗**上 ——
   *    再点「确认」才收工。从详情返回直接掉回首页会让他以为那次成绩没了。
   * ⚠️ 这一页**保留**（SPEC 已定口径）：弹窗里只放摘要。
   */
  onOpenDetail() {
    openChallengePage(this.submissionId)
  },

  /**
   * ⭐⭐ 弹窗底部的「确认」——**结果态的唯一出口**（用户 2026-09 定）。
   *
   * 一次动作做三件事，顺序不能换：
   *   ① 清掉这一把的缓存 —— 不然下次进这一句又会被恢复成 s5（见 clearAttempt）；
   *   ② 忘掉这一把的提交 id —— 它已经出分、已经落库，**本来就是历史了**，
   *      再免着它就会出现「我刚打的分从历史里消失了」（见 loadHistory 的口径）；
   *   ③ 重拉历史 —— 让它**立刻**出现在下面那段里：用户点「确认」时最想确认的
   *      就是"这次算数了"，而列表里多出来的那一条就是最好的证据。
   *
   * ⚠️ 关窗 = 页面回 s1（那张卡重新可录），**不是**回首页：用户多半还想再读一遍
   *    （「重新挑战」这个动作就并进了确认 —— 反正弹窗关掉之后卡片本来就是 s1）。
   */
  /**
   * ⭐⭐ **「重新挑战」**（用户 2026-10 定：结果并进卡片之后，这是它唯一的出口）。
   *
   * 点一下做完三件事：
   *   ① **领取这一把的饼干**（饼干改成"点开结果才入账"，见 claimCookiesIfAny）
   *   ② 清掉这一把 + 把卡片复位到 s1（可以立刻再录一遍）
   *   ③ **刷新历史** —— 让刚才这一把作为一条新的历史出现在下面
   *
   * ⚠️ 按钮文案**统一**叫「重新挑战」，结论（六种口径之一）放在它下面一行 ——
   *    按钮说"点它会怎样"，结论说"刚才怎么样"，两件事不塞进同一颗按钮 ✗
   */
  onRetryChallenge() {
    void this.dismissResult()
    void this.loadHistory()
  },

  /**
   * ⭐⭐ **"结果被收起来"的唯一出口**（用户 2026-10 定）——
   *    领取这一把的饼干 + 清掉这一把的本地缓存。
   *
   * ⚠️⚠️ 饼干改成"点开结果才入账"，所以**每一个**离开结果态的入口都要经过这里：
   *    ① 用户点结果弹窗那颗状态胶囊（onConfirmResult）
   *    ② 用户**直接开始下一次录音**（startRecording 里清结果缓存那一处）
   *    只在①发的话，走②的人**永远拿不到** ✗ —— 他确实攻克了、规则也判了，
   *    只是没点那颗钮；而缓存一清，端侧再没有任何指针指向那条提交。
   *
   * ⚠️ 领取**失败不阻断**：饼干没领到是可惜，但"关不掉结果窗"是坏掉 ✗
   *    ⇒ 只记日志、照常往下走。服务端是幂等的，下次进这一页的恢复路径还会再试 ✓
   * ⚠️ 只在**出分**时领（失败态没有饼干；scoring 时 cookies_earned 还是 null）。
   */
  async dismissResult() {
    await this.claimCookiesIfAny()
    this.submissionId = ''
    /**
     * ⭐⭐ **清掉"排除本次"之后，必须重拉一次历史** ✗✗（⭐ 用户 2026-10-09 报的 ✓）
     *
     * ⚠️⚠️ 这里原来**漏了这一行** ✗ —— 而上面（轮询出分那处）的注释
     *    **亲口写着「点完之后 dismissResult 会再拉一次历史，口径就对了」** ✓
     *    ⇒ ⭐ 注释描述了一个不存在的行为 ✓
     *    ⇒ ⚠️ 症状：⭐ `loadHistory` 拿 `this.submissionId` 去**排除刚出的那一把** ✓
     *      （⭐ 设计意图：弹窗正盖着它，列表里再来一条是重复 ✓）
     *      而关掉弹窗时**只清了那个 id、没重拉** ✗
     *      ⇒ ⭐ **刚打完的那一把永远不出现在「历史挑战」里** ✗✓
     *
     * ⚠️ 位置：⭐ 在 `clearAttempt()` **之前** ✓ ——
     *    那个方法在检测中有守卫（⭐ 会直接 return ✓），放后面可能被它挡掉 ✓
     * ⚠️ 不 await：⭐ 它供的是下面那张历史卡 ✓ 不该拖住"关窗"这个动作 ✓
     */
    void this.loadHistory()
    this.clearAttempt()
  },

  /**
   * ⭐ 只领、不清 —— 给"开始下一次录音"那条路用。
   *
   * ⚠️ 与 dismissResult 分开是有意的：那条路**还要接着走录音流程**，
   *    清缓存是它自己那一行的事。把清理写两遍，迟早两处不一致 ✗
   */
  async claimCookiesIfAny() {
    const sid = this.submissionId
    if (!sid || this.data.phase !== 's5') return
    try {
      const r = await claimCookies(sid)
      // ⚠️ 余额用**服务端返回的**，不在端侧自己加（那是第二份真相）
      me.applyCookieBalance(r.cookies.balance)
      /**
       * ⭐ "这一句共攒了多少"要**补上刚领的这一把**。
       *
       * ⚠️ 轮询那时算的总数里**没有**这一笔（领取发生在它之后）——
       *    不补的话，用户点完那颗钮会发现总数**没变** ✗
       *    （而它明明刚刚到账）。补 `claimed` 比再发一次请求省，也不会闪 ✓
       */
      if (r.claimed > 0) {
        this.setData({ sentenceCookies: (this.data.sentenceCookies ?? 0) + r.claimed })
      }
    } catch (err) {
      console.warn('[reading] 领取饼干失败（不阻断）：' + (err as Error).message)
    }
  },

  /**
   * 「重录」（s3 的 ↺）—— **清缓存回 s1**，这一段不要了从头来。
   *
   * ⚠️ 它和 onConfirmResult 是**两件事**，别合并：
   *    · 重录 = 结果还没出来（s3 预览里不满意），那一次的提交 id 还不存在；
   *    · 确认 = 结果已经出来了，要顺带把它送进历史。
   *    ⚠️ 但两者**清缓存 + 复位界面**的那一半完全一样 ⇒ 共用 clearAttempt()，
   *      免得将来只改了其中一处（"重录之后又恢复成 s3"那个坑就是这么来的）。
   */
  /**
   * ⭐⭐ **清掉词上的全部预检标记** —— 「新的一遍开始」时唯一的出口。
   *
   * ⚠️⚠️ 为什么必须抽成一个方法：这个 bug **犯过两次** ——
   *    第一次是"重录之后颜色没清"，第二次是加了 `misread`（黄标）之后
   *    **只清了 `missed`、漏了新状态**，于是点「重新朗读」黄标还挂在句子上。
   *    每次加一个标记状态，都要去四五个地方各补一行 —— 漏一个就复现。
   *    ⇒ 收敛成这里一处：**以后再加状态，只需要改这一行**。
   *
   * ⚠️ 已经干净就不 setData：这个方法会在"起录"这种高频路径上被调，
   *    没必要为一个必然相同的值触发一次渲染。
   */
  clearWordMarks() {
    const words = this.data.words
    if (!words.some((w) => w.missed || w.misread)) return
    this.setData({ words: words.map((w) => ({ ...w, missed: false, misread: false })) })
  },

  /**
   * ⭐⭐ **算出提交按钮下面那句话** —— 唯一的出口。
   *
   * ⚠️⚠️ 为什么必须只有一处：判据来自三个数（漏读几个 / 读错几个 / 是不是偏慢），
   *    而"这一次的结论变了"有好几个时刻（定稿、缓存恢复）。
   *    分开各算一份，就会出现「提示说没事、门禁却拦着」这种自相矛盾。
   *
   * @param recordMs 这一次录音的时长（"按下到松手"，见 lib/submit-hint.ts 的说明）
   */
  syncSubmitHint(recordMs: number) {
    const hint = submitHintOf({
      missed: this.missedIdx.length,
      misread: this.misreadList.length,
      slow: isSlowReading(recordMs, this.data.stdDurationMs),
    })
    /**
     * ⚠️ 三样**一起更新**（文案 / 颜色档 / 按钮可用性）——它们同源，分开更就会出现
     *    "文字说请重新朗读、按钮却能按"这种自相矛盾。
     */
    const canSubmit = hint.level !== 'block'
    if (hint.text !== this.data.hintText || hint.level !== this.data.hintLevel || canSubmit !== this.data.canSubmit) {
      this.setData({ hintText: hint.text, hintLevel: hint.level, canSubmit })
    }
  },

  onRestart() {
    /**
     * ⭐ **「嗖」** —— S3「重录」（那个 ↺）的听觉回应（⭐ 用户 2026-10-09 要的 ✓）
     *
     * ⚠️⚠️ **这里是 S3 真正的重试按钮** ✗ —— 我第一版挂错了地方 ✓：
     *    ⚠️ 挂到了 `onRetryChallenge`（⭐ 「重新挑战」那颗胶囊 ✓）——
     *       而它在 `<block wx:if="{{phase === 's5' || phase === 's6'}}">` 里 ✗
     *       ⇒ ⭐ **只在出分态出现，根本不在 S3** ✗✓（⭐ 用户当场指出 ✓）
     *    ⭐ S3 的可点按钮只有三个：⭐ `onRestart`（↺ 重录 ✓）·
     *       `onReplay`（试听 ✓）· `onSubmit`（提交 ✓）—— 重试 = 第一个 ✓
     *
     * ⚠️ 下滑扫频 = "清掉、重来" ✓ —— ⚠️ 与「嘟」（开始）「叮」（结束）区分得开 ✓
     * ⚠️ 放在**最前面**：⭐ 让反馈和手指抬起同一瞬发生 ✓
     * ⚠️ 全链路 try/catch 在 playCue 内部 ✓：音效失败绝不影响重录 ✓
     */
    playWhoosh()
    /**
     * ⭐⭐ **重录 = 上一把就此定案，它该进历史了** ✗✗（⭐ 用户 2026-10-09 报的 ✓）
     *
     * ⚠️⚠️ 这里原来只有 `clearAttempt()` ✗ —— 而 `clearAttempt` 只管**本地缓存**
     *    （⭐ 录音 + 结果 ✓），**不碰 `submissionId`** ✓
     *    ⇒ ⚠️ 于是 `loadHistory` 里"**排除刚出的那一把**"的条件一直生效 ✗
     *      （⭐ 那个排除的本意是：弹窗正盖着它，列表里再来一条是重复 ✓）
     *    ⇒ ⭐ **用户点 ↺ 重录之后，刚才那一把永远不出现在「历史挑战」里** ✗✓
     *
     * ⭐ 所以这里要做和 `dismissResult` 一样的两步：⭐ **清 id + 重拉** ✓
     *    （⭐ 语义上完全一样：⭐ 上一把结束了 ⇒ 它不再是"当前这一把"✓）
     *
     * ⚠️ 位置：⭐ 在 `clearAttempt()` **之前** ✓ ——
     *    那个方法在检测中有守卫会直接 return（⭐ 见它的注释 ✓），放后面可能被挡掉 ✓
     * ⚠️ 不 await：⭐ 它供的是下面那张历史卡 ✓ 不该拖住"重录"这个动作 ✓
     */
    this.submissionId = ''
    void this.loadHistory()
    this.clearAttempt()
  },


  /**
   * ⭐ 清掉「这一把」的本地缓存并把界面复位到 s1。
   *
   * ⚠️ 必须**一起清掉录音与结果两份缓存**：
   *    · 录音不清 —— 下次再进这一页又会被恢复成 s3，点「重录」等于没点；
   *    · 结果不清 —— 下次进来被恢复成 s5，「确认」等于没点（同一个坑的另一半）。
   * ⚠️ 只清**这一句**的槽位：别的句子的录音不该被连坐。
   */
  clearAttempt() {
    /**
     * ⚠️⚠️ **检测中绝不允许重录**（用户 2026-10 定的新流程带来的新风险）。
     *
     * 原来这里不需要守卫：检测期间 `phase` 不是 's3' ⇒ 卡片整排钮**压根没渲染**。
     * ⭐ 而新流程要求确认之后**卡片留在 s3**（靠钮的样子表达"正在检测"）⇒
     *    这颗 ↺ 从此**有机会被按到**。
     *
     * 按下去的后果：本地缓存（录音 + 结果）被清掉，而**服务端那一笔照旧在跑** ——
     *    ⇒ 它出分时端侧已经没有任何指针指向它，结果被**孤立**；
     *    ⇒ 用户还会以为"我取消了"，但能量已经扣了、历史里也多了一条。
     *
     * ⚠️ UI 上这颗钮同时是 disabled 的（见 wxml 的 detecting），但**两处都要有**：
     *    光靠 disabled 挡不住别的入口调这个方法（将来可能还有）。
     */
    /**
     * ⚠️⚠️ **判据是 `detecting`，不是 `phase !== 's3'`**（2026-10 修，用户报的"点胶囊关不掉弹窗"）。
     *
     * 这一行的**本意**只有一句：**检测中不许重录** ✗
     * 而结果态（s5）的 `dismissResult()` **也走这个方法**来关窗 + 复位界面的 ——
     * 写成"非 s3 一律拦"就把结果态一起挡了 ✗
     * 症状：点那颗黄色胶囊**什么都不发生**（弹窗还在、页面也没刷新）✓
     *
     * ⭐ `detecting` 只在 uploading / scoring 时为真（由 phasePatch 与 phase 一起写）——
     *    那正是"这一把在跑、绝不能重录"的唯一时段 ✓
     */
    if (this.data.detecting) return
    // ⚠️ 先停数字滚动：不停的话它会继续往 s1 的界面上写 scoreText（见 rollNumbers）
    this.stopRoll()
    if (this.recordingKey) clearLastRecording(this.recordingKey)
    if (this.recordingKey) clearLastResult(this.recordingKey)
    /**
     * ⚠️⚠️ **把上一遍的预检标记清掉** —— 不清的话，"重录"回到 s1 之后，
     *    上一遍那些黄标 / 灰标还挂在句子上，看起来像"这一遍也已经判过了"。
     *    而这些标记说的是**上一次**那一遍，属于同一种"第二份真相"。
     * ⚠️ 清法只有一处（clearWordMarks）—— 漏掉某个状态的 bug 犯过两次。
     */
    this.missedIdx = []
    this.misreadList = []
    /**
     * ⚠️ 收尾状态也要一起复位（这两个都是"这一次录音"的状态）：
     *    漏了 `releasePending` 的话，回 s1 之后按钮会**停在「识别中…」且 disabled** ——
     *    用户再也按不动那颗钮，而界面上没有任何解释。
     */
    this.releasePending = false
    this.stopSent = false
    this.clearWordMarks()
    this.setData({
      // ⚠️ 提示也要清：这一遍还没判过，不能挂着上一遍那句
      hintText: '',
      hintLevel: 'ok',
      canSubmit: true,
      releasePending: false,
      ...phasePatch('s1'),
      error: '',
      restored: false,
      audioPath: '',
      // ⚠️ 整页重来 = 上一次尝试作废（完整说明见构造函数里 attemptId 那段）
      attemptId: '',
      playPath: '',
      durationMs: 0,
      recordDurationText: '',
      elapsedText: '00:00',
      uploadPercent: 0,
      scoreText: '',
      scoreSubtitle: '',
      attemptTitle: '',
      cookieLine: null,
      failDetail: '',
      playingWord: -1,
      sentenceState: 'unplay',
      replayState: 'unplay',
    })
    stopAudio()
    this.syncEnergyNote()
  },

  // ----------------------------------------------------------------
  // 工具
  // ----------------------------------------------------------------
  /** 录音授权：第一次会弹窗，拒绝后只能引导去设置页 */
  ensureRecordAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.record']) return resolve(true)
          wx.authorize({
            scope: 'scope.record',
            success: () => resolve(true),
            fail: () => resolve(false),
          })
        },
        fail: () => resolve(false),
      })
    })
  },
})

/**
 * ⭐ 从内容接口的 audio 上读**标准音时长**（毫秒）。
 *
 * ⚠️ 现在详情接口的 audio 就是 shared 的 **StandardAudio**（= AudioRef + durationMs）——
 *    与列表接口同一套（服务端走同一个 standardAudioOf）。所以顶行那个 `00:23` 有值了。
 * ⚠️ 仍然按**可选**读，且 <= 0 / NaN 一律当"没有"：
 *    · 老服务端（没带这个字段）；
 *    · 音频文件缺失 / MP3 解析不出时长（服务端会老实给 null）。
 *    ⇒ 这时**不渲染那几个字**（见 WXML），而不是显示 00:00 —— 那看着像音频坏了。
 * ⚠️ 不要用别的办法估：InnerAudioContext 的时长要等音频真的加载完才知道，
 *    为了几个字去建一个播放器实例，代价比收益大得多（还可能被音频池限制）。
 */
function readStdDurationMs(audio: { full: string; kind: 'cloud' | 'http'; durationMs?: number | null } | null): number {
  if (!audio) return 0
  const ms = audio.durationMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
}

/**
 * ⭐ 从提交结果里读「这一把的饼干快照」。
 *
 * ⚠️ 字段就是 shared 的 `SubmitResponse.cookies`（形状 CookieAwardView），
 *    由服务端 services/submission-view.ts 从 submissions 的快照列读出来 ——
 *    端侧读的字段名与服务端给的是同一个，不再有第二套。
 * ⚠️ 它是**可选**的：结算与「status 置为 scored」不在同一个事务里，轮询可能卡在中间；
 *    老数据也可能没结算过 ⇒ null，端侧整块不渲染（见 cookieLineOf）。
 */
function cookieAwardOf(result: SubmitResponse): CookieAwardView | null {
  return result.cookies ?? null
}
