import { describe, expect, it } from 'vitest'
import type { ArticleRecordsResponse } from '@jushuo/shared'

import { historyRowsOf } from './article-history'

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

function resOf(items: ArticleRecordsResponse['items'], bestScore: number | null): ArticleRecordsResponse {
  return { items, bestScore, attempts: items.length }
}

const item = (
  submissionId: string,
  score: number,
  seq: number,
  createdAt: string,
  scheduleDate: string | null = '2026-09-21',
): ArticleRecordsResponse['items'][number] => ({
  submissionId,
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
    expect(historyRowsOf(resOf([], null), '', NOW)).toEqual({ rows: [], attempts: 0, bestScoreText: '' })

    const only = resOf([item('s1', 88, 1, new Date(NOW).toISOString())], 88)
    expect(historyRowsOf(only, 's1', NOW)).toEqual({ rows: [], attempts: 0, bestScoreText: '' })
    // ⚠️ 没有要免的那一条时它照常出现（进入页面还没提交过 = 不该凭空少一条）
    expect(historyRowsOf(only, '', NOW).rows).toHaveLength(1)
  })

  it('parse 不了的提交时间 → 时间那一格是空串，不画 Invalid Date', () => {
    const res = resOf([item('s1', 60, 1, '不是时间')], 60)
    expect(historyRowsOf(res, '', NOW).rows[0]?.ago).toBe('')
  })
})
