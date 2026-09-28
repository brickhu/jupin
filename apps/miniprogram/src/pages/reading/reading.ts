import {
  ENERGY_PER_CHALLENGE,
  PREFLIGHT,
  RECORD_SPEC,
  formatDuration,
  formatScore,
  peakBars,
  samplesFromPcm16,
  sniffAudioContainer,
  today,
} from '@jushuo/shared'
import { plainWordsOf } from '@jushuo/shared'
import type { GrowthView, SubmitResponse } from '@jushuo/shared'

import { PLATFORM } from '../../config'
import {
  ApiError,
  fetchArticleRecords,
  fetchSubmissionStatus,
  getUserId,
  submitReading,
} from '../../lib/api/client'
import { historyRowsOf, type HistoryRow } from '../../lib/article-history'
import { uploadAudio } from '../../lib/api/upload'
import { decodeFrameToSamples } from '../../lib/audio/frame-decode'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { speak } from '../../lib/audio/tts'
import { Recorder, type RecordResult } from '../../lib/audio/recorder'
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
import { AUTH_RETRY_HINT, ensureAuthed, isAuthed } from '../../lib/auth'
import { openEnergyPage } from '../../lib/challenges'
import { clearLastResult, loadLastResult, saveLastResult } from '../../lib/audio/last-result'
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
 * ⭐ 三张成长值卡 —— **命名以代码为准**：自我超越 / 坚持不懈 / 人中翘楚。
 *
 * ⚠️⚠️ 设计稿上写的是「自我挑战」「鹤立鸡群」，**不采纳**（用户 2026-09：以代码为主）。
 *    全站（首页三块成长榜、个人主页、接口类型 GrowthView）都是这一套名字，
 *    照稿子改文案会让同一个人在两屏里有两个名字。
 *
 * ⚠️ 颜色跟着**指标**走而不是跟着位置走：自我超越橙 / 坚持不懈绿 / 人中翘楚紫 ——
 *    设计稿把绿的那张放在最后，但绿的是「坚持不懈」，位置换了颜色不换。
 */
const GROWTH_META = [
  { key: 'self', label: '自我超越', textCls: 'text-orange-500', borderCls: 'border-orange-400' },
  { key: 'diligence', label: '坚持不懈', textCls: 'text-ok', borderCls: 'border-ok' },
  { key: 'standout', label: '人中翘楚', textCls: 'text-purple-500', borderCls: 'border-purple-400' },
] as const

interface GrowthCard {
  key: string
  label: string
  /** 展示文本（带 + 号） */
  value: string
  textCls: string
  borderCls: string
}

/**
 * ⭐ 拿「这一把加了多少」的三张卡。
 *
 * ⚠️ 数据来自服务端刚下发的 SubmitResponse.growth（submissions.growth_* 的快照）。
 *    拿不到时（结算与「status 置为 scored」之间的窗口 / 老数据）返回空数组 ⇒
 *    **整块不渲染**，而不是摆三个 +0 —— +0 会被读成「这一把没涨」，
 *    而真相是「还没结算」。
 *
 * ⚠️ 不要拿 /me 里那个**累计值**顶上去：卡片上的 +5 是「这一把加了多少」，
 *    累计值放上去会是 +128 这种数 —— 差得不是一点，用户会以为刚才这一把加了 128。
 */
function growthCardsOf(delta: Partial<GrowthView> | null): GrowthCard[] {
  if (!delta) return []
  return GROWTH_META.map((m) => ({
    key: m.key,
    label: m.label,
    value: '+' + Math.max(0, Number(delta[m.key] ?? 0)),
    textCls: m.textCls,
    borderCls: m.borderCls,
  }))
}

/**
 * ⭐ 失败态的三张卡 —— **恒为 +0（灰）**。
 *
 * ⚠️ 与 s5 的「拿不到就不渲染」不同：这里的值不需要服务端给，它**就是 0**
 *    （评测失败不扣能量、也不加成长值，服务端会把受理时锁的 2 点释放掉）。
 */
