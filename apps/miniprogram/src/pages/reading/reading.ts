import {
  MS_PER_WORD,
  PREFLIGHT,
  RECORD_SPEC,
  WORD_GREEN_LINE,
  formatScore,
  WORD_RED_LINE,
  peakBars,
  samplesFromPcm16,
  sniffAudioContainer,
  today,
} from '@jushuo/shared'
import { plainWordsOf } from '@jushuo/shared'
import type { SubmitResponse } from '@jushuo/shared'

import { PLATFORM } from '../../config'
import {
  ApiError,
  fetchSubmissionStatus,
  getUserId,
  setSubmissionVisibility,
  submitReading,
} from '../../lib/api/client'
import { uploadAudio } from '../../lib/api/upload'
import { decodeFrameToSamples } from '../../lib/audio/frame-decode'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
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
/** canvas 的 id —— 只在「录音中」那一块里存在（wx:if） */
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

/**
 * 朗读页 —— 产品的**唯一动作入口**。
 *
 * 用户在这里只有两件事可做：录音（重录）、提交检测。没有别的。
 *
 * 状态机：
 *   loading → ready → recording → recorded → submitting → done
 *                 ↑                              │
 *                 └────────── 重录 ──────────────┘
 *
 * ⚠️ 提交被拒**不都是错误**：额度用完（QUOTA_EXHAUSTED）是业务规则，不是故障
 *    是完全正常的业务分支，必须和真错误区分开 ——
 *    否则用户看到「请求失败」会以为小程序坏了，然后反复重试（而那正是要拦的行为）。
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
 *      也就是本页 done 状态那一段。
 * ══════════════════════════════════════════════════════════════════
 */

type Phase = 'loading' | 'ready' | 'recording' | 'recorded' | 'submitting' | 'done'

/** 分项 / 逐词的着色阈值 —— 只影响展示，不影响分数 */
/**
 * ⭐ 两条线都取自共享常量：**算分用的「绿词」就是用户看到的绿字**。
 * ⚠️ 两处各写一个 85 的话，一旦哪天只改了一边，
 *    用户就会看到「这几个词明明是绿的，为什么没上 90」—— 解释链当场断掉。
 * ⚠️ 逐词那一档的**判断本身**（绿 / 红 / 墨）在 shared 的 wordLevel() 里，
 *    因为「我的挑战」列表也要把同一句重新上色（见那里的说明）。
 */
const WORD_GOOD = WORD_GREEN_LINE
/** < 标红：明显有问题 */
const WORD_BAD = WORD_RED_LINE

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

/**
 * 实时进度用的「每词多少毫秒」—— **可自适应**。
 *
 * ⚠️ 实时跟随摘掉之后，它只用来在录完之后做一次语速诊断（可选），
 *    不再驱动任何界面。
 */
const DEFAULT_MS_PER_WORD = 550
const MS_PER_WORD_KEY = 'reading_ms_per_word'
/** 合理区间 —— 防止一次没读完的录音把基准带跑偏 */
const MPW_MIN = 250
const MPW_MAX = 1600

/**
 * 预拉取逐词音的**上限**。
 *
 * ⚠️ 限制的不是流量（一个词才几 KB），是**并发请求数**：
 *    长句几十个词，进页面就一次性全发出去，会挤占小程序本就不宽的请求通道 ——
 *    而此刻用户可能正要录音或提交。
 */
const MAX_PREFETCH_WORDS = 24

interface WordView {
  /** 稳定的 key（同一个词可能出现多次，不能用 text 当 key） */
  i: number
  text: string
  cls: string
}

interface SubmitWord {
  word: string
  score: number
  dp: string
}

/** 四维得分的展示视图 */
interface DimensionView {
  key: string
  label: string
  /** 展示用文本（整数不带小数点，看着更干净） */
  value: string
  /** 进度条宽度百分比 */
  pct: number
  textCls: string
  barCls: string
}

