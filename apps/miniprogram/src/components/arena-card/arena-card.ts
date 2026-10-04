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
 *    （原先把「灰」写死成 text-faint 的地方，现在改成对 currentColor 降透明度）。
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

Component({
  properties: {
    /** 'featured' | 'list' */
    mode: { type: String, value: 'list' },
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
  },

  observers: {
    entry(entry: Entry | null | undefined) {
      // ⚠️ 带上 articleId：theme 为空时按 id 复算，而不是兜品牌色
      const t = resolveTheme(entry?.theme ?? null, entry?.articleId)
      this.setData({ bg: t.background, fg: t.foreground })
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
    onStart() {
      const e = this.data.entry as Entry | null
      // ⚠️ 不再带 date（2026-09 统一「句子类响应不带日期」）：挑战归哪一天由服务端决定
      this.triggerEvent('start', { articleId: e?.articleId })
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
