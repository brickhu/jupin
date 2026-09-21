/**
 * ⭐ 一句话的总分 —— **由词级分算出来**，不用引擎给的那个总分。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用引擎的总分：它是**两层平均** ——
 *
 *     total = (0.6×accuracy + 0.3×fluency + 0.1×standard) × integrity
 *
 *   accuracy / fluency / standard 每一个本身已经是「对整句的平均」，
 *   再平均一次，个别词的差异就被抹平了。实测（10 段真实录音）：
 *     · 引擎总分     范围 75~97，σ 7.3
 *     · 词级分本身   范围 56~100（同一段录音里就有 44 分的跨度）
 *   于是「读得一般」和「读得好」经常只差两三分 —— 而排行全靠这个数。
 *
 * 还有一个原因：**fluency 几乎不变**（实测 12 条全在 87.7~98.1），
 *   却占 30% 权重，等于给每个人加了个差不多的常数；integrity 同理（实测恒为 100）。
 * ══════════════════════════════════════════════════════════════════
 *
 * 公式：
 *
 *     score = 50 × 绿词比 + 0.5 × 词均
 *
 *   绿词   = 词级分 ≥ WORD_GREEN_LINE（与界面标绿同一个数，所见即所得）
 *   绿词比 = 绿词数 ÷ 词数
 *
 * ⚠️ 两条性质是**由构造保证**的，不是调出来的：
 *    · 全绿   ⇒ score ≥ 50 + 0.5×85 = 92.5（全读准了本来就该高）
 *    · 全不绿 ⇒ 每个词都 <85 ⇒ 词均 <85 ⇒ score < 42.5
 *
 * ⚠️ 纯函数、零依赖：这类规则最容易错在边界上，必须能在 Node 里逐条钉住
 *    （见 scoring.test.ts）。
 */
import { WORD_GREEN_LINE } from './constants/index'

/** 只要一个 score 字段 —— 不依赖 WordScore 的完整结构，纯函数才好测 */
export interface ScorableWord {
  score: number
}

/**
 * 算一句话的总分。
 *
 * @returns 0–100 的整数；**一个词都没有时返回 null** —— 那种情况说明这次返回
 *          根本没有可用数据，调用方应该退回引擎的总分，而不是给个 0 分
 *          （0 分会被当成「我读了一整句全错」，而真相是「这次没拿到词级数据」）。
 */
export function sentenceScore(words: ScorableWord[]): number | null {
  if (words.length === 0) return null

  let green = 0
  let sum = 0
  for (const w of words) {
    // ⚠️ 拿不到分的词（NaN）按 0 算：它在结果里就是「这个词没读出来」
    const s = Number.isFinite(w.score) ? w.score : 0
    if (s >= WORD_GREEN_LINE) green++
    sum += s
  }

  const mean = sum / words.length
  const score = 50 * (green / words.length) + 0.5 * mean
  return Math.max(0, Math.min(100, Math.round(score)))
}
