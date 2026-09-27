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
import { ApiError, fetchSubmissionStatus, getUserId, submitReading } from '../../lib/api/client'
import { uploadAudio } from '../../lib/api/upload'
import { decodeFrameToSamples } from '../../lib/audio/frame-decode'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { speak } from '../../lib/audio/tts'
import { Recorder, type RecordResult } from '../../lib/audio/recorder'
import { fetchArticleContent } from '../../lib/content'
import { CHALLENGE_PAGE } from '../../lib/challenges'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'
import { refreshPreviousPage } from '../../lib/refresh-previous'
import {
  clearLastRecording,
  loadLastRecording,
  recordingKeyOf,
  saveLastRecording,
} from '../../lib/audio/last-recording'
import { ensureLocalAudio, prefetchAudio } from '../../lib/audio/standard'

/**
 * ⭐⭐ 朗读页 —— **六个状态的显式状态机**（规格：docs/design/reading/SPEC.md）。
 *
 *   s1 未录音 ──点麦克风──▶ s2 录音中 ──停止──▶ s3 录音预览
 *    ▲                                             │ ✓（确认 = 提交评测）
 *    │                                             ▼
 *    │                                        s4 AI 评测中
 *    │                                          │        │
 *    │                                   评分成功│        │引擎失败 / 评测超时
 *    │                                          ▼        ▼
 *    └────────「重新挑战」（清缓存）──────── s5 成功    s6 失败
 *    └────────「重录」  （清缓存）─────────────────────┘
 *
 * ⚠️⚠️ 为什么把它写成**显式**六态，而不是原来那串 ready/recording/recorded/done：
 *    设计稿是逐态画的（顶行、主体、底部三块各自不同），而原来那套名字和设计稿
 *    对不上号 —— 对着稿子改代码时要在脑子里先做一次翻译，翻错一次就是
 *    「改了 s4、结果是 s5 变了」。现在 WXML 里写的就是设计稿上的 sN。
 *
 * ⚠️ 另有两个**不属于六态**的东西，别混进来：
 *    · loading —— 句子还没拉到（拉失败也停在这里，给「重试」）；
 *    · error   —— 一句人话，横跨所有状态（麦克风没授权 / 能量不够 / 上传失败…），
 *                它**不改变状态**，只是多一条红条（见 WXML 末尾）。
 *
 * ⚠️⚠️ 提交被拒**不都是错误**：能量不够是业务规则、不是故障，必须和真错误分开说，
 *    否则用户以为小程序坏了，然后反复重试（而那正是要拦的行为）。
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

type Phase = 'loading' | 's1' | 's2' | 's3' | 's4' | 's5' | 's6'

/**
 * ⭐ s4 的**超时** —— 到点即进 s6（用户 2026-09 定：等待期不做手工取消，只做超时兜底）。
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
 * ⚠️⚠️ 本轮**服务端还没有**下发这一把的成长值快照（SPEC 把它排在下一轮：
 *    submissions.growth_self / growth_diligence / growth_standout 已落库，只是没往外给）。
 *    所以这里按**可选字段**读：字段在就出三张卡，不在就**整块不渲染**。
 *    写成可选之后，下一轮服务端把 SubmitResponse.growth 补上，端侧一行都不用改。
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
     * ⚡ 能量点数 —— s3/s4/s5/s6 底部那行小字要用它。
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
     * ⚠️⚠️ 本轮**拿不到这个数**：朗读页拉的是 /api/articles/:id，那份响应里的 audio
     *    只有 { full, kind }，**没有 durationMs**（列表接口的 ScheduleAudio 才有）。
     *    而本轮明确不动服务端 ⇒ 这里按**可选字段**读（见 readStdDurationMs），
     *    读不到就是空串，WXML 里据此**不渲染那几个字**
     *    （不是显示 00:00 —— 那看着像音频坏了）。
     *    下一轮让详情接口把 durationMs 带上（服务端已有现成的 standardAudioMs），
     *    这里自动就显示了，端侧不用改。
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
    /** 我的录音时长 `00:23` —— s3/s4 那颗 outline 胶囊上显示的就是它 */
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
    /** 上传进度（0–100）—— s4 里给一句真实进度，别让「AI评测中」盖住还在上传的那几秒 */
    uploadPercent: 0,

    /** ⭐ s5 的成品：大号总分（formatScore，一位小数） */
    scoreText: '',
    /** ⭐ s5 的副标题：首次挑战，打败 N 人，位列第 M / 第 K 次挑战，…… */
    scoreSubtitle: '',
    /**
     * ⭐ 成长值三卡。
     *   · s5：拿不到这一把的增量时是**空数组** ⇒ 整块不渲染；
     *   · s6：恒为三张 +0（灰）。
     */
    growthCards: [] as GrowthCard[],
    /**
     * ⭐ s6 的副标题。
     *   默认是设计稿那句「录音不符合规范，无法检测发音」；
     *   但**超时**进 s6 时会换成一句真话（分数可能还在云端算）—— 见 SCORING_TIMEOUT_MS。
     */
    failDetail: '',
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
   *   已消耗（s3 预览要提交 / s4 评测中 / s5 成功）：评测消耗能量2，剩余3
   *   未消耗（s6 失败）：                              本次评测消耗能量0，剩余5
   *
   * ⚠️⚠️ 端侧**不做结算**（受理时锁 2 点、失败释放都在服务端）：这里显示的「剩余」
   *    是拿手上这份余额减去本次会消耗的点数**预估**出来的，用来让用户提交前心里有数。
   *    真正的余额仍以服务端为准（下次 /me 会覆盖它）。
   * ⚠️ 那个 2 取自 shared 的 ENERGY_PER_CHALLENGE，端侧**不写死**。
   */
  syncEnergyNote() {
    const phase = this.data.phase
    const energy = this.data.energy || 0
    const left = Math.max(0, energy - ENERGY_PER_CHALLENGE)
    /**
     * ⚠️ 措辞按设计稿分两种（不是随手加的「本次」）：
     *    预览 / 评测中说的是**还没落定**的一次消耗 ——「评测消耗能量2，剩余3」；
     *    出了结果（s5 / s6）才谈得上「**本次**评测消耗能量…」。
     */
    const head = phase === 's5' || phase === 's6' ? '本次评测消耗能量' : '评测消耗能量'
    /**
     * ⚠️ 余额不够时**必须自己说出来**（上一版就有这句提示，别丢）：
     *    否则 s3 上那句「评测消耗能量2，剩余0」看着只是陈述，
     *    用户点了 ✓ 才被服务端拒 —— 而「明天会补到 3 点」才是他真正需要知道的事。
     */
    const short =
      energy < ENERGY_PER_CHALLENGE && (phase === 's3' || phase === 's4')
        ? '（不够了，明天会补到 3 点）'
        : ''
    this.setData({
      energyNote:
        phase === 's6'
          ? head + '0，剩余' + energy
          : head + ENERGY_PER_CHALLENGE + '，剩余' + left + short,
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
   * 试听**我的录音**（s3 / s4 那颗 outline 胶囊）。
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
  // s3 → s4：提交评测
  // ----------------------------------------------------------------
  async onSubmit() {
    const { audioPath, durationMs, articleId, phase } = this.data
    if (!audioPath) return
    // ⚠️ s4 里那颗 ✓ 已经不在界面上了；这里再挡一道是防连点（会白烧一次上传流量）
    if (phase === 's4') return

    // ⚠️ 这里**不拦「加入过没有」**：身份（openid）是静默拿到的，而服务端在
    //    每个业务接口前按 openid 取用户、没有就建一行（middleware/auth.ts）。
    //    本页可以被分享 / 扫码直接打开，那些人也一样 —— 先让他读。
    //    昵称 / 头像只是榜上显示成什么，不是任何功能的前置条件。

    // ⭐ 本地预检 —— 刻意极度宽松：放行垃圾的成本极低，误伤用户的成本是流失。
    //    这里只拦「明显没录上」，真正的语音检测在引擎侧。
    //    ⚠️ 不合格时**留在 s3**（不是进 s6）：s6 是「引擎判失败」的结果屏，
    //      而这一条在提交之前就能拦住，用户改一下再点就是了。
    if (durationMs < PREFLIGHT.minDurationMs) {
      this.setData({
        error:
          '录音太短（' + (durationMs / 1000).toFixed(1) + ' 秒），至少要说满 ' +
          PREFLIGHT.minDurationMs / 1000 + ' 秒',
      })
      return
    }

    this.setData({
      phase: 's4',
      error: '',
      uploadPercent: 0,
      restored: false,
      // ⚠️ 进 s4 前先把播放停掉：录音还在响的话，那颗「试听」钮的状态会留在 playing
      replayState: 'unplay',
    })
    stopAudio()
    this.syncEnergyNote()

    try {
      const { audioKey, audioUrl } = await uploadAudio(audioPath, {
        articleId,
        onProgress: (p) => this.setData({ uploadPercent: p }),
      })

      // ⭐ 只受理，不等打分（打分要 10–20 秒，见 lib/api/client.ts 的注释）
      // ⚠️ 回传的是**当初点进来的那一天**，不是今天：
      //    历史挑战的「再次挑战」必须归到那一天，否则昨天那张卡片的数字会变。
      // ⚠️ 不传 isPublic —— 提交时**不问**用户，用服务端默认值（false）落库，
      //    结果页（pages/challenge）再给那个开关。
      const task = await submitReading(articleId, audioKey, this.scheduleDate, audioUrl)
      // ⭐ 记住它：s5 的「评测详情」要靠它去 pages/challenge
      this.submissionId = task.submissionId
      // ⚠️ 受理阶段就被判失败（音频不合规 / 文章不存在）→ 直接进 s6
      if (task.status === 'failed') {
        this.toFail('')
        this.setData({ error: task.error ?? '' })
        return
      }
      // 幂等命中：这段音频早就打过分，结果直接就在包里
      if (task.status === 'scored' && task.result) {
        this.applyResult(task.result)
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
      if (this.gone || this.data.phase !== 's4') return

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
        this.applyResult(st.result)
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
   * ⭐ s4 → s6：评测失败（引擎判失败 / 受理就失败 / 客户端超时）。
   *
   * @param detail 副标题。空串 = 用设计稿那句「录音不符合规范，无法检测发音」；
   *               **超时**时传一句真话进来（分数可能还在云端算）——
   *               那句设计稿文案只适用于「引擎说这段音频不行」，超时不是那个原因。
   */
  toFail(detail: string) {
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
   * ⭐ s4 → s5：云端权威结果到手的这一刻。
   *
   * ⚠️ 顺序不能换：store 与刷新必须**先**做完 —— 用户可能立刻点「重新挑战」或退出，
   *    那时再想补写就没有机会了（首页会一直停在旧数据上）。
   *    而且 scoreSubtitle 里的「第 K 次」正是从刚写进 store 的 attempts 算的。
   */
  applyResult(result: SubmitResponse) {
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

    stopAudio()
    /**
     * ⭐⭐ 拿到分数 = 这段录音**已经被消费掉了**。
     *    ⚠️ 但**不在这里清缓存**：s5 上那颗「试听」播的就是本地这份文件，
     *       清早了按钮就点了没反应。真正的清理在 onUnload（见那里的说明）。
     */
    this.setData({
      phase: 's5',
      error: '',
      scoreText: formatScore(result.score),
      scoreSubtitle: this.subtitleOf(result),
      growthCards: growthCardsOf(growthDeltaOf(result)),
      failDetail: '',
      playingWord: -1,
      sentenceState: 'unplay',
      replayState: 'unplay',
    })
    this.syncEnergyNote()
  },

  /**
   * ⭐ 成功态副标题：首次挑战，打败5人，位列第5 / 第3次挑战，打败5人，位列第5。
   *
   * ⚠️ 首次的判据是 **previousBest === null**（服务端给的上一次成绩）——
   *    它比「端侧算第几次」可靠得多，SPEC 里也是这么定的。
   * ⚠️ 第 K 次的 K 取自 store 里刚累加过的那一份（applyResult 里先写了 store 才调这里）。
   *    但它是**缓存**：这个用户如果没从首页进来，store 里可能根本没有这一句的旧战绩，
   *    那时 K 会是 1 —— 与「不是首次」自相矛盾。所以夹一个下限 2：
   *    previousBest 非空 ⇒ 至少读过一次，那就是第 2 次起步。
   */
  subtitleOf(result: SubmitResponse): string {
    const head =
      result.previousBest === null
        ? '首次挑战'
        : '第' + Math.max(2, me.arenaOf(result.articleId).myAttempts) + '次挑战'
    return head + '，打败' + result.beatenCount + '人，位列第' + result.rank
  },

  /**
   * 「评测详情」—— 详细结果在 pages/challenge（五个分项 / 逐词上色 / 榜单 / 分享）。
   *
   * ⚠️ 用 redirectTo 而不是 navigateTo：从详情页返回应该回到**进入朗读页之前**那一页
   *    （首页 / 竞技场 / 我的挑战），而不是退回来对着一个已经交掉的录音界面。
   * ⚠️ 这一页**保留**（SPEC 已定口径）：s5/s6 只放摘要。
   */
  onOpenDetail() {
    const url = CHALLENGE_PAGE + '?sid=' + encodeURIComponent(this.submissionId)
    wx.redirectTo({ url, fail: () => wx.reLaunch({ url }) })
  },

  /**
   * ⭐ 「重录」（s3 的 ↺）/「重新挑战」（s5、s6）—— **清缓存回 s1**。
   *
   * ⚠️ 三个入口共用这一个动作，因为它们的意图完全一样：这一段不要了，从头来。
   *    （措辞不同只是因为所处状态不同：预览时叫重录，出分后叫重新挑战。）
   * ⚠️ 必须**一起清掉缓存**：不清的话，下次再进这一页又会被恢复成 s3 ——
   *    点「重录」等于没点（这是踩过的坑）。
   * ⚠️ 只清**这一句**的槽位：别的句子的录音不该被连坐。
   */
  onRestart() {
    if (this.recordingKey) clearLastRecording(this.recordingKey)
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
 * ⚠️⚠️ 现在这个字段**根本不在响应里**：朗读页拉的 /api/articles/:id 给的 audio
 *    只有 { full, kind }（ArticleDetail.audio: AudioRef）—— 带 durationMs 的是列表接口的
 *    ScheduleAudio。而本轮明确不改服务端。
 *    ⇒ 按**可选字段**读：服务端哪天把它带上（它已有现成的 standardAudioMs），
 *      这里不用改一行，顶行的 00:23 自己就出来了。
 * ⚠️ 不要用别的办法估：InnerAudioContext 的时长要等音频真的加载完才知道，
 *    为了几个字去建一个播放器实例，代价比收益大得多（还可能被音频池限制）。
 */
function readStdDurationMs(audio: { full: string; kind: 'cloud' | 'http' } | null): number {
  if (!audio) return 0
  const ms = (audio as { durationMs?: number }).durationMs
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
}

/**
 * ⭐ 从提交结果里读「这一把的成长值快照」。
 *
 * ⚠️⚠️ 本轮**服务端还没往下发**这个字段（SPEC 把 SubmitResponse 加 growth 排在下一轮：
 *    submissions.growth_self / growth_diligence / growth_standout 已落库，只是没往外给）。
 *    所以这里按可选字段读：有就出三张卡，没有就整块不渲染。
 *    ⚠️ 形状按 shared 的 GrowthView（self / diligence / standout）——
 *      下一轮服务端照这个形状补上，端侧不用改。
 */
function growthDeltaOf(result: SubmitResponse): Partial<GrowthView> | null {
  const g = (result as SubmitResponse & { growth?: Partial<GrowthView> }).growth
  return g && typeof g === 'object' ? g : null
}
