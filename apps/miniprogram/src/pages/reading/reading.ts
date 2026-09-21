import { AUDIO_SPEC, MS_PER_WORD, PREFLIGHT, pcmToWav, today } from '@jushuo/shared'
import type { ScoreDimensions, StreakDelta, SubmitResponse } from '@jushuo/shared'

import { PLATFORM } from '../../config'
import {
  ApiError,
  fetchSubmissionStatus,
  getUserId,
  setSubmissionVisibility,
  submitReading,
} from '../../lib/api/client'
import { uploadAudio } from '../../lib/api/upload'
import { Recorder, type RecordResult } from '../../lib/audio/recorder'
import { fetchArticleContent } from '../../lib/content'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import * as me from '../../lib/store'
import { refreshPreviousPage } from '../../lib/refresh-previous'
import {
  clearLastRecording,
  loadLastRecording,
  recordingKeyOf,
  replayPathOf,
  saveLastRecording,
} from '../../lib/audio/last-recording'
import { ensureLocalAudio, prefetchAudio } from '../../lib/audio/standard'

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
 * ⚠️ 提交失败**不都是错误**：冷却（COOLDOWN）是完全正常的业务分支，
 *    必须和真错误区分开，否则用户看到「请求失败」会以为小程序坏了。
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

/** 逐词着色阈值 —— 只影响展示，不影响分数 */
const WORD_GOOD = 85 // ≥ 标绿：读对了
const WORD_BAD = 60 // < 标红：明显有问题

/** 只在开发者工具里为真 */
const IS_DEVTOOLS = PLATFORM === 'devtools'

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
const DIMENSION_META: { key: keyof ScoreDimensions; label: string }[] = [
  { key: 'accuracy', label: '准确度' },
  { key: 'fluency', label: '流利度' },
  { key: 'standard', label: '标准度' },
  { key: 'integrity', label: '完整度' },
]

