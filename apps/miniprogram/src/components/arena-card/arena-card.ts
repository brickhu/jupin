import type { ArticleTheme } from '@jushuo/shared'
import { resolveTheme } from '@jushuo/shared'

/**
 * ⭐ 金句卡片 —— 首页（今日 / 历史）与竞技场的句子卡共用。
 *
 * 2 种 mode：
 *   · featured —— 今日推荐：大字句子 + 译文 + 独立 CTA（可选）
 *   · list     —— 历史推荐：小一号句子，无译文、无 CTA
 *
 * ⚠️ 配色全部来自 entry.theme：
 *    根节点设 background / color，内部元素一律 currentColor + opacity 分层
 *    （原先把「灰」写死成 text-page-on_50 的地方，现在改成对 currentColor 降透明度）。
 * ⚠️ theme 缺失（老内容）→ resolveTheme 按 articleId 复算（不是品牌色）。
 *
 * 事件：open（点卡片）/ play（点播放）/ start（点 CTA），页面据此处理。
 */

interface Entry {
  articleId: string
  header?: boolean
  text?: string
  translation?: string
  audio?: { full: string; kind: 'cloud' | 'http' } | null
  /**
   * ⭐ **我自己那一段录音**（参与区那颗试听钮播的就是它，不是标准音）。
   * ⚠️ 与上面的 `audio`（标准音）**是两段不同的东西**：
   *    标准音回答"这句话该怎么念"，我自己的录音回答"我刚才读成什么样"。
   */
  recordAudio?: { full: string; kind: 'cloud' | 'http' } | null
  /** 标准音时长（毫秒）—— 交给 audio-button 统一格式化成 00:05 */
  durationMs?: number
  stat?: string
  /**
   * ⚠️ 这里原来有一个 `note`（今日卡那行「为什么给你推这一句」，来自服务端 reason）——
   *    2026-09 删掉（用户：那是选取规则 = 工作备注，不该给用户看）。
   *    字段与渲染都删了：留着"永远为空的备注位"只会诱人再往里塞一句话。
   */
  action?: string
  hint?: string
  theme?: ArticleTheme | null
}

/**
 * ⚠️ 切词：**按空格切，并让每个词后面带一个空格**（除了最后一个）。
 *    理由与朗读页那段逐词渲染完全一样：`<text>` 会保留空格，
 *    而并列 `<text>` 在小程序里会被当**块**排 —— 所以间距要靠**词自带的空格**，
 *    不能指望 margin（见 reading.wxml 的长注释）。
 */
function splitWords(text: string): string[] {
  const parts = text.split(' ').filter((w) => w.length > 0)
  return parts.map((w, i) => (i === parts.length - 1 ? w : w + ' '))
}

