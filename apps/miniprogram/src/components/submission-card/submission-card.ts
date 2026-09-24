import type { ArticleTheme } from '@jushuo/shared'
import { resolveTheme } from '@jushuo/shared'

/**
 * ⭐ 提交卡 —— 一次提交（submission）的两种呈现。
 *
 *   · bar  —— 「我的挑战」列表里的一行（页面 pages/me/challenges）
 *   · card —— 挑战结果页的整张结果卡（页面 pages/challenge），内容由页面通过 slot 放进
 *
 * ⚠️ 配色来自 theme（bar 取 row.theme；card 取页面传进来的 theme）：
 *    根节点给 background / color，内部一律 currentColor + 透明度。
 * ⚠️ theme 缺失 → 按 row.articleId 复算（见 shared/theme.ts 的 resolveTheme）；
 *    连 id 都没有的临时行才退回品牌色。
 *
 * 事件：bar 模式抛 play（点播放）/ open（点这一行），页面据此处理。
 */

interface Row {
  submissionId?: string
  /** ⭐ theme 为空时按它复算主题（页面 toRow 已带上） */
  articleId?: string
  words?: { i: number; text: string; cls: string }[]
  ago?: string
  scoreText?: string
  verdict?: string
  failed?: boolean
  theme?: ArticleTheme | null
}

Component({
  properties: {
    /** 'bar' | 'card' */
    mode: { type: String, value: 'bar' },
    row: { type: Object },
    theme: { type: Object },
    playing: { type: Boolean, value: false },
    /** 正在取音（还没出声）—— 播放钮显示 loading */
    loading: { type: Boolean, value: false },
    index: { type: Number, value: 0 },
  },

  data: {
    bg: '#ffffff',
    fg: '#111111',
  },

  observers: {
    'row, theme'(row: Row | null | undefined, theme: ArticleTheme | null | undefined) {
      const t = resolveTheme(theme ?? row?.theme ?? null, row?.articleId)
      this.setData({ bg: t.background, fg: t.foreground })
    },
  },

  methods: {
    onPlay() {
      this.triggerEvent('play', { index: this.data.index })
    },
    onOpen() {
      this.triggerEvent('open', { index: this.data.index })
    },
  },
})