function zeroGrowthCards(): GrowthCard[] {
  return GROWTH_META.map((m) => ({
    key: m.key,
    label: m.label,
    value: '+0',
    textCls: 'text-faint',
    borderCls: 'border-gray-300',
  }))
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

/**
 * ⭐ 声波监测：**以中线对称的实心柱条**，画在 canvas 上。
 *
 * ⚠️ 为什么是 canvas 而不是一排 <view>：
 *    一帧 1024 个采样点，用节点画就是 1024 个节点 × 每秒 15 帧 —— 小程序扛不住，
 *    而且柱条会糊成一条实心色块。canvas 一次 draw 搞定，且能按设备像素画，边缘不发虚。
 *
 * ⚠️ 小程序的 canvas 2d **没有 AnalyserNode**（那是浏览器 Web Audio 的东西，
 *    参见 docs/research/platform-decision.md），所以波形只能从录音帧自己算 ——
 *    数据源是 Recorder 交上来的 PCM 帧（已归一化到 16kHz 小端）。
 */
/** canvas 的 id —— 只在 s2 那一块里存在（wx:if） */
const WAVE_CANVAS_ID = '#wave'
/**
 * 一屏最多画多少根柱条。
 *
 * ⚠️ 不是"越多越准"：柱条数超过画布物理像素的一半之后，相邻柱条之间的空隙
 *    就没有渲染意义了（会糊成实心块），白白多画一倍 rect。
 *    64 根 ≈ 每个柱子覆盖 16 个采样点，肉眼刚好能看出"起伏"。
 * ⚠️ 取的是**峰值**而不是均值：均值会把一帧里的爆破音抹平，
 *    看起来像音量一直很小 —— 而用户盯着这条波形就是要看"我声音够不够大"。
 */
const WAVE_MAX_BARS = 64

/**
 * ⭐ 连续解码失败几次才认定「这个环境解不开帧」。
 *
 * ⚠️ 不能一帧失败就下结论：帧是**流**，某一帧恰好在编码边界上解不开是正常的。
 *    取 3：既有容错，又不会让开发者工具里白等太久（每帧还带 1.5 秒超时）。
 */
const FRAME_DECODE_TRIES = 3
/** 柱条填充色 —— 与 uno.config.mjs 的 theme.colors.brand 保持一致（手写 CSS 取不到那个 token） */
const WAVE_COLOR = '#4f46e5'

/**
 * ⚠️⚠️ 这一帧里装的是**采样**（能画波形），还是**编码后的码流**（画不了）？
 *
 *    ⭐ 判据直接复用 @jushuo/shared 的 `sniffAudioContainer` —— **服务端解码前
 *    用的是同一个函数**。两端各写一份的话，会出现「服务端解得开、客户端却认定
 *    它不能画」这种谁也说不清的状态。
 *
 *    ⚠️ 为什么非要认这一步：`frameBuffer` 官方只写了「录音分片数据」四个字，
 *       而本项目**实测**同一个 API 会给两种完全不同的东西 ——
 *       真机（format:'PCM'）是裸 PCM，开发者工具是 WebM/Opus 压缩块
 *       （见 docs/research/recorder-output-formats.md）。
 *       把压缩字节按 16bit PCM 读，得到的是「接近满量程的噪声」（RMS ≈ -4.8dB）——
 *       每根柱子都被拉满、一动不动，用户看到的就是一整条不响应的色块。
 *
 *    ⚠️ `raw-pcm` 是**兜底**值（裸 PCM 没有任何 magic）：判不出来是正常的，
 *       那正是真机的情况 —— 照画。
 */
function framesAreSamples(pcm: ArrayBuffer): boolean {
  return sniffAudioContainer(new Uint8Array(pcm)) === 'raw-pcm'
}

/** 只在开发者工具里为真 */
const IS_DEVTOOLS = PLATFORM === 'devtools'

/**
 * ⭐ **实时波形有没有数据源** —— 由录音格式决定（见 RECORD_SPEC）。
 *
 * ⚠️ `onFrameRecorded` 只在 `format` 是 **mp3 / pcm** 时才回调（官方文档）：
 *    选 mp3 就是为了「压缩」和「有帧」两个都要 —— 见 RECORD_SPEC 里那张对照表。
 *
 * ⚠️ 它只是**初始值**：真机上一旦发现帧其实是压缩块（不是 PCM），
 *    会当场把 waveOn 置 false（见 handleFrame 的三种结局）—— 宁可没有波形，
 *    也不能拿压缩字节当振幅画一条骗人的柱子。
 */
const WAVE_ON = RECORD_SPEC.frames

/** 逐词视图 —— 词 + 它自己的音标（音标开关打开时挂在词下面） */
interface WordView {
  /** 稳定的 key（同一个词可能出现多次，不能用 text 当 key） */
  i: number
  text: string
  /**
   * ⭐ 这个词的国际音标（来自正文 JSON 的 words[i].ipa，形如 /ˈɛvɹiˌθɪŋ/）。
   * ⚠️ 查不到时是空串（老正文 / 生僻词）—— 那时**不渲染**这一行，不占位。
   */
  ipa: string
}

Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    articleId: '',
    /** 六态 + 一个「句子还没拉到」的前置态，见文件头的状态机说明 */
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

    /** 整句标准音（fileID 或服务端路径，由 audioKind 决定怎么解释） */
    fullAudio: '',
    /** 'cloud' | 'http' —— 见 shared 的 AudioRef */
    audioKind: 'http' as 'cloud' | 'http',
    /** 标准音时长（毫秒）—— 拿不到就是 0，见 stdDurationText 的说明 */
    stdDurationMs: 0,
    /**
     * ⭐ 顶行标准音那颗圆钮右边的 `00:23`。
     *
     * ⚠️ 数据来自详情接口的 audio.durationMs（= shared 的 ScheduleAudio，
     *    服务端用同一个 scheduleAudioOf 拼，与列表接口同源）。
     *    拿不到（老服务端 / 文件缺失 / 解析失败）就是空串，WXML 据此**不渲染那几个字** ——
     *    不是显示 00:00（那看着像音频坏了）。
     */
    stdDurationText: '',

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
    /** 老版本留下的「帧拼 WAV」副本 —— **试听兜底用**（新录音恒为空串） */
    playPath: '',
    durationMs: 0,
    /** 我的录音时长 `00:23` —— s3 那颗 outline 胶囊上显示的就是它 */
    recordDurationText: '',
    /** s2 顶行那个红色计时器 `00:23`（在 TS 里按毫秒格式化，见 mmss） */
    elapsedText: '00:00',
    /**
     * ⚠️ **只在开发者工具里显示**的一行诊断（真机上恒为空）。
     *    波形不出来的原因有好几种，它们屏幕上长得一模一样，只能靠这行字区分。
     */
    waveDebug: '',
    /**
     * ⭐ 这一轮要不要画实时波形 —— 由录音格式决定（见 WAVE_ON）。
     * ⚠️ 它必须是 data：WXML 里读不到模块常量，而画布在 wx:if 里。
     */
    // ⚠️ 显式标成 boolean：RECORD_SPEC.frames 是 as const 的 true，
    //    不标的话这个字段会被推断成字面量类型 true，而运行时还要能置成 false（见 handleFrame）。
    waveOn: WAVE_ON as boolean,
    /** 上传进度（0–100）—— 'uploading' 那一态给真实进度（别让「AI评测中」盖住还在传的那几秒） */
    uploadPercent: 0,

    /** ⭐ s5 的成品：大号总分（formatScore，一位小数） */
    scoreText: '',
    /** ⭐ s5 的副标题（三档：首次 / 突破最高分 / 未突破，见 subtitleOf） */
    scoreSubtitle: '',
    /**
     * ⭐ s5 左上角那行标题：**第 N 次朗读**（用户 2026-09 要求，替换原来的「AI口语测评」）。
     *    ⚠️ N 用服务端给的 attempts（= submissions.seq，这一把是这句的第几次）——
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
     *         见 zeroGrowthCards 与 WXML 里 s6 那一块）。
     */
    growthCards: [] as GrowthCard[],
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
  },

  recorder: null as Recorder | null,

  /** 页面已销毁 —— 录音回调不再往页面上写（见 onUnload 的说明） */
  gone: false,

  /**
   * ⭐ 这一轮的帧**走哪条路**：
   *   'deciding' …… 还没定，正在试解码；
   *   'decoded'  …… 平台解码器能用（真机上的正常路径）；
   *   'pcm'      …… 这一片本来就是裸 PCM，按 16bit 读；
   *   'off'      …… 解不开又不是 PCM → 不画了。
   * ⚠️ 定下来之后不再反复改判：每帧都重新试一遍会让波形忽有忽无。
   */
  frameMode: 'deciding' as 'deciding' | 'decoded' | 'pcm' | 'off',
  /** 连续解码失败次数 —— 到 FRAME_DECODE_TRIES 次才认定这条路走不通 */
  frameFails: 0,

  /**
   * canvas 2d 的绘制上下文 —— 没拿到之前 drawSamples 直接跳过。
   * ⚠️ 类型来自小程序自己的命名空间：小程序的 tsconfig 不含 DOM lib，
   *    全局的 CanvasRenderingContext2D 在这里根本不存在。
   */
  waveCtx: null as WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D | null,
  /** 画布的**设备像素**尺寸 —— 绘制坐标全部用它 */
  waveW: 0,
  waveH: 0,
  /** 本轮收到多少帧 —— 只用于开发者工具里那行诊断 */
  waveFrames: 0,
  /** 「一帧都没收到」只提示一次，别每 100ms 刷一遍 */
  waveWarned: false,

  /**
   * ⭐ 拿画布节点。
   *
   * ⚠️ 必须在**画布渲染出来之后**才拿得到（它在 wx:if 里，录音开始前根本不存在），
   *    所以这个函数从 setData 的回调里调 —— 那正是"视图已经更新完"的时刻。
   *
   * ⚠️ backing store 按**设备像素**开（尺寸 × dpr），否则在 2x/3x 屏上整条波形发虚 ——
   *    这是 canvas 最常见的"看着就是不对劲"。开了之后所有绘制坐标都用设备像素，
   *    **不调 ctx.scale**（scale 会累积，重复进入录音时会越缩越小）。
   */
  prepareWaveCanvas(attempt = 0) {
    // ⚠️ 用全局的 wx.createSelectorQuery：this.createSelectorQuery 只有**组件**实例上有
    //    （类型声明也只写在 Component 上）。画布是页面自己的节点，全局查询就够。
    wx.createSelectorQuery()
      .select(WAVE_CANVAS_ID)
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res?.[0] as { node?: WechatMiniprogram.Canvas; width?: number; height?: number } | undefined
        const node = info?.node
        /**
         * ⚠️⚠️ 拿不到就**重试几次**，不要一次失败就整轮不画。
         *
         *    "节点在、但尺寸还是 0"是会发生的：setData 的回调保证的是**逻辑层数据已下发**，
         *    而布局在渲染层是异步的 —— 恰好在那一瞬间量到 0 的概率不小。
         *    一次失败就放弃的话，表现是"波形整轮都不出来"，而**不报任何错**。
         */
        if (!node || !info?.width || !info?.height) {
          if (attempt < 3 && this.data.phase === 's2') {
            setTimeout(() => this.prepareWaveCanvas(attempt + 1), 120)
            return
          }
          console.warn('[wave] 没拿到画布节点，这一轮不画波形')
          // ⚠️ 这句诊断只给开发者工具看：真机上用户看到「画布没拿到」比看到一块空白更糟
          if (IS_DEVTOOLS) this.setData({ waveDebug: '画布没拿到（' + JSON.stringify(info ?? null) + '）' })
          return
        }
        // ⚠️ getWindowInfo 要 2.20.1+，与 lib/nav.ts 一样留一条老基础库的退路
        const info2 = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = info2.pixelRatio || 2
        node.width = Math.round(info.width * dpr)
        node.height = Math.round(info.height * dpr)
        this.waveCtx = node.getContext('2d')
        this.waveW = node.width
        this.waveH = node.height
        this.waveFrames = 0
        // ⭐ 先画一条极淡的中线：它让"画布在哪儿、有多大"当场可见。
        //    没有它，一块什么都没画的 canvas 和"这个功能不存在"长得一模一样 ——
        //    排查时会一直怀疑代码没生效（这个坑本次就踩了）。
        this.drawBaseline()
        this.setData({
          waveDebug: '画布就绪 ' + node.width + '×' + node.height + '，等音频帧…',
        })
      })
  },

  /**
   * ⭐ 收到一帧「录音分片」—— 先解码，再画。
   *
   * ⚠️⚠️ mp3 格式下帧里装的是 **mp3 码流**，不是采样，所以必须先解码：
   *    用平台自带的 WebAudioContext.decodeAudioData（见 lib/audio/frame-decode.ts）。
   *    那条路**只在真机上成立**（开发者工具里那个 API 直接不工作）。
   *
   * 三种结局，各自都有明确退路：
   *   ① 解得出采样 → 照画（真机上的正常路径）；
   *   ② 解不出来、而这一片本来就是裸 PCM → 按 16bit 小端读着画（老链路）；
   *   ③ 解不出来、而这一片是压缩块 → **停掉波形**（宁可没有，也不画假的）。
   */
  handleFrame(frame: ArrayBuffer) {
    // ⚠️ 停止之后可能还会到几帧（最后一帧在路上），那时画上去会闪一下；
    //    页面销毁之后一帧都不该画（见 onUnload）
    if (this.gone || this.data.phase !== 's2') return
    if (this.frameMode === 'off') return

    // 已经确认是裸 PCM：直接读，不再走解码（省一次异步往返）
    if (this.frameMode === 'pcm') {
      this.drawSamples(samplesFromPcm16(new Uint8Array(frame)), frame.byteLength)
      return
    }

    void this.drawDecodedFrame(frame)
  },

  /**
   * 解一帧再画。解不出来时，**只有在还没定下模式的情况下**才去决定退路 ——
   * 已经确认能解码之后再偶发失败，丢掉这一帧就好，不必把整条波形关掉。
   */
  async drawDecodedFrame(frame: ArrayBuffer) {
    const samples = await decodeFrameToSamples(frame)
    if (this.gone) return

    if (samples && samples.length > 0) {
      this.frameMode = 'decoded'
      this.frameFails = 0
      this.drawSamples(samples, frame.byteLength)
      return
    }

    /**
     * ⚠️ 解码失败不立刻改判：帧是**流**，某一帧恰好在边界上解不开是正常的。
     *    连续几帧都解不开，才说明这个环境 / 这个格式根本解不了。
     */
    this.frameFails++
    if (this.frameMode !== 'deciding' || this.frameFails < FRAME_DECODE_TRIES) return

    if (framesAreSamples(frame)) {
      this.frameMode = 'pcm'
      console.warn('[wave] 解码这条路走不通，但这一片本身就是裸 PCM —— 按 PCM 画')
      this.drawSamples(samplesFromPcm16(new Uint8Array(frame)), frame.byteLength)
      return
    }

    this.frameMode = 'off'
    console.warn(
      '[wave] 帧是编码后的音频，而这个环境解不开它（开发者工具的 WebAudio 不工作）—— ' +
        '已停掉波形。见 docs/research/recorder-output-formats.md',
    )
    // ⭐ 这件事必须**同时写在屏幕上**：一块不动的空画布比没有更糟 ——
    //    用户会以为是自己手机 / 麦克风的问题。
    //    ⚠️ s2 那一格这时只留一条中线（见 WXML），**不摆假波形**。
    this.setData({
      waveOn: false,
      waveDebug: IS_DEVTOOLS ? '模拟器不提供音频解码通路 —— 波形只在真机上有意义' : '',
    })
  },

  /**
   * ⭐ 把一段**采样**画成波形。
   *
   * 形状：**以中线对称的实心柱条**，左边是这一帧最早的声音、右边是最新的。
   * 幅度取每个柱条覆盖范围内的**峰值**（理由见 WAVE_MAX_BARS）。
   *
   * ⚠️ 柱高算在 @jushuo/shared 的 peakBars 里（纯函数、有单测）——
   *    采样有两个来源（解码 / 裸 PCM），但「每根柱子多高」只能有一份实现。
   */
  drawSamples(samples: Float32Array, byteLength = 0) {
    const ctx = this.waveCtx
    // ⚠️ 画布还没准备好（第一帧常常比它早到几十毫秒）→ 丢这一帧，
    //    下一帧就画得上；**不要**在这里重试查询，那会变成每帧一次 selectorQuery
    if (!ctx || samples.length === 0) return

    const w = this.waveW
    const h = this.waveH
    const mid = h / 2
    const barCount = Math.max(8, Math.min(WAVE_MAX_BARS, Math.floor(w / 8)))
    const heights = peakBars(samples, barCount)
    if (heights.length === 0) return

    const step = w / heights.length
    const barW = Math.max(1, step * 0.6)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = WAVE_COLOR

    let maxPeak = 0
    for (let i = 0; i < heights.length; i++) {
      const peak = heights[i] as number
      // ⚠️ 最低 2px：静音时也留一条细线，不然整条波形会消失，
      //    看起来像画布没渲染出来（与参考实现里的 Math.max(2, ...) 同理）
      const barH = Math.max(2, peak * h * 0.92)
      ctx.fillRect(i * step + (step - barW) / 2, mid - barH / 2, barW, barH)
      if (peak > maxPeak) maxPeak = peak
    }

    this.waveFrames++
    /**
     * ⚠️ 开发者工具里把「收到几帧、这一帧多少字节、峰值多少、走的哪条路」写在画布下方。
     *
     *    这一条不是装饰：波形不显示的原因有好几种（帧没来 / 画布没就绪 /
     *    解码不可用 / 数据是压缩字节），它们在屏幕上**长得一模一样**。
     *    没有这行字，只能靠反复猜 —— 本项目为此白跑过两轮。
     *    真机上不显示（IS_DEVTOOLS 为假）。
     */
    if (IS_DEVTOOLS) {
      const next =
        '第 ' + this.waveFrames + ' 帧 · ' + byteLength + ' 字节 · 峰值 ' + maxPeak.toFixed(2) +
        ' · ' + (this.frameMode === 'pcm' ? '裸 PCM' : '解码后')
      // 每帧都 setData 太浪费，隔几帧写一次就够看
      if (this.waveFrames % 5 === 1) this.setData({ waveDebug: next })
    }
  },

  /** 画一条极淡的中线 —— 让"画布在哪儿"当场可见，见 prepareWaveCanvas 的说明 */
  drawBaseline() {
    const ctx = this.waveCtx
    if (!ctx) return
    const h = this.waveH
    ctx.clearRect(0, 0, this.waveW, h)
    ctx.fillStyle = '#eeecfd'
    ctx.fillRect(0, Math.round(h / 2) - 1, this.waveW, 2)
  },

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

  /**
   * 这次要挑战的是哪一天。
   * ⚠️ 由首页带进来（/pages/reading/reading?id=<articleId>&date=2026-09-21），
   *    缺省取今天 —— 直接进朗读页（开发时）也不该崩。
   */
  scheduleDate: '',
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
    // ⚠️ 用服务端的 day.ts 而不是本地时钟：手机时间可以随便改
    this.scheduleDate = query.date ?? today()
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
    this.recorder?.stop()
    // ⚠️ 还要把它从「当前那个录音器」上摘下来：RecorderManager 是全局单例、
    //    监听器摘不掉，留着它下一帧还会往这个已经没了的页面上写（见 recorder.ts）
    this.recorder?.dispose()
    this.waveCtx = null
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
      const res = await fetchArticleRecords(articleId)
      // ⚠️ 期间用户可能已经换了页面 / 这一页销毁了
      if (this.gone || this.data.articleId !== articleId) return
      const { rows, attempts, bestScoreText } = historyRowsOf(res, this.submissionId)
      this.setData({
        historyLoading: false,
        historyError: '',
        historyRows: rows,
        historyAttempts: attempts,
        historyBestText: bestScoreText,
      })
    } catch (err) {
      if (this.gone || this.data.articleId !== articleId) return
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
    // ⚠️ 别把正在响的声音带进详情页
    stopAudio()
    this.setData({ playingWord: -1, sentenceState: 'unplay', replayState: 'unplay' })
    openChallengePage(row.submissionId)
  },

  async loadContent() {
    this.setData({ phase: 'loading', error: '' })
    try {
      const content = await fetchArticleContent(this.data.articleId)
      // ⚠️⚠️ 这条切词规则必须与生成脚本、服务端拼 fileID 的那两处**完全一致** ——
      //    否则点第 3 个词会听到第 4 个词的音，而界面上完全看不出来。
      // ⚠️ 切词走唯一实现：这个下标同时决定「第 i 个词 ↔ 第 i 个音标 / 第 i 个逐词分数」
      this.plainWords = plainWordsOf(content.text)
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
      }))
      const stdMs = readStdDurationMs(content.audio)
      this.setData({
        translation: content.translation,
        words,
        // ⚠️ audio 为 null = 这篇还没灌标准音（服务端就是这样表达的，不是 full=null）
        canPlayAudio: !!content.audio,
        fullAudio: content.audio?.full ?? '',
        audioKind: content.audio?.kind ?? 'http',
        // ⚠️ 详情接口**没有**时长（见 stdDurationText 的说明）—— 有就显示，没有就空着
        stdDurationMs: stdMs,
        stdDurationText: formatDuration(stdMs),
        phase: 's1',
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
        this.setData({
          phase: 's3',
          restored: true,
          audioPath: last.audioPath,
          playPath: last.playPath,
          durationMs: last.durationMs,
          recordDurationText: mmss(last.durationMs),
        })
      }
      this.syncEnergyNote()
      /**
       * ⭐ 历史也拉一遍 —— 与 onShow 那次是**同一份数据**（重复一次请求，很便宜）：
       *    这是"一定会拉"的那一条路，而 onShow 只保证"回到页面时"会拉。
       * ⚠️ 放在恢复出来那个 s5 的 return **之后**，所以恢复 s5 时不会走到这里 ——
       *    那条路靠 onShow 那次（它跑在 loadContent 之前）。
       */
      void this.loadHistory()
    } catch (err) {
      this.setData({ phase: 'loading', error: (err as Error).message })
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
    const ok = await this.ensureRecordAuth()
    if (!ok) {
      this.setData({ error: '需要麦克风权限：请在小程序设置里打开「录音」' })
      return
    }

    if (!this.recorder) {
      this.recorder = new Recorder({
        // ⭐ 声波监测：Recorder 交上来的帧**已经归一化到 16kHz 小端**，直接画
        onFrame: (frame) => this.handleFrame(frame),
        onStop: (r) => this.handleRecorded(r),
        onError: (e) => {
          this.stopTimer()
          this.setData({ phase: 's1', error: e.message })
        },
      })
    }

    // ⚠️ 每一轮录音重置这几个私有计数（放在 setData 外面：它们不进渲染数据）
    this.frameMode = 'deciding'
    this.frameFails = 0
    this.waveWarned = false

    this.setData(
      {
        phase: 's2',
        error: '',
        elapsedText: '00:00',
        waveDebug: WAVE_ON && IS_DEVTOOLS ? '准备画布…' : '',
        // ⚠️ 一旦开始录新的，上一段的提示就不该再挂着
        restored: false,
        audioPath: '',
        playPath: '',
        durationMs: 0,
        recordDurationText: '',
        uploadPercent: 0,
        scoreText: '',
        scoreSubtitle: '',
        growthCards: [],
        // ⚠️ 同 onRestart：入场开关要复位
        failDetail: '',
      },
      /**
       * ⭐ 画布是跟着 phase 一起被 wx:if 创建出来的，所以只能在 setData **回调**里拿 ——
       *    那正是"视图已经更新完"的时刻。放在 start() 之前还有个好处：
       *    等第一批帧到达（约 64ms 后）时画布多半已经就绪了。
       */
      () => {
        if (WAVE_ON) this.prepareWaveCanvas()
      },
    )

    const startedAt = Date.now()
    this.startedAt = startedAt
    this.timer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000
      // ⚠️ 计时器这一格必须**每 100ms 都有值**（mmss 恒返回，不像 formatDuration 会给空串）
      this.setData({ elapsedText: mmss(Date.now() - startedAt) })

      /**
       * ⚠️ 开发者工具里：录了两秒还一帧都没收到，就**主动说出来**。
       *
       *    否则屏幕上是"一块空画布"，而"帧没来"和"画得不对"长得一模一样 ——
       *    只能靠反复猜（本次就为此白跑了两轮）。
       *    ⚠️ 复用这个 100ms 的计时器，不为一行诊断再开一个 setTimeout。
       */
      if (IS_DEVTOOLS && sec > 2 && this.waveFrames === 0 && !this.waveWarned) {
        this.waveWarned = true
        this.setData({
          waveDebug: (this.waveCtx ? '画布就绪，但' : '画布没就绪，且') + ' 2 秒内没收到任何音频帧',
        })
      }
    }, 100)

    this.recorder.start()
  },

  onStopRecord() {
    this.recorder?.stop()

    if (this.stopWatchdog !== null) clearTimeout(this.stopWatchdog)
    this.stopWatchdog = setTimeout(() => {
      this.stopWatchdog = null
      if (this.data.phase !== 's2') return
      this.stopTimer()
      this.setData({ phase: 's1', error: '录音没有正常结束（3 秒内没收到停止回调），请重试' })
    }, 3000)
  },

  /** s2 → s3：录音落地，进预览 */
  handleRecorded(r: RecordResult) {
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
        tempFilePath: r.tempFilePath,
        playPath,
        durationMs: r.durationMs,
      })
    }

    this.setData({
      phase: 's3',
      restored: false,
      // ⚠️ 两个路径是两个用途，别混：
      //    audioPath → 录音落地文件：**上传**给对象存储 + **试听**都是它
      //    playPath  → 老版本留下的「帧拼 WAV」副本，新录音恒为空串
      audioPath: r.tempFilePath,
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
      phase: 'precheck',
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
        phase: 's3',
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
        phase: 's3',
        error: '暂时取不到能量余额，检查网络后再点一次',
      })
      this.syncEnergyNote()
      return
    }

    // ⚠️ 够不够**不在这里判**：给 WXML 的是余额本身，比大小是模板里的事（两个数都来自服务端）
    this.setData({
      // 停在 s3 等用户决定：够 → 「确认提交」；不够 → 「去补能量」
      phase: 's3',
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
    this.setData({ confirmOpen: false, phase: 's3' })
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
      phase: 'uploading',
      error: '',
      uploadPercent: 0,
      restored: false,
      // ⚠️ 进等待态前先把播放停掉：录音还在响的话，那颗「试听」钮的状态会留在 playing
      replayState: 'unplay',
    })
    stopAudio()
    this.syncEnergyNote()

    try {
      const { audioKey, audioUrl } = await uploadAudio(audioPath, {
        articleId,
        onProgress: (p) => this.setData({ uploadPercent: p }),
      })
      // ⚠️ 上传完了就换「AI评测中」：不换的话进度条会停在 100%，而后面还有十几秒打分
      if (this.data.phase === 'uploading') this.setData({ phase: 'scoring' })

      // ⭐ 只受理，不等打分（打分要 10–20 秒，见 lib/api/client.ts 的注释）
      // ⚠️ 回传的是**当初点进来的那一天**，不是今天：
      //    历史挑战的「再次挑战」必须归到那一天，否则昨天那张卡片的数字会变。
      // ⚠️ 不传 isPublic —— 提交时**不问**用户，用服务端默认值（false）落库，
      //    结果页（pages/challenge）再给那个开关。
      const task = await submitReading(articleId, audioKey, this.scheduleDate, audioUrl)
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
          phase: 's3',
          error:
            '能量不够了（还差 ' + Math.max(0, ENERGY_PER_CHALLENGE - (p?.energy ?? 0)) +
            ' 点）—— 明天会补到 3 点，也可以充值',
        })
      } else {
        this.setData({ phase: 's3', error: e.message })
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
            phase: 's3',
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
      phase: 's6',
      failDetail: detail || '录音不符合规范，无法检测发音',
      scoreText: '',
      scoreSubtitle: '',
      // ⚠️ 失败态的三张卡是恒定的 +0（灰）—— 不需要服务端给（见 zeroGrowthCards）
      growthCards: zeroGrowthCards(),
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
    const growth = growthDeltaOf(result)
    this.setData({
      phase: 's5',
      error: '',
      // ⚠️ 先落**最终值**：数字滚动只是"盖在上面"的临时显示，
      //    任何一帧被打断（定时器被清）都不能让界面停在半路。
      scoreText: formatScore(result.score),
      scoreSubtitle: this.subtitleOf(result),
      attemptTitle: result.attempts > 0 ? '第' + result.attempts + '次朗读' : 'AI口语测评',
      growthCards: growthCardsOf(growth),
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
    if (roll) this.rollNumbers(result.score, growth)
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
   * ⚠️ 分数一位小数（走 formatScore 的统一口径）、成长值取整（Math.round）。
   *
   * @param score  最终分（0–100，一位小数）
   * @param growth 这一把的成长值增量；null = 服务端还没给，那就只滚分数
   */
  rollNumbers(score: number, growth: Partial<GrowthView> | null) {
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
        ...(growth
          ? {
              growthCards: growthCardsOf(
                done
                  ? growth
                  : {
                      self: Math.round((growth.self ?? 0) * k),
                      diligence: Math.round((growth.diligence ?? 0) * k),
                      standout: Math.round((growth.standout ?? 0) * k),
                    },
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
   * ⚠️ 第 K 次的 K **直接读服务端给的 attempts（= submissions.seq）**，
   *    不再从 store 的缓存里猜：那个缓存里没有这句的旧战绩时会猜成第 1 次，
   *    与「不是首次」自相矛盾，于是上一版只能夹一个下限 2 —— 拿一个谎补另一个谎。
   *    ⚠️ attempts 含失败的那几次（受理时就分配了 seq），与「我在这句打过几次分」
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
  onConfirmResult() {
    this.clearAttempt()
    this.submissionId = ''
    void this.loadHistory()
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
  onRestart() {
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
    // ⚠️ 先停数字滚动：不停的话它会继续往 s1 的界面上写 scoreText（见 rollNumbers）
    this.stopRoll()
    if (this.recordingKey) clearLastRecording(this.recordingKey)
    if (this.recordingKey) clearLastResult(this.recordingKey)
    this.setData({
      phase: 's1',
      error: '',
      restored: false,
      audioPath: '',
      playPath: '',
      durationMs: 0,
      recordDurationText: '',
      elapsedText: '00:00',
      uploadPercent: 0,
      scoreText: '',
      scoreSubtitle: '',
      attemptTitle: '',
      growthCards: [],
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
 * ⚠️ 现在详情接口的 audio 就是 shared 的 **ScheduleAudio**（= AudioRef + durationMs）——
 *    与列表接口同一套（服务端走同一个 scheduleAudioOf）。所以顶行那个 `00:23` 有值了。
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
 * ⭐ 从提交结果里读「这一把的成长值快照」。
 *
 * ⚠️ 字段就是 shared 的 SubmitResponse.growth（形状 GrowthView：self / diligence / standout），
 *    由服务端 services/submission-view.ts 从 submissions.growth_* 读出来 ——
 *    端侧读的字段名与服务端给的是同一个，不再有第二套。
 * ⚠️ 它是**可选**的：结算与「status 置为 scored」不在同一个事务里，轮询可能卡在中间；
 *    老数据也可能没结算过 ⇒ null，端侧整块不渲染（见 growthCardsOf）。
 */
function growthDeltaOf(result: SubmitResponse): Partial<GrowthView> | null {
  return result.growth ?? null
}
