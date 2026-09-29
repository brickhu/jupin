import { describe, expect, it } from 'vitest'

import {
  clampLimit,
  filterByTags,
  onlineAtOf,
  parseLevels,
  parseList,
  pickLatestArticles,
  sortByParticipants,
} from './article-list'

/** 造一条候选：publishedAt 传 null 表示老数据（走 createdAt 兜底） */
function row(articleId: string, publishedAt: string | null, createdAt = '2026-01-01T00:00:00Z') {
  return {
    articleId,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    createdAt: new Date(createdAt),
  }
}

/**
 * ⚠️ 这些用例守的是首页「最新上线」那一段的规则（见 article-list.ts）。
 *    写错的后果都是静默的：多一张卡、少一张卡、或者顺序不对 ——
 *    页面照常渲染，只有人盯着看才发现。
 */
describe('最新上线的挑选（数据源：句库，按上线时间倒序）', () => {
  it('⭐ 剔除今日那一句（它就在上面那张卡里，再列一次是同一个榜单看两遍）', () => {
    const rows = [row('5', '2026-03-05'), row('4', '2026-03-04'), row('3', '2026-03-03')]
    expect(pickLatestArticles(rows, '4', 20).map((r) => r.articleId)).toEqual(['5', '3'])
  })

  it('⭐ 按 publishedAt 倒序（新上线的在前），与输入的先后无关', () => {
    const rows = [row('2', '2026-02-01'), row('9', '2026-09-01'), row('5', '2026-05-01')]
    expect(pickLatestArticles(rows, '999', 20).map((r) => r.articleId)).toEqual(['9', '5', '2'])
  })

  it('⭐ publishedAt 为 null 时用 createdAt 兜底（老数据不能掉队）', () => {
    const rows = [
      row('a', null, '2026-12-01T00:00:00Z'), // 老数据，但入库很晚 ⇒ 应排最前
      row('b', '2026-06-01T00:00:00Z'),
    ]
    expect(pickLatestArticles(rows, null, 20).map((r) => r.articleId)).toEqual(['a', 'b'])
  })

  it('上线时间相同时用 id 倒序兜底（顺序必须确定）', () => {
    const rows = [row('2', '2026-01-01T00:00:00Z'), row('9', '2026-01-01T00:00:00Z')]
    expect(pickLatestArticles(rows, null, 20).map((r) => r.articleId)).toEqual(['9', '2'])
  })

  it('超过上限就截断', () => {
    const rows = [row('1', '2026-01-01'), row('2', '2026-01-02'), row('3', '2026-01-03'), row('4', '2026-01-04')]
    expect(pickLatestArticles(rows, '999', 2)).toHaveLength(2)
  })

  it('今日那句为 null 时不剔除任何东西', () => {
    expect(pickLatestArticles([row('1', '2026-01-01')], null, 20)).toHaveLength(1)
  })

  it('空句库不炸', () => {
    expect(pickLatestArticles([], '1', 20)).toEqual([])
  })

  it('onlineAtOf 把 null 一律算成 createdAt', () => {
    const at = new Date('2026-07-01T00:00:00Z')
    expect(onlineAtOf({ publishedAt: null, createdAt: at })).toBe(at.getTime())
  })
})

/* ------------------------------------------------------------------ */
/*                    通用句库查询：参数解析 / 筛选 / 排序                  */
/* ------------------------------------------------------------------ */

describe('parseList —— 逗号分隔参数', () => {
  it('缺省与空串都是「没筛」（不是"找一个空标签"）', () => {
    expect(parseList(undefined)).toEqual([])
    expect(parseList('')).toEqual([])
    expect(parseList(' , , ')).toEqual([])
  })

  it('去空白、去重、保序', () => {
    expect(parseList(' 励志 , 旅行 ,,励志 ')).toEqual(['励志', '旅行'])
  })
})

describe('parseLevels —— 难度参数', () => {
  it('只认 0..3 的整数；认不出的丢掉（不报错、也不筛错档）', () => {
    expect(parseLevels('0,2')).toEqual([0, 2])
    expect(parseLevels('abc,9,-1,1.5,1')).toEqual([1])
    expect(parseLevels(undefined)).toEqual([])
  })

  it('去重', () => {
    expect(parseLevels('3,3,0,0')).toEqual([3, 0])
  })
})

describe('clampLimit —— 数量收窄', () => {
  it('缺省 / 空 / 认不出 → 默认值（NaN 绝不能漏下去）', () => {
    expect(clampLimit(undefined, 50)).toBe(50)
    expect(clampLimit('', 50)).toBe(50)
    expect(clampLimit('abc', 50)).toBe(50)
  })

  it('clamp 到 [1, max]', () => {
    expect(clampLimit('0', 50)).toBe(1)
    expect(clampLimit('-3', 50)).toBe(1)
    expect(clampLimit('5', 50)).toBe(5)
    expect(clampLimit('3.9', 50)).toBe(3)
    expect(clampLimit('999', 50, 100)).toBe(100)
  })
})

describe('filterByTags —— 多个标签是「任一命中」', () => {
  const rows = [
    { tags: ['励志', '旅行'] },
    { tags: ['美食'] },
    { tags: [] },
    { tags: null },
  ]

  it('空 tags = 不筛（原样返回，而不是筛出空标签的）', () => {
    expect(filterByTags(rows, [])).toHaveLength(4)
  })

  it('任一命中（OR）：选 A、B 两个标签 = 两类都想看', () => {
    expect(filterByTags(rows, ['励志', '美食'])).toEqual([{ tags: ['励志', '旅行'] }, { tags: ['美食'] }])
  })

  it('精确匹配标签，不做子串匹配', () => {
    expect(filterByTags(rows, ['励'])).toEqual([])
  })
})

describe('sortByParticipants —— 参与人数倒序', () => {
  const rows = [
    { articleId: 'a', publishedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
    { articleId: 'b', publishedAt: new Date('2026-02-01'), createdAt: new Date('2026-02-01') },
    { articleId: 'c', publishedAt: new Date('2026-03-01'), createdAt: new Date('2026-03-01') },
  ]

  it('人数多的在前', () => {
    const counts = new Map([['a', 1], ['b', 9], ['c', 5]])
    expect(sortByParticipants(rows, counts).map((r) => r.articleId)).toEqual(['b', 'c', 'a'])
  })

  it('人数相同用上线时间兜底（顺序必须确定，不能随查询计划跳）', () => {
    const counts = new Map([['a', 3], ['b', 3], ['c', 3]])
    expect(sortByParticipants(rows, counts).map((r) => r.articleId)).toEqual(['c', 'b', 'a'])
  })

  it('缺人数（没参与过）当 0，不是 undefined 排在中间', () => {
    expect(sortByParticipants(rows, new Map([['b', 2]])).map((r) => r.articleId)).toEqual(['b', 'c', 'a'])
  })
})
