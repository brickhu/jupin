import { describe, expect, it } from 'vitest'

import { weightedPick } from './recommend'

/**
 * ⭐ **匿名推荐的抽样规则**（用户 2026-09 定的口径：初级档里随机、参与人数多的更容易中）。
 *
 * ⚠️ 只测纯函数 weightedPick —— pickAnonymousArticle 那一层要连库，交给 e2e / 手测。
 *    把抽样规则抽成纯函数就是为了这里能把边界钉死（特别是"总权重为 0"那一支）。
 */
describe('weightedPick —— 加权随机（匿名今日卡）', () => {
  it('空集合 → null（调用方据此报"句库为空"）', () => {
    expect(weightedPick([], [])).toBeNull()
  })

  it('总权重为 0 → 等概率，而不是永远挑第一条', () => {
    const items = ['a', 'b', 'c']
    // rng 0 → 第一条；0.999 → 最后一条；0.5 → 中间那条
    expect(weightedPick(items, [0, 0, 0], () => 0)).toBe('a')
    expect(weightedPick(items, [0, 0, 0], () => 0.5)).toBe('b')
    expect(weightedPick(items, [0, 0, 0], () => 0.999)).toBe('c')
  })

  it('参与人数多的更容易被抽中：权重 [0,10] 时永远命中第二条', () => {
    expect(weightedPick(['冷', '热'], [0, 10], () => 0)).toBe('热')
    expect(weightedPick(['冷', '热'], [0, 10], () => 0.5)).toBe('热')
    expect(weightedPick(['冷', '热'], [0, 10], () => 0.999)).toBe('热')
  })

  it('权重相同时按 rng 落在哪一段决定（[1,1]：<0.5 第一条、≥0.5 第二条）', () => {
    expect(weightedPick(['a', 'b'], [1, 1], () => 0.24)).toBe('a')
    expect(weightedPick(['a', 'b'], [1, 1], () => 0.75)).toBe('b')
  })

  it('负权重当 0 处理（脏数据不该让抽样炸掉）', () => {
    expect(weightedPick(['a', 'b'], [-5, 3], () => 0)).toBe('b')
  })

  it('rng 取到 1（越界）时兜到最后一条，不会返回 undefined', () => {
    expect(weightedPick(['a', 'b'], [1, 1], () => 1)).toBe('b')
  })
})
