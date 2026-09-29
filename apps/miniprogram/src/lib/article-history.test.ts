import { describe, expect, it } from 'vitest'
import type { ArticleRecordsResponse } from '@jushuo/shared'

import { historyRowsOf, historySummaryOf } from './article-history'

/**
 * ⭐ 朗读页「历史挑战」列表的行 —— 纯函数，所以能在这里直说口径。
 *
 * ⚠️ 这些断言盯的是**三件容易写错的事**（各自都有过事故形状）：
 *   · 免掉当前这一次（判据是提交 id，不是时间/分数）；
 *   · 「最高」在**免掉之后**的这批里现算（服务端那个 bestScore 含当前这次）；
 *   · 分数只走 shared 的 formatScore（别的屏也是一位小数）。
 */

/** 固定一个"现在"，否则相对时间只能断言"包含分钟前"这种废话 */
const NOW = new Date('2026-09-21T12:00:00+08:00').getTime()

/**
 * ⚠️ 这一组用例盯的是**行**（免掉当前这一次、最高现算），与摘要卡那三个数无关 ⇒
 *    名次/人数/最低分给一组无关紧要的缺省值即可（摘要卡自己有单独一组用例）。
 */
function resOf(items: ArticleRecordsResponse['items'], bestScore: number | null): ArticleRecordsResponse {
  return { items, bestScore, attempts: items.length, rank: null, participantCount: 0, lowestScore: null }
}

const item = (
  submissionId: string,
  score: number,
  seq: number,
  createdAt: string,
  scheduleDate: string | null = '2026-09-21',
): ArticleRecordsResponse['items'][number] => ({
  submissionId,
    // ⚠️ 夹具跟着契约走：status 必填（未出分那次也会出现在列表里）
    status: 'scored' as const,
  score,
  seq,
  createdAt,
  scheduleDate,
  isPublic: false,
})

describe('historyRowsOf —— 朗读页的历史挑战列表', () => {
  it('免掉当前这一次，其余按服务端给的顺序（最近在前）', () => {
    const res = resOf(
      [
        item('s3', 89.46, 3, new Date(NOW - 5 * 60_000).toISOString()),
        item('s2', 71, 2, new Date(NOW - 26 * 60 * 60_000).toISOString()),
        item('s1', 64.2, 1, new Date(NOW - 3 * 24 * 60 * 60_000).toISOString()),
      ],
      89.46,
    )

    const { rows, attempts, bestScoreText } = historyRowsOf(res, 's3', NOW)

    expect(rows.map((r) => r.submissionId)).toEqual(['s2', 's1'])
    expect(attempts).toBe(2)
    // ⚠️ 一位小数（89.5 而不是 89.46）：和朗读页大号分数同一口径
    expect(rows[0]?.scoreText).toBe('71.0')
    expect(rows[0]?.seq).toBe(2)
    // 相对时间按北京时间算：昨天 10:00（NOW 是 09-21 12:00）
    expect(rows[0]?.ago).toBe('昨天 10:00')
    expect(rows[1]?.ago).toBe('09-18 12:00')
    expect(rows[1]?.scheduleDate).toBe('2026-09-21')
  })

  it('「最高」在免掉当前这一次之后现算 —— 当前这条最高时，最高要换人', () => {
    const res = resOf(
      [
        item('s2', 91, 2, new Date(NOW - 60_000).toISOString()),
        item('s1', 70, 1, new Date(NOW - 120_000).toISOString()),
      ],
      // 服务端说 91 是最高（它算的是**全部**记录，含当前这次）
      91,
    )

    const { rows, bestScoreText } = historyRowsOf(res, 's2', NOW)

    expect(bestScoreText).toBe('70.0')
    expect(rows.map((r) => r.isBest)).toEqual([true])
  })

  it('并列最高两行都标 —— 问的是"哪些次是我的最好水平"', () => {
    const res = resOf(
      [item('a', 80, 1, new Date(NOW - 60_000).toISOString()), item('b', 80, 2, new Date(NOW - 90_000).toISOString())],
      80,
    )
    expect(historyRowsOf(res, '', NOW).rows.map((r) => r.isBest)).toEqual([true, true])
  })

  it('一次都没读过（或只剩当前这一次）→ 空列表、没有最高分', () => {
    expect(historyRowsOf(resOf([], null), '', NOW)).toEqual({ rows: [], attempts: 0, bestScoreText: '', lowestScoreText: '' })

    const only = resOf([item('s1', 88, 1, new Date(NOW).toISOString())], 88)
    expect(historyRowsOf(only, 's1', NOW)).toEqual({ rows: [], attempts: 0, bestScoreText: '', lowestScoreText: '' })
    // ⚠️ 没有要免的那一条时它照常出现（进入页面还没提交过 = 不该凭空少一条）
    expect(historyRowsOf(only, '', NOW).rows).toHaveLength(1)
  })

  it('parse 不了的提交时间 → 时间那一格是空串，不画 Invalid Date', () => {
    const res = resOf([item('s1', 60, 1, '不是时间')], 60)
    expect(historyRowsOf(res, '', NOW).rows[0]?.ago).toBe('')
  })
})

/**
 * ⭐ 朗读页「我的参与」摘要卡 —— 与历史行的**口径差别**是这里唯一要盯的事：
 *    行免掉"当前这一次"，而这张卡说的是"我在这一句上的全部"（含这一把）。
 */
describe('historySummaryOf —— 我的参与摘要卡（挑战 / 最高 / 位列 / 最低）', () => {
  it('四个数各就各位（位列带参与人数，同 participations 的口径）', () => {
    const res: ArticleRecordsResponse = {
      /**
       * ⚠️⚠️ **我自己的三次**（81 / 41 / 62）。
       *    注意 `lowestScore: 55` 是**全场**最低分，与"我的最低"（41）**故意不同** ——
       *    这条用例就是盯住用户 2026-09 报的那个不一致：
       *    卡片写 82.4 而列表里明明有 65.0，因为原来取错了字段（全场 ≠ 我的）。
       */
      items: [
        item('s3', 62, 3, new Date(NOW - 60_000).toISOString()),
        item('s2', 41, 2, new Date(NOW - 120_000).toISOString()),
        item('s1', 81, 1, new Date(NOW - 180_000).toISOString()),
      ],
      attempts: 3,
      bestScore: 89.456,
      rank: 2,
      participantCount: 18,
      lowestScore: 55,
    }
    expect(historySummaryOf(res)).toEqual({
      attemptsText: '3 次',
      bestScoreText: '89.5',
      rankText: '2 / 18',
      // ⚠️ **我的**最低分（41），不是全场的（55）
      lowestScoreText: '41.0',
    })
  })

  it('⚠️ 一次都没读过 → 0 次 + 三个破折号（不写 0 分 / 第 0 名）', () => {
    const res: ArticleRecordsResponse = {
      items: [],
      attempts: 0,
      bestScore: null,
      rank: null,
      participantCount: 0,
      lowestScore: null,
    }
    expect(historySummaryOf(res)).toEqual({
      attemptsText: '0 次',
      bestScoreText: '—',
      rankText: '—',
      lowestScoreText: '—',
    })
  })

  it('⚠️ 名次 0（服务端对"没参与过"会给 0）必须显示成 —，不能出现「0 / 5」', () => {
    const res: ArticleRecordsResponse = {
      items: [],
      attempts: 0,
      bestScore: null,
      rank: 0,
      participantCount: 5,
      lowestScore: 60,
    }
    expect(historySummaryOf(res).rankText).toBe('—')
  })
})
