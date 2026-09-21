/**
 * ⭐ 一句话的总分 —— 权重来自**校准实验**，不是拍的。
 *
 * 依据：docs/research/scoring-standard.md（同一句的母语级 TTS vs 8 段真实录音）
 *
 * ══════════════════════════════════════════════════════════════════
 * 实测「母语级 − 学习者」的差距（差距越大越能区分好坏）：
 *
 *   standard（韵律） 48.4  ⭐ 最强 —— 而讯飞只给它 0.1 权重
 *   最差词          44.3  ⭐ 词级里最强的不是平均，是**最差的那个**
 *   accuracy        26.1
 *   fluency         21.8
 *   词均            15.5
 *   integrity        2.1  ← 能读完的人几乎恒为 100，只配当门槛
 *
 * 行业口径也是这么分的：雅思把「发音（含语调重音）」给 25%；
 * Azure 把 Prosody（重音/语调/语速/节奏）单列一维。
 * 讯飞的 (0.6×acc + 0.3×flu + 0.1×std) 恰恰把最能区分的排在最后。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 纯函数、零依赖：这类规则最容易错在边界上，必须能在 Node 里逐条钉住
 *    （见 scoring.test.ts）。
 */
import { WORD_GREEN_LINE } from './constants/index'

/** 权重 —— 改这里就是改标准，别在别处再抄一份 */
export const SCORE_WEIGHTS = {
  /** 韵律/标准度：最能区分「像不像人话」 */
  prosody: 0.35,
  /** 发音短板：绿词比 + 最差的那个词 */
  weakness: 0.3,
  /** 发音准确：引擎 accuracy + 音节检错率 */
  accuracy: 0.15,
  /** 流利：引擎 fluency + 自算的长停顿 */
  fluency: 0.15,
  /** 完整：只占一点点，主要靠门槛（见 GATE_INCOMPLETE） */
  completeness: 0.05,
} as const

/** 有漏读/替换等硬错误时的封顶分 —— 句子没读完整，谈不上「说得好」 */
export const GATE_INCOMPLETE = 79
/** 判定「长停顿」的阈值（毫秒）—— 单个句子内部，词间超过它就是一次卡顿 */
const LONG_GAP_MS = 400

export interface ScorableWord {
  score: number
  /** 增漏信息；拿不到时按 normal 处理 */
  dp?: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
}

export interface SentenceSignals {
  /** 引擎的句子级四维 */
  accuracy?: number
  fluency?: number
  standard?: number
  integrity?: number
  /** 音节级检错率 0..1（引擎没返回 syll 时为 undefined） */
  syllableErrorRate?: number
  /** 词间长停顿的**次数** */
  longGapCount?: number
  /** 最长的一次词间停顿（毫秒） */
  longestGapMs?: number
}

export interface ScoreBreakdown {
  /** 最终分（0–100 整数） */
  score: number
  /** 五个分项，各自 0–100 —— 给诊断/展示用 */
  prosody: number
  weakness: number
  accuracy: number
  fluency: number
  completeness: number
  /** 被门槛压下来的原因（空数组 = 没触发） */
  gates: string[]
}

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v))

/** 从词级时间戳里找词间停顿 —— 引擎不给，得自己算 */
export function speechGaps(words: { startMs: number; endMs: number }[]): {
  longGapCount: number
  longestGapMs: number
} {
  let longGapCount = 0
  let longestGapMs = 0
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i] as { startMs: number }).startMs - (words[i - 1] as { endMs: number }).endMs
    if (!Number.isFinite(gap) || gap <= 0) continue
    if (gap > longestGapMs) longestGapMs = gap
    if (gap > LONG_GAP_MS) longGapCount++
  }
  return { longGapCount, longestGapMs }
}

/**
 * 算一句话的总分（含分项，便于解释）。
 *
 * @returns 词级数据为空时返回 null —— 那种情况说明这次返回没有可用数据，
 *          调用方应退回引擎总分，而不是给 0 分（0 分会被当成「读了一整句全错」）。
 */
export function scoreSentence(words: ScorableWord[], signals: SentenceSignals = {}): ScoreBreakdown | null {
  if (words.length === 0) return null

  const scores = words.map((w) => (Number.isFinite(w.score) ? w.score : 0))
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const green = scores.filter((v) => v >= WORD_GREEN_LINE).length
  const greenRatio = green / scores.length
  const worst = Math.min(...scores)

  // ---- ① 韵律（35%）：引擎的 standard。⚠️ 音高起伏（pitch）还没接，见文档 ----
  const prosody = clamp100(signals.standard ?? mean)

  // ---- ② 发音短板（30%）：绿词比一半 + 最差词一半 ----
  const weakness = clamp100(0.5 * (greenRatio * 100) + 0.5 * worst)

  // ---- ③ 发音准确（15%）：accuracy 七成 + 音节没读错的比率三成 ----
  const syllOk =
    signals.syllableErrorRate === undefined ? undefined : clamp100(100 - signals.syllableErrorRate * 100)
  const accuracy = clamp100(
    syllOk === undefined ? (signals.accuracy ?? mean) : 0.7 * (signals.accuracy ?? mean) + 0.3 * syllOk,
  )

  // ---- ④ 流利（15%）：fluency 七成 + 停顿三成 ----
  const gapPenalty = Math.min(
    40,
    10 * (signals.longGapCount ?? 0) + Math.max(0, (signals.longestGapMs ?? 0) - LONG_GAP_MS) / 50,
  )
  const fluency = clamp100(0.7 * (signals.fluency ?? mean) + 0.3 * (100 - gapPenalty))

  // ---- ⑤ 完整（5%）----
  const completeness = clamp100(signals.integrity ?? 100)

  let score =
    SCORE_WEIGHTS.prosody * prosody +
    SCORE_WEIGHTS.weakness * weakness +
    SCORE_WEIGHTS.accuracy * accuracy +
    SCORE_WEIGHTS.fluency * fluency +
    SCORE_WEIGHTS.completeness * completeness

  /**
   * ⭐ 门槛：有硬错误（漏读/增读/回读/替换）就封顶。
   * ⚠️ 这是「读得准不准」这条主线的兜底 —— 允许「平均分高但读错了一个词」拿到高分，
   *    等于告诉用户读错词不要紧（实测：把 predict 读成 protect，引擎的词级分只掉一点点）。
   */
  const gates: string[] = []
  const hardErrors = words.filter((w) => w.dp !== undefined && w.dp !== 'normal').length
  if (hardErrors > 0 && score > GATE_INCOMPLETE) {
    score = GATE_INCOMPLETE
    gates.push('有 ' + hardErrors + ' 个词读错/漏读，封顶 ' + GATE_INCOMPLETE)
  }

  return {
    score: Math.round(clamp100(score)),
    prosody: Math.round(prosody),
    weakness: Math.round(weakness),
    accuracy: Math.round(accuracy),
    fluency: Math.round(fluency),
    completeness: Math.round(completeness),
    gates,
  }
}


export function sentenceScore(words: ScorableWord[], signals: SentenceSignals = {}): number | null {
  return scoreSentence(words, signals)?.score ?? null
}
