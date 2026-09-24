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
  date?: string
  header?: boolean
  text?: string
  translation?: string
  audio?: { full: string; kind: 'cloud' | 'http' } | null
  /** 标准音时长（毫秒）—— 交给 audio-button 统一格式化成 00:05 */
  durationMs?: number
  stat?: string
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
      this.triggerEvent('start', { articleId: e?.articleId, date: e?.date })
    },
  },
})
