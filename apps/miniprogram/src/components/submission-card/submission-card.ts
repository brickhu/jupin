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
    /**
     * ⚠️ 这里原来有 `playing` / `loading` 两个属性（页面传"是不是这一行在播"进来，
     *    再把点击转发给页面去取音播放）—— **2026-09 删掉**：
     *    那套行为现在整个归 `recording-player`（它自己管三态），
     *    而页面也不再需要"正在播的是第几行"这个下标。
     *    ⇒ 别把它们加回来：一旦页面又拿状态回传，"两处各自演化"就回来了。
     */
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
    /**
     * ⭐ 播放钮报错 → 转给页面去说。
     * ⚠️ 这一层**不弹 toast**：同一个组件在别的宿主里可能是页面红条 / 别的说法，
     *    组件只把"发生了什么"往上送（见 recording-player 的事件说明）。
     */
    onAudioError(e: WechatMiniprogram.CustomEvent<{ message?: string }>) {
      this.triggerEvent('audioError', { message: e.detail?.message ?? '播放失败' })
    },
    onOpen() {
      this.triggerEvent('open', { index: this.data.index })
    },
  },
})
