import { formatScore } from '@jushuo/shared'
import type { ScoreParts } from '@jushuo/shared'

import { partHint, renderParts, type DimensionView } from '../../lib/score-parts'
import { renderWordColors } from '../../lib/word-colors'

/**
 * ⭐⭐ **出分面板**（prd §7.2，用户 2026-10 定）—— 一次检测出结果之后的那块浮层。
 *
 * ## 两种状态，只有一处不同
 *
 * | | **更新** | **保留** |
 * |---|---|---|
 * | 分数色 | 绿 | 橙 |
 * | 胶囊 | 「更新战绩: 前高 → 新分」 | 「保留战绩: 前高」（**不显示本次分**） |
 * | 下句 | 「超越前高 {新−前高} 分，🍪 +N」 | 「本次未能超越」 |
 *
 * ⭐ **其余完全一样** —— 尤其是**五维与逐词高亮两态都要有**：
 *    设计稿里"保留"那张漏画了逐词，那是设计稿不严谨（用户明确过）。
 *
 * ## ⚠️⚠️ 它与「确认」是两件事
 *
 * 出分 ⇒ 入口**立刻**变 「scored」；面板**弹不弹、忽略还是关掉，都不影响那个状态**。
 * 用户随时可以**再点一次**把面板叫回来（prd §7.2：这两者不耦合）。
 * ⭐ **只有按了「确认」才算数** —— 那一下才写参与记录、才清语音（服务端 confirm）。
 *
 * ## 五维与逐词都来自公共 lib
 *
 * ⚠️ 绝不能在这里另写一份渲染口径：「lib/score-parts.ts」 与 「lib/word-colors.ts」
 *    是「我的挑战」列表与本面板**共用**的那一份。
 *    ⚠️ 尤其**不要拿引擎那四维**（accuracy/fluency/standard/integrity）顶替五维 ——
 *       总分不按它们等权算，摆在一起用户对不上（"我准确度 91，为什么总分 85"）。
 */
/**
 * ⚠️ **差值的写法**：整数不显示 `.0` —— 用户给的两张图上写的是「超越前高**5**分」，
 *    而不是「5.0 分」。（分数本身一律走 `formatScore` 保留一位；唯独"差了多少"照图去尾零。）
 */
function deltaText(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

Component({
  options: { virtualHost: true },

  properties: {
    /** 'update' = 新分超越前高；'keep' = 没超越（保留前高） */
    state: { type: String, value: 'update' },
    /** 这一把的分数 */
    score: { type: Number, value: 0 },
    /** 前高（< 0 = 没有前高，这是第一次） */
    previousBest: { type: Number, value: -1 },
    /** 五个分项（服务端 SubmitResponse.parts） */
    parts: { type: Object },
    /** 参考原文 —— 逐词上色要用 */
    text: { type: String, value: '' },
    /** 逐词评分（服务端 SubmitResponse.words） */
    words: { type: Array, value: [] },
    /** 这一把的饼干（< 0 = 不给这个字段，整行不渲染） */
    cookies: { type: Number, value: -1 },
    /** AI 教练的一句话（可能没有） */
    aiComment: { type: String, value: '' },
    /** 这一把录音多长（毫秒）—— 头部那格显示成 00:23（稿 12px） */
    durationMs: { type: Number, value: 0 },
  },

  data: {
    scoreText: '',
    /** 00:23 */
    durationText: '00:00',
    /** 超越前高多少分（一位小数） */
    deltaText: '',
    /** 胶囊里那句话 */
    pillText: '',
    /** 下句那句话 */
    subText: '',
    dims: [] as DimensionView[],
    hint: '',
    wordViews: [] as { i: number; text: string; cls: string }[],
  },

  observers: {
    'state, score, previousBest, parts, text, words, cookies, durationMs'() {
      const state = this.data.state === 'keep' ? 'keep' : 'update'
      const score = Number(this.data.score) || 0
      const prev = Number(this.data.previousBest)
      const hasPrev = prev >= 0
      const parts = this.data.parts as ScoreParts | undefined

      const total = Math.max(0, Math.floor((Number(this.data.durationMs) || 0) / 1000))
      const mm = Math.floor(total / 60)
      const ss = total % 60
      this.setData({
        durationText: (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss,
        scoreText: formatScore(score),
        /**
         * ⚠️ 「更新」才谈"超越了多少" —— 「保留」时**不显示本次分、也不算差**：
         *    那是同一件事的两种说法，写出来只会让用户以为自己退步了。
         */
        deltaText: state === 'update' && hasPrev ? formatScore(score - prev) : '',
        /**
         * 胶囊文案（**照用户 2026-10-15 给的两张图**，一份一份对过）：
         *   · 更新：「更新战绩: {前高} → {新分}」
         *   · 保留：「保留最佳战绩: {前高}」—— ⚠️ **只写前高**，不写本次分、不给箭头
         *     （写出来只会让用户以为自己退步了；图上就是这么写的）
         *   · 第一份（没有前高）：「更新战绩: {新分}」，下句「第一份战绩」
         */
        pillText:
          state === 'update'
            ? hasPrev
              ? '更新战绩: ' + formatScore(prev) + ' → ' + formatScore(score)
              : '更新战绩: ' + formatScore(score)
            : '保留最佳战绩: ' + formatScore(hasPrev ? prev : score),
        subText:
          state === 'update'
            ? hasPrev
              ? '超越前高' + deltaText(score - prev) + '分' + this.cookieSuffix()
              : '第一份战绩' + this.cookieSuffix()
            : '这次发挥不如之前，继续加油',
        dims: renderParts(parts),
        hint: partHint(parts),
        wordViews: renderWordColors(this.data.text, this.data.words as never).map((w, i) => ({
          i,
          text: w.text,
          cls: w.cls ?? '',
        })),
      })
    },
  },

  methods: {
    /** ⚠️ 饼干为 0 / 没有这个字段时**不画 「+0」** —— 屏幕上永远不出现"0 🍪"（prd §7.6） */
    cookieSuffix(): string {
      const c = Number(this.data.cookies)
      return c > 0 ? '，🍪 + ' + c : ''
    },
    /** 去结果页看完整明细（分项 / 逐词 / 榜单） */
    onDetail() {
      this.triggerEvent('detail')
    },
    /** ⭐⭐ 确认 —— **唯一真正的结算**（服务端才写参与记录、才清语音） */
    onConfirm() {
      this.triggerEvent('confirm')
    },
  },
})