Component({
  properties: {
    /**
     * ⭐⭐ **两种尺寸**（prd §7.2，2026-10 定）：`lg` / `sm`。
     *   · `lg` = 首页今日挑战 / 详情页 —— **含参与区**（5 态）+ 点词发音
     *   · `sm` = 最近更新等列表 —— **点整卡进详情页**参与
     * ⚠️ 两种尺寸**都显示译文**（旧 `list` 的"无译文"作废）。
     */
    size: { type: String, value: '' },
    /**
     * @deprecated 旧的 `featured` / `list` —— 保留只为不一次性改掉 4 个调用点。
     *   `featured` → `lg`、`list` → `sm`。新代码请用 `size`。
     */
    mode: { type: String, value: '' },
    /**
     * ⭐ 这一句的**参与状态**（`lib/record-state.ts` 的五态）。
     * ⚠️ 卡片**不自己算**它 —— 状态来自"端侧那段没提交的录音"+"服务端参与记录/提交状态"
     *    两个不同的地方，只有页面拿得到（见 record-state.ts 的说明）。
     */
    state: { type: String, value: 'try' },
    /** 参与区要显示的分数（`retry` = 战绩、`scored` = 这一把）；< 0 表示没有 */
    score: { type: Number, value: -1 },
    /**
     * ⭐ 画不画**参与区**。
     *
     * ⚠️⚠️ 默认 false，**必须页面显式打开** —— 因为参与区的动作
     *    （弹 recorder / 漏读粗筛 / energy-tips / 开面板）**都在页面里**。
     *    卡片自己画一颗胶囊而页面没接 `mic` 事件 = 用户点了一颗**没反应的按钮**，
     *    这比"暂时没有这颗按钮"糟得多。
     * ⇒ 页面把状态算好、事件接好之后，再置 true（见 prd §7.2 的迁移顺序）。
     */
    showRecord: { type: Boolean, value: false },
    /**
     * ⭐ **我那段录音的时长**（毫秒）—— 参与区那颗试听显示成 00:33。
     * ⚠️ 与 `entry.durationMs`（**标准音**的时长）不是一回事，别混：
     *    标准音的时长回答"这句话该怎么念"，这个回答"我刚才读了多久"。
     */
    recordDurationMs: { type: Number, value: 0 },
    entry: { type: Object },
    /** 这张卡的标准音是不是正在播 */
    playing: { type: Boolean, value: false },
    /** 正在取音（还没出声）—— 播放钮显示 loading */
    loading: { type: Boolean, value: false },
    /**
     * ⭐ 卡片头右上角画不画「收藏」—— 只在**朗读挑战页**要（用户 2026-09 要求：
     *    卡片左上播放参考音频、右上收藏这一句）。
     * ⚠️ 默认 false：首页那些卡片整张是「点进详情」的目标，再挂一颗心会互相误触。
     */
    showFavorite: { type: Boolean, value: false },
    /** 当前收没收藏这一句（页面从鉴权接口取的，不是卡片自己猜的） */
    favorite: { type: Boolean, value: false },
    /**
     * ⭐ 收藏按钮**旁边那个数字**（多少人收藏了这一句）—— 来自公开的
     *    `GET /api/stats/favorite-count`，由页面写进全局 store、再传进来。
     *
     * ⚠️ 0（或还没拉到）**不画**：一颗心旁边挂个 `0` 是噪音，
     *    与参与概要那条"0 人参与时写实话、不写 0"同一个口径。
     * ⚠️ 只有 `showFavorite` 时才会渲染 —— 首页那些卡没有收藏按钮，
     *    自然也没有这个数（它们的 showFavorite 是 false）。
     */
    favoriteCount: { type: Number, value: 0 },
  },

  data: {
    bg: '#ffffff',
    fg: '#111111',
    /** ⭐ 解析出来的尺寸（'lg' | 'sm'）—— 由 size/mode 两个入口归一 */
    resolved: 'sm' as 'lg' | 'sm',
    /**
     * ⭐ **逐词**（只在 `lg` 上渲染，为了点词发音）。
     * ⚠️ 切词必须与朗读页**同一口径**：那边是 `plainWordsOf(text)`，
     *    这里按空格切 —— 句子是英文、以空格分词，切出来与它逐词一致。
     * ⚠️ 词与词之间**靠左边那个词后面带一个空格**（text 保留空格），不靠 margin
     *    —— 这与朗读页的排法一致（见 reading.wxml 那段长注释）。
     */
    words: [] as string[],
  },

  observers: {
    'entry, size, mode'(entry: Entry | null | undefined) {
      // ⚠️ 带上 articleId：theme 为空时按 id 复算，而不是兜品牌色
      const t = resolveTheme(entry?.theme ?? null, entry?.articleId)
      const size = this.data.size === 'lg' || this.data.size === 'sm'
        ? this.data.size
        : this.data.mode === 'featured' ? 'lg' : 'sm'
      this.setData({
        bg: t.background,
        fg: t.foreground,
        resolved: size,
        // ⚠️ 切词只在 lg 上做（sm 不点词，省一次解析）
        words: size === 'lg' ? splitWords(entry?.text ?? '') : [],
      })
    },
  },

  methods: {
    onOpen() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('open', { articleId: e?.articleId })
    },
    onPlay() {
      const e = this.data.entry as Entry | null
      // ⚠️ audio 一起带上：页面不用再去自己的 data 里反查是哪一张卡
      this.triggerEvent('play', { articleId: e?.articleId, audio: e?.audio ?? null })
    },
    /**
     * ⭐ 参与区里那颗「试听**我自己的**录音」—— 与上面 onPlay（标准音）分开报。
     * ⚠️ 不合并成同一个事件：它们播的是两段音频（一个是标准音、一个是我读的），
     *    页面要分别维护"谁在播"（同时播两个就变成了双声道）。
     */
    onPlayRecord() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('playRecord', { articleId: e?.articleId, audio: e?.recordAudio ?? null })
    },
    onStart() {
      const e = this.data.entry as Entry | null
      // ⚠️ 不再带 date（2026-09 统一「句子类响应不带日期」）：挑战归哪一天由服务端决定
      this.triggerEvent('start', { articleId: e?.articleId })
    },
    /**
     * ⭐ 点麦克风（`try` 整颗胶囊 / `retry` 那颗圆钮）—— 页面据此**弹 recorder 面板**。
     * ⚠️ 卡片刻意**不认识 recorder**：录音面板是页面级的浮层，
     *    卡片的职责只是"告诉页面用户按了录音"（见 prd §7.2）。
     */
    onMic() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('mic', { articleId: e?.articleId })
    },
    /** ⭐ `recoded` 的重录 —— 语义与 onMic 相同（都是"再录一遍"），但分开报，便于页面统计/区分 */
    onRedo() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('redo', { articleId: e?.articleId })
    },
    /** ⭐ `recoded` 的 ✓ —— 页面据此走"漏读粗筛 → energy-tips"（prd §7.2） */
    onConfirm() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('confirm', { articleId: e?.articleId })
    },
    /** ⭐ `scored` 点右边那颗分数/› —— 页面据此**再开一次出分面板**（可反复，直到确认） */
    onScorePanel() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('panel', { articleId: e?.articleId })
    },
    /**
     * ⭐ **点词发音**（只在 `lg` 上）—— 页面调 `lib/audio/tts.ts` 的 `speak()`。
     * ⚠️ 整句走的是我们自己的标准音（"这句话怎么念"）；点词走 TTS（"这个词怎么念"）——
     *    两者刻意不同（见 tts.ts 的文件头）。
     */
    onWord(e: WechatMiniprogram.TouchEvent) {
      const word = (e.currentTarget as { dataset?: { w?: string } })?.dataset?.w ?? ''
      if (!word) return
      this.triggerEvent('word', { word })
    },
    /**
     * ⭐ 点右上角那颗心 —— 收藏的是**这一句**（与"我读没读过"无关）。
     * ⚠️ catchtap（WXML 上）而不是 bindtap：整张卡是「点进详情」的目标，
     *    不拦住冒泡的话，点收藏会顺手把人送进详情页。
     */
    onFavorite() {
      const e = this.data.entry as Entry | null
      this.triggerEvent('favorite', { articleId: e?.articleId })
    },
  },
})