/**
 * ⭐ 四个句级维度，顺序**对应总分公式里的权重**（由大到小）：
 *
 *     total = (0.6×准确度 + 0.3×流利度 + 0.1×标准度) × 完整度
 *
 * ⚠️ 权重是实测反推出来的 0.6/0.3/0.1，不是文档里的 0.5/0.3/0.2 ——
 *    详见 packages/shared/src/types/api.ts 的 ScoreDimensions 注释。
 *
 * ⚠️ 前三项是「加权的分项」，第四项是**乘性的闸门** —— 顺序不能随便打乱，
 *    否则用户没法把四个数字和总分对上。
 */
/**
 * ⭐ 「评分详情」显示的是**我们自己那套打分的分项**，不是引擎返回的四维。
 *
 * ⚠️⚠️ 为什么不能直接摆引擎那四维：总分已经不按它们等权算了 ——
 *    摆在一起用户对不上（「我准确度 91，为什么总分 85」），
 *    而且完整度对能读完的人恒为 100，摆在四位里纯属占位置。
 *    这里五项**加起来就是那个总分**（权重见 @jushuo/shared 的 SCORE_WEIGHTS）。
 *
 * ⚠️ 标签用大白话：standard 在引擎文档里叫「标准度」，但那是引擎的内部叫法，
 *    它量的其实是语调/韵律；给用户看就叫「语调」。
 */
type PartKey = 'prosody' | 'weakness' | 'accuracy' | 'fluency' | 'completeness'

