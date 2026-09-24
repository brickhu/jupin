import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_WEIGHTS,
  LEVEL_LABEL,
  LEVEL_ORDER,
  difficultyFromScores,
  normalizeLevel,
  normalizeScores,
  weightedScoreOf,
} from './level'

describe('档位（四档：0 初级 / 1 中级 / 2 高级 / 3 专家）', () => {
  it('四档都认得出来，中文标签与顺序对得上', () => {
    for (const d of LEVEL_ORDER) expect(normalizeLevel(d)).toBe(d)
    expect(LEVEL_ORDER).toEqual([0, 1, 2, 3])
    expect(LEVEL_ORDER.map((d) => LEVEL_LABEL[d])).toEqual(['初级', '中级', '高级', '专家'])
  })

  it('数字字符串也认 —— JSON 被人手改过之后很容易变成字符串形式的档位', () => {
    expect(normalizeLevel('0')).toBe(0)
    expect(normalizeLevel('3')).toBe(3)
  })

  it('旧正文里的 easy/medium/hard 走显式映射（老内容还在 CDN 上）', () => {
    expect(normalizeLevel('easy')).toBe(0)
    expect(normalizeLevel('medium')).toBe(1)
    // ⚠️ hard → 2（高级）而不是 3（专家）：专家是新开的档，不替老内容升格
    expect(normalizeLevel('hard')).toBe(2)
  })

  // ⚠️ 刻意钉死：认不出时补一个默认值，会让**没评过级**的句子看起来评过级
  it('认不出的一律 null，绝不补默认档位', () => {
    for (const v of [undefined, null, '', 'EASY', 'easy ', 'Hard', 4, -1, 1.5, '10', '-1', {}, [], 'medium2', '初', true]) {
      expect(normalizeLevel(v)).toBeNull()
    }
  })
})

/**
 * ⭐ 三个判据分 → 一个档位 —— **这是全项目唯一的算术**。
 *
 * ⚠️⚠️ 下面几个用例不是随便挑的数：它们是**用户给的锚点句**算出来的分。
 *    锚点能不能落位，全看这段公式；所以钉在这里，而不是钉在提示词里
 *    （提示词是「让模型给对分」，公式是「分对了就一定对档」）。
 * ⚠️ 边界一律**左闭右开**：2.0 → 中级、3.0 → 高级、4.0 → 专家。
 */
describe('判据分 → 档位（词汇×5 + 发音×4 + 长度×1，除 10）', () => {
  it('权重是 [词汇, 发音, 长度] = [5, 4, 1]（改动它 = 全库档位都要重跑）', () => {
    expect(DIFFICULTY_WEIGHTS).toEqual([5, 4, 1])
  })

  it('加权分与档位对得上', () => {
    const cases: Array<[number[], number, number]> = [
      // [词汇, 发音, 长度]          加权分  档位
      [[1, 1, 1], 1.0, 0],   // 全最低 → 初级
      [[1, 2, 1], 1.4, 0],   // 「Don't count the days, make the days count.」
      [[2, 1, 2], 1.6, 0],   // 「The best way to predict the future is to invent it.」
      [[3, 2, 3], 2.6, 1],   // 「Although the internet has made it easier…」
      [[2, 4, 2], 2.8, 1],   // FDR 那句 —— **必须是中级**（用户明确不接受专家）
      [[4, 3, 3], 3.5, 2],   // 「Companies that fail to adapt…」
      [[5, 4, 4], 4.5, 3],   // 「The assumption that human behavior is governed…」
      // ⚠️ 绕口令：词汇 2（高中）+ 发音 5 ⇒ 3.2 —— **必须还是中级**
      //    （用户 2026-09：我定的五档里，高中词汇也到不了高级）
      [[2, 5, 2], 3.2, 1],
      [[5, 5, 5], 5.0, 3],   // 全满仍是专家的上限
    ]
    for (const [scores, score, level] of cases) {
      expect(weightedScoreOf(scores), JSON.stringify(scores) + ' 的加权分').toBe(score)
      expect(difficultyFromScores(scores), JSON.stringify(scores) + ' 的档位').toBe(level)
    }
  })

  it('切分点是 2.5 / 3.5 / 4.5（等价于「score 四舍五入到整数」）', () => {
    expect(weightedScoreOf([3, 2, 2])).toBe(2.5)
    expect(difficultyFromScores([2, 3, 1])).toBe(0) // 2.3 → 初级
    expect(difficultyFromScores([3, 2, 2])).toBe(1) // 2.5 → 中级
    expect(difficultyFromScores([3, 3, 3])).toBe(1) // 3.0 → 中级
    expect(difficultyFromScores([4, 3, 3])).toBe(2) // 3.5 → 高级
    expect(difficultyFromScores([4, 4, 4])).toBe(2) // 4.0 → 高级
    expect(difficultyFromScores([5, 4, 4])).toBe(3) // 4.5 → 专家
  })

  it('三个分必须是 1–5 的整数，认不出就是 null（绝不补齐、绝不夹到边界）', () => {
    for (const v of [
      undefined, null, [], [1, 2], [1, 2, 3, 4], [0, 3, 3], [6, 3, 3], [1.5, 3, 3],
      ['1', '2', 'x'], {}, '333', true,
    ]) {
      expect(normalizeScores(v), JSON.stringify(v) + ' 应当认不出').toBeNull()
      expect(difficultyFromScores(v), JSON.stringify(v) + ' 不应当有档位').toBeNull()
    }
    // ⚠️ 数字字符串认：JSON 被人手改过一轮之后很容易变成字符串
    expect(normalizeScores(['1', '2', '3'])).toEqual([1, 2, 3])
  })
})