Page({
  data: {
    /** 根节点要让开的上边距（px）—— 自定义导航栏是浮层，不占文档流（见 lib/nav.ts） */
    navTop: 0,

    articleId: 1,
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
     * ⚠️⚠️ 提交时**不问**用户，提交后由服务端回传权威值（applyResult 里写入）。
     *    在结果页给开关，是因为听完自己的分数再决定「要不要让人听」依据更足；
     *    而提交前横一个开关，等于让每个用户先做一个与「读好这句」无关的决定。
     */
    isPublic: true,

    /**
     * ⭐ 能不能播标准音。
     * ⚠️ 由**内容接口**说了算（它返回云存储 fileID）：没有音频时这里就是 false，
     *    整个播放入口都不渲染 —— 而不是给一个点了没反应的图标。
     */
    canPlayAudio: false,

    /** 整句标准音（fileID 或服务端路径，由 audioKind 决定怎么解释） */
    fullAudio: '',
    /** 'cloud' | 'http' —— 见 ArticleContent.audio 的注释 */
    audioKind: 'http' as 'cloud' | 'http',

    /** 正在播的单词下标；-1 表示没在播单词 */
    playingWord: -1,

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
    uploadPercent: 0,
    /** 已经在打分上等了多久（秒）—— 轮询期间显示，让等待可见 */
    scoringSeconds: 0,

    result: null as SubmitResponse | null,
    /** 本次提交带来的 streak 变化；幂等重放时为 null（不渲染这一块） */
    streak: null as StreakDelta | null,
    gapText: '—',
    /** 四维得分（引擎没返回时为空数组，整块不渲染） */
    dimensions: [] as DimensionView[],
    /** 给四个数字配的一句「所以呢」—— 光有数字用户不知道该练什么 */
    dimensionHint: '',
  },

  recorder: null as Recorder | null,
  audio: null as WechatMiniprogram.InnerAudioContext | null,
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

  /** 逐词标准音的 fileID，下标与 plainWords 一一对应 */
  wordAudio: [] as (string | null)[],
  /**
   * 这次要挑战的是哪一天。
   * ⚠️ 由首页带进来（/pages/reading/reading?id=3&date=2026-09-21），
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
    this.setData({ articleId: Number(query.id) || 1, navTop: navPadTop() })
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
    this.stopTimer()
    if (this.stopWatchdog !== null) {
      clearTimeout(this.stopWatchdog)
      this.stopWatchdog = null
    }
    this.audio?.destroy()
    this.audio = null
  },

  // ----------------------------------------------------------------
  // 内容
  // ----------------------------------------------------------------
  async loadContent() {
    this.setData({ phase: 'loading', error: '' })
    try {
      const content = await fetchArticleContent(this.data.articleId)
      // ⚠️ 词表在前端切：正文的 words[] 要等内容流水线产出（现在是空的），
      //    而逐词着色只需要「词序」，不需要词级时间戳。
      //    ⚠️⚠️ 这条切词规则必须与生成脚本、服务端拼 fileID 的那两处**完全一致** ——
      //       否则点第 3 个词会听到第 4 个词的音，而界面上完全看不出来。
      this.plainWords = content.text.split(/\s+/).filter(Boolean)
      // ⭐ 缓存键由**句子原文 + uid** 决定（不是 articleId）—— 见字段上的说明
      this.recordingKey = recordingKeyOf(content.text, getUserId())
      this.wordAudio = content.audio?.words ?? []
      this.setData({
        translation: content.translation,
        words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
        canPlayAudio: !!content.audio?.full,
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
        onStop: (r) => this.handleRecorded(r),
        onError: (e) => {
          this.stopTimer()
          this.setData({ phase: 'ready', error: e.message })
        },
      })
    }

    this.setData({
      phase: 'recording',
      error: '',
      elapsed: '0.0',
      // ⚠️ 一旦开始录新的，上一段的提示就不该再挂着
      restored: false,
      audioPath: '',
      playPath: '',
      result: null,
      words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
    })

    const startedAt = Date.now()
    this.startedAt = startedAt
    this.timer = setInterval(() => {
      this.setData({ elapsed: ((Date.now() - startedAt) / 1000).toFixed(1) })
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
    // ⚠️ 收到回调就把看门狗撤掉，否则 3 秒后它会误报「没正常结束」
    if (this.stopWatchdog !== null) {
      clearTimeout(this.stopWatchdog)
      this.stopWatchdog = null
    }
    this.stopTimer()

    const playPath = this.writePlayableWav(r.pcm)

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
      //    audioPath → 原始文件，**上传**给对象存储用
      //    playPath  → 加了 WAV 头的副本，**试听**用
      audioPath: r.tempFilePath,
      playPath,
      durationMs: r.durationMs,
      elapsed: (r.durationMs / 1000).toFixed(1),
      error: '',
    })
  },

  /**
   * 把裸 PCM 包上 WAV 头写成可播放文件。
   *
   * ⚠️⚠️ 为什么必须这么做：录音用的是 `format: 'PCM'`，落盘的是**没有文件头的裸 PCM**，
   *    而 `wx.createInnerAudioContext` 只认 mp3 / aac / wav 这类**容器格式**，
   *    直接播录音文件在真机上必然失败。
   *    开发者工具里看不出来（它自己能"调试播放"），所以这个 bug 只在真机暴露。
   */
  writePlayableWav(pcm: ArrayBuffer): string {
    // ⚠️ 路径来自 last-recording 的 replayPathOf(key)，别在这里再写一份字面量 ——
    //    两边各写一份，改路径时必然漏一处，而症状是「试听没声音」，
    //    一个看起来像音频格式问题、其实是路径问题的故障。
    // ⚠️ 内容还没加载出来时没有键 —— 那就没有试听文件可写（也就不会有缓存）
    if (!this.recordingKey) return ''
    const path = replayPathOf(this.recordingKey)
    try {
      const wav = pcmToWav(pcm, AUDIO_SPEC.sampleRate, AUDIO_SPEC.channels, AUDIO_SPEC.bitDepth)
      wx.getFileSystemManager().writeFileSync(path, wav)
      return path
    } catch (err) {
      // 写不出来不该让录音白录 —— 只是不能试听而已，提交照旧
      console.error('[reading] 生成试听文件失败：', (err as Error).message)
      return ''
    }
  },

  /**
   * 试听。
   *
   * ⚠️⚠️ **两个环境要播的不是同一个东西** —— 这是实测出来的，不是猜的：
   *
   *   |            | tempFilePath（录音文件）      | onFrameRecorded（帧）        |
   *   | 开发者工具 | ✅ 工具自己的格式，**真声音**  | ❌ Opus 裸包，按 PCM 读是噪声 |
   *   | 真机       | ❌ 裸 PCM，播放器不认         | ✅ 真 PCM                    |
   *
   *   所以：模拟器播**文件**，真机播**帧拼的 WAV**。
   *
   * ⚠️ 别改成「两个音源按顺序试，播不动就换下一个」——
   *    帧拼出来的 WAV 是**合法可播的**，只是内容为噪声。
   *    「能播」区分不了「播的是对的音频」和「播的是垃圾」，
   *    按"能不能播"兜底一定先播垃圾、且永远不会往下退（模拟器里试听全噪音）。
   */
  async onReplay() {
    const primary = IS_DEVTOOLS ? this.data.audioPath : this.data.playPath
    const fallback = IS_DEVTOOLS ? this.data.playPath : this.data.audioPath
    const src = primary || fallback

    if (!src) {
      this.setData({
        error: this.data.audioPath ? '试听文件没生成成功 —— 请重录' : '还没有录音',
      })
      return
    }

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
        this.setData({ error: (err as Error).message })
        return
      }
      console.warn('[reading] 主音源播不出来，改用备用：' + (err as Error).message)
    }

    try {
      await this.playUrl(fallback as string, '试听')
    } catch (err) {
      this.setData({ error: (err as Error).message })
    }
  },

  /**
   * ⭐ 播一个音频地址 —— **整页共用一个 InnerAudioContext**。
   *
   * ⚠️ 不要每次点击都 createInnerAudioContext：
   *    小程序对同时存在的音频实例数量有限制，反复建而不 destroy，
   *    点到第七八个词就会静默不播。共用一个、播前先 stop，天然只有一个。
   *
   * ⚠️ 不上来就 play() —— 某些机型上 src 还没就绪，play() 会被静默忽略，
   *    表现就是「点了没反应、也不报错」。等 canplay 再播。
   */
  playUrl(src: string, what: string): Promise<void> {
    if (!src) return Promise.reject(new Error('没有音频源'))

    let audio = this.audio
    if (!audio) {
      audio = wx.createInnerAudioContext()
      audio.volume = 1
      audio.onEnded(() => this.setData({ playingWord: -1 }))
      this.audio = audio
    }

    /**
     * ⚠️ 返回 Promise 而不是 void：调用方要能知道「到底是播出来了，还是失败了」。
     *    试听的备用音源逻辑完全依赖这一点（见 onReplay）。
     * ⚠️ 成功以 **onPlay** 为准，不是「设了 src」——
     *    设 src 只是告诉播放器「有这么个东西」。
     */
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      // ⚠️ 每次播放都重挂：这些回调捕获的是**这一次**的状态，
      //    不换掉的话上一次的闭包还会继续跑（表现为「上一次的失败提示又弹出来」）
      audio.offCanplay?.()
      audio.offPlay?.()
      audio.offError?.()

      audio.onCanplay(() => {
        try {
          audio.play()
        } catch {
          // 交给下面的超时兜底
        }
      })
      audio.onPlay(() => settle(() => {
        this.setData({ error: '' })
        resolve()
      }))
      audio.onError((err) => settle(() => {
        // ⚠️ 把 errCode 也带上 —— errMsg 有时很含糊，errCode 才分得清
        //    是「文件不存在」「格式不支持」还是「解码失败」
        console.error('[reading] ' + what + ' 播放失败', err)
        reject(new Error(`${what}失败（${err.errCode}）：${err.errMsg}`))
      }))

      audio.stop()
      audio.src = src
      // ⚠️ 兜底：部分机型不触发 canplay
      setTimeout(() => {
        try {
          audio.play()
        } catch {
          /* ignore */
        }
      }, 300)
      // ⚠️ 兜底：万一 onPlay / onError 都不来，别让调用方永远挂着
      setTimeout(() => settle(resolve), 4_000)
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
    // ⚠️ 逐词音也一起拉：点词听发音是朗读页最常用的动作，
    //    而每个词只有几 KB。但给它一个上限，长句不至于一次发几十个请求。
    for (const w of this.wordAudio.slice(0, MAX_PREFETCH_WORDS)) items.push({ src: w, kind })
    prefetchAudio(items)
  },

  /** ⭐ 卡片右上角那个喇叭：播整句标准音 */
  async onPlaySentence() {
    if (!this.data.fullAudio) return
    this.setData({ playingWord: -1 })
    const url = await ensureLocalAudio(this.data.fullAudio, this.data.audioKind)
    if (!url) {
      this.setData({ error: '标准音取不到，请稍后再试' })
      return
    }
    this.playUrl(url, '标准音').catch((err: Error) => this.setData({ error: err.message }))
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
    const fileId = this.wordAudio[i]
    if (!fileId) return
    this.setData({ playingWord: i })
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

  /**
   * ⭐ 公开 / 不公开这次录音 —— **提交之后**在结果页改。
   *
   * ⚠️ 先乐观更新再发请求，失败回滚：一个开关等两秒才动，
   *    用户会以为坏了并再点一次，而那一次点的是刚翻过来的状态 —— 结果什么都没变。
   */
  async onTogglePublic(e: WechatMiniprogram.SwitchChange) {
    const next = e.detail.value
    const prev = this.data.isPublic
    if (!this.submissionId) return

    this.setData({ isPublic: next })
    try {
      await setSubmissionVisibility(this.submissionId, next)
    } catch (err) {
      // ⚠️ 失败必须回滚开关：显示的和服务端不一致，比操作失败本身更糟 ——
      //    用户会以为「关了」，而其实那段声音还是公开的
      this.setData({ isPublic: prev, error: '设置失败：' + (err as Error).message })
    }
  },

  // ----------------------------------------------------------------
  // 提交检测
  // ----------------------------------------------------------------
  async onSubmit() {
    const { audioPath, durationMs, articleId, phase, isPublic } = this.data
    if (!audioPath) return
    if (phase === 'submitting') return // 连点会重复上传（服务端有幂等，但白烧一次上传流量）

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
      // ⚠️ 不传 isPublic —— 提交时**不问**用户，用服务端默认值落库，
      //    结果页再给开关（见 onTogglePublic）。
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
      // ⚠️ 冷却不是错误，是正常业务分支
      if (e.code === 'COOLDOWN') {
        const until = e.payload?.nextFreeAt
        this.setData({
          phase: 'recorded',
          error:
            typeof until === 'string'
              ? '挑战冷却中，' + formatUntil(until) + ' 后可再次提交'
              : e.message,
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

  /** 云端权威结果：绿 = 读对，红 = 有问题 */
  applyResult(result: SubmitResponse) {
    // ⭐⭐ 把结果写进全局 store —— **这一步就是「提交完返回首页会更新」的保证**。
    //     首页/详情页订阅着它，此刻数据已经是新的了，
    //     不用等 onShow、不用管页面还在不在栈里、也不用再刷新一次网络。
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
    //    ① 留着没有用：结果页**没有试听入口**（试听只在「已录好」那一屏，
    //       即 phase === 'recorded'），留着也点不到。
    //    ② 留着有害：下次进这一句时它会被恢复成「已录好」，
    //       于是用户能把**上一次的录音当成今天的读**再提交一遍 ——
    //       而每次上传的 audioKey 都是新的（makeAudioKey 里带 Date.now()），
    //       服务端按 (userId, audioKey) 幂等，认不出这是同一段声音，
    //       于是隔天点一下「提交检测」就能白拿一天 streak。
    //
    //    ⚠️ 但**只在这一条路径上清**。下面这些路径都不清：
    //      · 提交失败 / 冷却中（catch 分支）
    //      · 轮询连续失败放弃（pollResult）
    //      那些场景用户要的正是「别让我重读一遍」，缓存就是为它们留的。
    if (this.recordingKey) clearLastRecording(this.recordingKey)

    this.setData({
      phase: 'done',
      error: '',
      result,
      // ⚠️ 用服务端回传的值，不是本地猜的：用户可能已经改过，而结果会被反复拉到
      isPublic: result.isPublic,
      // ⚠️ 幂等重放（同一段音频重复提交）不带 streak —— 交给 wx:if 不渲染。
      //    绝不能在端侧自己算一个「+1」补上：那会把「重发一次」显示成「又来读了一天」。
      streak: result.streak ?? null,
      gapText: result.gapToPrev === null ? '已是第一' : result.gapToPrev + ' 分',
      words: this.renderScore(this.plainWords, result.words ?? []),
      dimensions: this.renderDimensions(result.dimensions),
      dimensionHint: this.dimensionHint(result.dimensions),
    })
  },

  /**
   * 四维得分 → 展示视图。
   *
   * ⚠️ 引擎没返回时必须返回空数组，让整块**不渲染** ——
   *    绝不能补 0：界面上出现「完整度 0」会被理解成「我一个词都没读」。
   */
  renderDimensions(d?: ScoreDimensions): DimensionView[] {
    if (!d) return []
    return DIMENSION_META.map(({ key, label }) => {
      const v = d[key]
      const level = v < WORD_BAD ? 'bad' : v < WORD_GOOD ? 'warn' : 'ok'
      return {
        key,
        label,
        value: Number.isInteger(v) ? String(v) : v.toFixed(1),
        pct: Math.max(0, Math.min(100, v)),
        textCls: `text-${level}`,
        barCls: `bg-${level}`,
      }
    })
  },

  /**
   * 给四维得分配一句「所以呢」。
   *
   * ⭐ 为什么值得算这一句：讯飞总分公式里**完整度是乘性因子** ——
   *    「总分低」有两种完全不同的原因：发音不准，或者没读完。
   *    只丢四个数字给用户，他不知道该练哪个；差值才是可行动的信息。
   */
  dimensionHint(d?: ScoreDimensions): string {
    if (!d) return ''
    if (d.integrity < 90) {
      return '完整度偏低：有漏读或增读，总分会被按比例整体拉低 —— 读准 ≠ 读完'
    }
    if (d.accuracy < d.fluency - 10) {
      return '读得挺顺，但准确度明显偏低 —— 先纠发音，别求快'
    }
    if (d.standard < 85) {
      return '标准度偏低：音节、重音与标准音还有差距'
    }
    return ''
  },

  renderScore(plain: string[], scored: SubmitWord[]): WordView[] {
    return plain.map((text, i) => {
      const w = scored[i]
      if (!w) return { i, text, cls: 'text-ink' }
      const cls =
        w.dp !== 'normal' || w.score < WORD_BAD
          ? 'text-bad'
          : w.score >= WORD_GOOD
            ? 'text-ok'
            : 'text-ink'
      return { i, text, cls }
    })
  },

  /**
   * 再来一次 / 重录。
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
      result: null,
      durationMs: 0,
      dimensions: [],
      dimensionHint: '',
      words: this.plainWords.map((text, i) => ({ i, text, cls: 'text-ink' })),
    })
  },

  /**
   * 返回。
   *
   * ⚠️⚠️ 不能直接 `wx.navigateBack()` —— 本页可能**是页面栈里的唯一一页**：
   *      · 开发者工具「编译」时如果正停在朗读页，就是这种情况
   *      · 真机上从分享卡片 / 扫码直达朗读页，也是这种情况
   *    那时 navigateBack 什么都不会发生（栈里没有上一页可回），
   *    用户会被**卡死在朗读页**。
   *
   *    而这正是「提交完返回首页，首页没更新」的真正原因：
   *    首页压根不在栈里，它的 onShow 永远不会触发，
   *    于是没有任何一次「重新拉数据」发生 —— 服务端分数早就写好了，
   *    只是没有任何人去取。
   *
   *    所以栈空时改用 reLaunch：它会**新建**首页，onLoad 天然会重新拉一次。
   */
  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.reLaunch({ url: '/pages/index/index' })
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

/** 把 ISO 时间转成「还有 6 小时 12 分」 */
function formatUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return '现在'
  const totalMin = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
}