const PART_META: { key: PartKey; label: string }[] = [
  { key: 'prosody', label: '语调' },
  { key: 'weakness', label: '咬字' },
  { key: 'accuracy', label: '发音' },
  { key: 'fluency', label: '流利' },
  { key: 'completeness', label: '完整' },
]

Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    articleId: '',
    phase: 'loading' as Phase,
    error: '',


    translation: '',

    /** 逐词渲染（提交后由云端结果着色） */
    words: [] as WordView[],

    /**
     * ⭐ **是否公开这次录音**。
     *
     * ⚠️ 它是「提交上榜」的一个选项，不是权限：无论公开与否，
     *    音频都存在对象存储里、榜单上都有这一条成绩；
     *    区别只是**别人能不能听到这段录音**。
     *
     * ⚠️⚠️ 默认 **false**，提交时**不问**用户；结果页（pages/challenge）那个
     *    「允许公众收听」开关再打开。听完自己的分数再决定要不要让人听，
     *    依据比提交前横一个开关足得多。
     * ⚠️ 从挑战详情分享卡片进来的本来就能听，不受这一位影响。
     */
    isPublic: false,
    /**
     * ⚡ 能量点数 —— 提交按钮下面那行要用它。
     * ⚠️ 只从服务端给的 profile 里读（每次 /me 顺手补足到 3 点），端侧不自己算。
     */
    energy: 0,

    /**
     * ⭐ 能不能播标准音。
     * ⚠️ 由**内容接口**说了算（它返回云存储 fileID）：没有音频时这里就是 false，
     *    整个播放入口都不渲染 —— 而不是给一个点了没反应的图标。
     */
    canPlayAudio: false,

    /** 整句标准音（fileID 或服务端路径，由 audioKind 决定怎么解释） */
    fullAudio: '',
    /** 'cloud' | 'http' —— 见 shared 的 AudioRef / ArticleDetailAudio */
    audioKind: 'http' as 'cloud' | 'http',

    /** 正在播的单词下标；-1 表示没在播单词 */
    playingWord: -1,
    /** ⭐ 右上角那个喇叭的状态（见 audio-button）—— 整句标准音只有这一个播放钮 */
    sentenceState: 'unplay' as 'unplay' | 'loading' | 'playing',
    /** ⭐ 试听（我自己这段录音）的状态 —— 同一颗播放钮 */
    replayState: 'unplay' as 'unplay' | 'loading' | 'playing',

    /**
     * ⭐ 这段录音是从**上次的缓存**恢复来的（不是刚录的）。
     * ⚠️ 必须让用户看见：他会以为是自己刚录的，然后直接提交 ——
     *    而他并不记得那段音频里读的是什么。
     */
    restored: false,

    /** 录音落地的原始文件（裸 PCM）—— **上传用** */
    audioPath: '',
    /** 加了 WAV 头的副本 —— **试听用**（裸 PCM 播不了，见 writePlayableWav） */
    playPath: '',
    durationMs: 0,
    elapsed: '0.0',
    /**
     * ⚠️ **只在开发者工具里显示**的一行诊断（真机上恒为空）。
     *    波形不出来的原因有好几种，它们屏幕上长得一模一样，只能靠这行字区分。
     */
    waveDebug: '',
    /**
     * ⭐ 这一轮要不要画实时波形 —— 由录音格式决定（见 WAVE_ON）。
     * ⚠️ 它必须是 data：WXML 里读不到模块常量，而画布在 wx:if 里。
     */
    // ⚠️ 显式标成 boolean：RECORD_SPEC.frames 是 `as const` 的 true，
    //    不标的话这个字段会被推断成字面量类型 true，而运行时还要能置成 false（见 handleFrame）。
    waveOn: WAVE_ON as boolean,
    uploadPercent: 0,
    /** 已经在打分上等了多久（秒）—— 轮询期间显示，让等待可见 */
    scoringSeconds: 0,

    /**
     * ⭐ 简版结果反馈（打完分停留的那一屏）—— 只有三样东西：
     *    大号总分、AI 的一句话点评、AI 的提升建议。
     *
     * ⚠️⚠️ 详细结果（五个分项、逐词上色、榜单、分享）在 pages/challenge。
     *    这一屏刻意只做刚读完那一下的反馈：分数够大、点评够短、下一步够清楚
     *    （再次挑战 / 查看详情）。把详情塞回这一屏，读完看一眼就会变成读完读一屏。
     */
    scoreText: '',
    aiComment: '',
    aiAdvice: '',
  },

  recorder: null as Recorder | null,

  /** 页面已销毁 —— 录音回调不再往页面上写（见 onUnload 的说明） */
  gone: false,

  /**
   * ⭐ 这一轮的帧**走哪条路**：
   *   'decoding' …… 还没定，正在试解码；
   *   'decoded'  …… 平台解码器能用（真机 mp3 的正常路径）；
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
  // ⚠️ 这里原来有一个 waveContainer（标记「帧是压缩块」）—— 已经不需要了：
  //    帧走哪条路由 frameMode 记着，诊断行也是从它推出来的。

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
          if (attempt < 3 && this.data.phase === 'recording') {
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
    if (this.gone || this.data.phase !== 'recording') return
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
  timer: null as ReturnType<typeof setInterval> | null,
  /** 原始词表（不带样式），渲染时再套 cls */
  plainWords: [] as string[],
  /**
   * 本次提交的 id —— 「公开我的录音」开关要靠它改。
   * ⚠️ 不能从结果里取：SubmitResponse 里没有它（那是给页面看的业务结果，
   *    id 是协议层的，由受理/轮询那一步记下来更直接）。
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
   * 逐词标准音的 fileID，下标与 plainWords 一一对应。
   * ⚠️ 新内容**不再产这个**（每句 N 个文件，对象存储 / 灌库 / CDN 都要跟着走一遍）。
   *    只有**没有时间戳的老内容**才用它兜底，见 onPlayWord。
   */
  wordAudio: [] as (string | null)[],

  /**
   * ⭐ 逐词的**播放区间**（毫秒），下标与 plainWords 一一对应。
   *
   * 点某个词时直接在**整句标准音**上定位到 startMs、播到 endMs —— 不再需要预切文件。
   * ⚠️ 区间来自正文 JSON 的 words[]（流水线 ④ 产出；与预切切片**同源**，
   *    所以换过来听感不变）。
   * ⚠️ 只在**条数对得上**时才用（见 applyContent）：错位会变成「点这个词、播那个词」。
   */
  wordTimes: [] as { startMs: number; endMs: number }[],
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
   * ⚠️ `manager.onStop` 万一不回调（设备异常、录音被系统抢走），
   *    界面会**永远停在「录音中」**，用户唯一能做的是杀掉小程序。
   *    宁可 3 秒后给一句明确的错误，也不能挂死。
   */
  stopWatchdog: null as ReturnType<typeof setTimeout> | null,

  onLoad(query: Record<string, string | undefined>) {
    this.msPerWord = loadMsPerWord()
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

  /** 本次进度采用的「每词毫秒数」—— 只用于提交后的语速诊断 */
  msPerWord: DEFAULT_MS_PER_WORD,

  onUnload() {
    /**
     * ⭐ 打完分、又离开了结果页 → 本地这段录音才算**真正消费掉**。
     *
     * ⚠️⚠️ 为什么挪到这里、而不是提交成功那一刻：
     *    清掉会把槽位目录整个删除（录音原件 + 试听 WAV），
     *    而结果页上那个「试听」按钮播的正是它。删早了 = 按钮点了没反应。
     *    放在这一页的生命周期末尾，两条目的同时满足：
     *      · 用户在结果页上还能回听自己刚读的；
     *      · 下次进这一句不会再恢复出旧录音（防「隔天点一下提交」白拿 streak）。
     */
    if (this.data.phase === 'done' && this.recordingKey) {
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
      // ⚠️ 切词走唯一实现：这个下标同时决定「第 i 个词 ↔ 第 i 个音频 / 第 i 个时间区间」
      this.plainWords = plainWordsOf(content.text)
      // ⭐ 缓存键由**句子原文 + uid** 决定（不是 articleId）—— 见字段上的说明
      this.recordingKey = recordingKeyOf(content.text, getUserId())
      /**
       * ⭐ 逐词怎么播：**优先用正文 JSON 里的时间戳**（在整句标准音上定位），
       *    预切切片只作为老内容的兜底。
       * ⚠️ 时间戳只在**条数对得上**时才认：错位同样是「点这个词、播那个词」，
       *    而且比切错更难查 —— 没有任何东西会报错。
       */
      const words = content.words ?? []
      this.wordTimes =
        words.length === this.plainWords.length
          ? words.map((w) => ({ startMs: w.startMs, endMs: w.endMs }))
          : []
      this.wordAudio = content.audio?.words ?? []
      this.setData({
        translation: content.translation,
        words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
        // ⚠️ audio 为 null = 这篇还没灌标准音（服务端就是这样表达的，不是 full=null）
      canPlayAudio: !!content.audio,
        fullAudio: content.audio?.full ?? '',
        audioKind: content.audio?.kind ?? 'http',
        phase: 'ready',
      })

      // ⭐ 内容一到就**后台**把标准音拉到本地 —— 用户点喇叭时就不用等网络了
      this.prefetchStandardAudio()


      // ⭐ 这句子上次录的那段还在吗？在就**直接进入「已录好」**——
      //    用户不必为了接个电话就重读一遍。
      //    ⚠️ 按**句子**匹配：同一句换个日期再轮到，参考文本一字不差，
      //       那段录音照样是有效的（见 last-recording 的边界 ①）。
      const last = this.recordingKey ? loadLastRecording(this.recordingKey) : null
      if (last) {
        this.setData({
          phase: 'recorded',
          restored: true,
          audioPath: last.audioPath,
          playPath: last.playPath,
          durationMs: last.durationMs,
          elapsed: (last.durationMs / 1000).toFixed(1),
        })
      }
    } catch (err) {
      this.setData({ phase: 'loading', error: (err as Error).message })
    }
  },

  onReload() {
    void this.loadContent()
  },



  // ----------------------------------------------------------------
  // 录音
  // ----------------------------------------------------------------
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
          this.setData({ phase: 'ready', error: e.message })
        },
      })
    }

    // ⚠️ 每一轮录音重置这几个私有计数（放在 setData 外面：它们不进渲染数据）
    this.frameMode = 'deciding'
    this.frameFails = 0
    this.waveWarned = false

    this.setData(
      {
        phase: 'recording',
        error: '',
        elapsed: '0.0',
        waveDebug: WAVE_ON && IS_DEVTOOLS ? '准备画布…' : '',
        // ⚠️ 一旦开始录新的，上一段的提示就不该再挂着
        restored: false,
        audioPath: '',
        playPath: '',
        result: null,
        words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
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
      this.setData({ elapsed: sec.toFixed(1) })

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
      if (this.data.phase !== 'recording') return
      this.stopTimer()
      this.setData({ phase: 'ready', error: '录音没有正常结束（3 秒内没收到停止回调），请重试' })
    }, 3000)
  },

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
     *    现在落盘的是 aac（微信接口的默认格式），**两个平台都能直接播** ——
     *    那一整套绕法连同它的坑一起没了。
     */
    const playPath = ''

    // ⭐ 落盘 —— 万一片子丢了、页面退了，下次进同一天的挑战还能捡回来
    if (this.recordingKey) {
      saveLastRecording({
        key: this.recordingKey,
        tempFilePath: r.tempFilePath,
        playPath,
        durationMs: r.durationMs,
      })
    }

    this.setData({
      phase: 'recorded',
      restored: false,
      // ⚠️ 两个路径是两个用途，别混：
      //    audioPath → 录音落地文件：**上传**给对象存储 + **试听**都是它
      //    playPath  → 老版本留下的「帧拼 WAV」副本，新录音恒为空串
      audioPath: r.tempFilePath,
      playPath,
      durationMs: r.durationMs,
      elapsed: (r.durationMs / 1000).toFixed(1),
      error: '',
    })
  },


  /**
   * 试听。
   *
   * ⭐ 录音格式改成微信接口的默认值（aac）之后，这一件事**变简单了**：
   *    落盘的那个文件本身就是能播的容器，两个平台播的都是它。
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
    const primary = IS_DEVTOOLS ? this.data.audioPath : this.data.playPath
    const fallback = IS_DEVTOOLS ? this.data.playPath : this.data.audioPath
    const src = primary || fallback

    if (!src) {
      this.setData({
        error: this.data.audioPath ? '试听文件没生成成功 —— 请重录' : '还没有录音',
      })
      return
    }

    // ⚠️ 整句 / 单词 / 试听**共用同一个播放器**，开播前先把别人的标记清掉，
    //    否则会出现「试听在播」和「整句在播」两颗钮同时亮着
    this.setData({ replayState: 'playing', sentenceState: 'unplay', playingWord: -1 })

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
    //    `setData({ error: '' })`，搬走之后漏了它的话，
    //    症状是「重试成功了，红框还挂在那儿」。
    return playAudioUrl(src, what, () =>
      // ⚠️ 播完把三个播放标记都清掉：喇叭 / 逐词 / 试听共用播放器，谁先停都要回到「没在播」
      this.setData({ playingWord: -1, sentenceState: 'unplay', replayState: 'unplay' }),
      // ⭐ segment：只播这个词那一段（见 onPlayWord）
      segment,
    ).then(() => {
      if (this.data.error) this.setData({ error: '' })
    })
  },


  /**
   * ⭐ 进页面就**后台预拉取**这一段的标准音（整句 + 逐词）。
   *
   * ⚠️ 预拉取只影响"快不快"，不影响"能不能"：
   *    失败时 ensureLocalAudio 会退回远端地址，用户照样能听，只是慢一点。
   */
  prefetchStandardAudio() {
    if (!this.data.canPlayAudio || !this.data.fullAudio) return
    const kind = this.data.audioKind
    const items: { src: string | null | undefined; kind: 'cloud' | 'http' }[] = [
      { src: this.data.fullAudio, kind },
    ]
    /**
     * ⚠️ 只有**老内容**（没有词级时间戳）才需要预拉逐词音 —— 那种情况下点词播的是
     *    一个个预切文件。新内容点词是在**同一条整句音频**上定位，整句到了就够了。
     * ⚠️ 上限 MAX_PREFETCH_WORDS：长句不至于一次发几十个请求。
     */
    if (this.wordTimes.length === 0) {
      for (const w of this.wordAudio.slice(0, MAX_PREFETCH_WORDS)) items.push({ src: w, kind })
    }
    prefetchAudio(items)
  },

  /** ⭐ 卡片右上角那个喇叭：播整句标准音 */
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
    // 取音途中再点 = 忽略（还没出声）
    if (st === 'loading') return

    this.setData({ playingWord: -1, replayState: 'unplay', sentenceState: 'loading' })
    const url = await ensureLocalAudio(this.data.fullAudio, this.data.audioKind)
    if (!url) {
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
   * ⭐ 点某个词听它的发音。
   *
   * ⚠️ 下标由 **dataset** 带来（WXML 里 data-i），不能靠遍历 words 现找 ——
   *    词的文本可能重复（"the" 在一句里出现两次），按文本找必然指向错的那个。
   */
  async onPlayWord(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    if (!Number.isInteger(i) || i < 0) return

    // ⭐ 首选：在**整句标准音**上定位到这个词的区间播放（一条音频，不再预切 N 个文件）
    const seg = this.wordTimes[i]
    if (seg) {
      if (!this.data.fullAudio) return
      this.setData({ playingWord: i, sentenceState: 'unplay', replayState: 'unplay' })
      const url = await ensureLocalAudio(this.data.fullAudio, this.data.audioKind)
      if (!url) {
        this.setData({ error: '标准音取不到，请稍后再试' })
        return
      }
      this.playUrl(url, '单词发音', seg).catch((err: Error) => this.setData({ error: err.message }))
      return
    }

    // ⚠️ 兜底：老内容没有 words[]（或条数对不上）⇒ 退回预切的单词音频
    const fileId = this.wordAudio[i]
    if (!fileId) return
    this.setData({ playingWord: i, sentenceState: 'unplay', replayState: 'unplay' })
    const url = await ensureLocalAudio(fileId, this.data.audioKind)
    if (!url) {
      this.setData({ error: '单词发音取不到，请稍后再试' })
      return
    }
    this.playUrl(url, '单词发音').catch((err: Error) => this.setData({ error: err.message }))
  },

  stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  // ⚠️ 「公开我的录音」开关已经搬到结果页（pages/challenge 的 onTogglePublic）——
  //    提交之后才问，而提交之后用户已经在那一页上了。

  // ----------------------------------------------------------------
  // 提交检测
  // ----------------------------------------------------------------
  async onSubmit() {
    const { audioPath, durationMs, articleId, phase, isPublic } = this.data
    if (!audioPath) return
    if (phase === 'submitting') return // 连点会重复上传（服务端有幂等，但白烧一次上传流量）

    // ⚠️ 这里**不拦「加入过没有」**：身份（openid）是静默拿到的，而服务端在
    //    每个业务接口前按 openid 取用户、没有就建一行（middleware/auth.ts）。
    //    本页可以被分享 / 扫码直接打开，那些人也一样 —— 先让他读。
    //    昵称 / 头像只是榜上显示成什么，不是任何功能的前置条件。

    // ⭐ 本地预检 —— 刻意极度宽松：放行垃圾的成本极低，误伤用户的成本是流失。
    //    这里只拦「明显没录上」，真正的语音检测在引擎侧。
    if (durationMs < PREFLIGHT.minDurationMs) {
      this.setData({
        error: `录音太短（${(durationMs / 1000).toFixed(1)} 秒），至少要说满 ${PREFLIGHT.minDurationMs / 1000} 秒`,
      })
      return
    }

    this.setData({ phase: 'submitting', error: '', uploadPercent: 0, scoringSeconds: 0, restored: false })

    try {
      const { audioKey, audioUrl } = await uploadAudio(audioPath, {
        articleId,
        onProgress: (p) => this.setData({ uploadPercent: p }),
      })

      // ⭐ 只受理，不等打分（打分要 10–20 秒，见 lib/api/client.ts 的注释）
      // ⚠️ 回传的是**当初点进来的那一天**，不是今天：
      //    历史挑战的「再次挑战」必须归到那一天，否则昨天那张卡片的数字会变。
      // ⚠️ 不传 isPublic —— 提交时**不问**用户，用服务端默认值（false）落库，
      //    结果页再给开关（见 pages/challenge 的 onTogglePublic）。
      void isPublic
      const task = await submitReading(articleId, audioKey, this.scheduleDate, audioUrl)
      // ⭐ 记住它：结果页那个「公开我的录音」开关要靠它去改
      this.submissionId = task.submissionId
      if (task.status === 'failed') {
        this.setData({ phase: 'recorded', error: task.error ?? '检测失败，请重录' })
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
      if (e.code === 'ENERGY_EXHAUSTED') {
        const p = e.payload as { energy?: number } | undefined
        this.setData({
          phase: 'recorded',
          error: '能量不够了（还差 ' + Math.max(0, 2 - (p?.energy ?? 0)) + ' 点）—— 明天会补到 3 点，也可以充值',
        })
      } else {
        this.setData({ phase: 'recorded', error: e.message })
      }
    }
  },

  /**
   * ⭐ 轮询打分结果 —— 直到服务端给出终态（scored / failed）。
   *
   * ⚠️⚠️ 这里**刻意没有「最多等 N 秒」的上限**。
   *    上限等于给句子长度设限：句子更长、引擎更慢，终会撞上去，
   *    而撞上去的表现是「用户永远拿不到分」—— 这是最糟的失败方式。
   *    终止条件是**服务端的终态**，而服务端保证它会到达终态：
   *      · 打完 → scored
   *      · 引擎拒绝 → failed
   *      · 进程死了 → 心跳停 → 下一轮轮询接管重跑，重跑次数用尽则 failed
   *    所以这个 for(;;) 一定会结束，而不是靠客户端掐时间。
   *
   * ⚠️ 每轮都检查 phase：用户中途点了「重录」或退出页面就立刻停下，
   *    不能在后台一直空转轮询。
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
      if (this.data.phase !== 'submitting') return

      let st
      try {
        st = await fetchSubmissionStatus(submissionId)
        failedPolls = 0
      } catch (err) {
        failedPolls++
        console.warn('[reading] 轮询失败 ' + failedPolls + ' 次：' + (err as Error).message)
        if (failedPolls >= 5) {
          this.setData({
            phase: 'recorded',
            error: '网络不稳定，暂时取不到打分结果。分数仍在云端计算，回到首页就能看到。',
          })
          return
        }
        continue
      }

      this.setData({ scoringSeconds: Math.round((Date.now() - startedAt) / 1000) })
      if (st.status === 'scored' && st.result) {
        this.applyResult(st.result)
        return
      }
      if (st.status === 'failed') {
        this.setData({ phase: 'recorded', error: st.error ?? '检测失败，请重录' })
        return
      }
    }
  },

  /**
   * ⭐ 云端权威结果到手的这一刻：写 store、刷新上一页、**切到简版结果反馈**。
   *
   * ⚠️ 不再自动跳走：刚读完那一下用户只想看到多少分、一句点评、接下来干嘛，
   *    所以这一屏停在原地，详情由他自己点「查看详情」进 pages/challenge。
   * ⚠️ 顺序不能换：store 与刷新必须在这里做完 —— 用户可能直接点「再次挑战」离开，
   *    那时再想补写就没有机会了（首页会一直停在旧数据上）。
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

    // ⭐⭐ 拿到分数 = 这段录音**已经被消费掉了**，本地这份必须清。
    //
    //    ⚠️ 结果屏上有「试听」，但它播的是**服务端那份录音**（见 pages/challenge）；
    //       而本机这段录音是**反滥用**要防的东西（隔天点一下提交就能白拿 streak），
    //       所以离开这一页时就清掉 —— 见 onUnload 的说明。

    /**
     * ⭐ 切到**简版结果反馈** —— 这一屏只有：大号总分 + AI 一句话点评 + AI 建议，
     *    外加「再次挑战 / 查看详情」两个按钮。
     *
     * ⚠️ 为什么不再自动跳走：刚读完那一下用户要的是「多少分、哪儿不行、接下来干嘛」，
     *    而详情（五个分项、逐词上色、榜单）属于「我想再研究一下」—— 由他自己点进去。
     * ⚠️ 状态先落好再让用户操作：onUnload 靠 phase === 'done' 判断
     *    这次录音已经被消费掉了（见那一段说明）。
     */
    this.setData({
      phase: 'done',
      error: '',
      scoreText: formatScore(result.score),
      // ⚠️ 拿不到就是空串（没配大模型 / 那次调用失败）—— 界面上整块不渲染，
      //    而不是显示一个空标签（那看起来像坏了）。
      aiComment: result.aiComment ?? '',
      aiAdvice: result.aiAdvice ?? '',
    })
  },

  /**
   * 「查看详情」—— 详细结果在 pages/challenge（分项 / 逐词 / 榜单 / 分享）。
   *
   * ⚠️ 用 redirectTo 而不是 navigateTo：从详情页返回应该回到**进入朗读页之前**那一页
   *    （首页 / 竞技场 / 我的挑战），而不是退回来对着一个已经交掉的录音界面。
   */
  onOpenDetail() {
    const url = CHALLENGE_PAGE + '?sid=' + encodeURIComponent(this.submissionId)
    wx.redirectTo({ url, fail: () => wx.reLaunch({ url }) })
  },

  /**
   * 「再次挑战」—— 另开一次干净的朗读（同一句、算今天）。
   * ⚠️ 也用 redirectTo：这一页手上那段录音已经交掉了，留着它没有任何意义。
   */
  onChallengeAgain() {
    const url = '/pages/reading/reading?id=' + this.data.articleId + '&date=' + today()
    wx.redirectTo({ url, fail: () => wx.reLaunch({ url }) })
  },


  /**
   * 重录（录完之后那个「重录」按钮）。
   *
   * ⚠️ 必须**一起清掉缓存**：用户的意图就是「不要这一段了」。
   *    不清的话，下次再进这一页又会被恢复回来 —— 点重录等于没点。
   */
  onAgain() {
    // ⚠️ 只清**这一句**的槽位：别的句子的录音不该被连坐
    if (this.recordingKey) clearLastRecording(this.recordingKey)
    this.setData({
      phase: 'ready',
      error: '',
      restored: false,
      audioPath: '',
      playPath: '',
      durationMs: 0,
      words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
    })
  },

  // ⚠️ 这里原来有个 onBack()（结果屏的「返回」按钮用的）——
  //    结果屏搬去 pages/challenge 之后，返回按钮也跟着走了：
  //    那一页要应付「从分享链接直接打开」的情况（栈里只有它自己），
  //    所以回退逻辑应当跟结果屏在一起。

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

/** 读取本地缓存的语速基准（没有或异常时回落到默认值） */
function loadMsPerWord(): number {
  try {
    const v = Number(wx.getStorageSync(MS_PER_WORD_KEY))
    if (Number.isFinite(v) && v >= MPW_MIN && v <= MPW_MAX) return v
  } catch {
    /* 读不到就用默认值 */
  }
  return DEFAULT_MS_PER_WORD
}

// ⚠️ 这里原来有个 formatUntil()（把 ISO 时间转成「还有 6 小时 12 分」），
//    是给「24 小时滚动冷却」写提示语用的。
//    冷却下线之后，服务端直接给**还有多少秒**（retryAfterSec），
//    端侧不再需要把时间戳换算成人话 —— 少一处会算错的日期逻辑。
