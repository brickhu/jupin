import { describe, expect, it } from 'vitest'

import { ArticleTextImmutableError, assertTextUnchanged } from './article-content'

/**
 * ⭐⭐ **句子不可修改** —— 用户 2026-09 定的产品原则：
 *    `articleId = sha256(text) 前 16 位` ⇒ 改文案**就是另一句**（新 id、新成绩、新历史）。
 *    ⇒ "原地改正文"不是"不允许"，而是**没有意义**：那会制造一条 id 与正文对不上的脏行。
 *
 * ⚠️ 这条判据必须落在**写入层**（saveArticleContent 是内容列的唯一写入函数），
 *    不能靠 admin 路由那条 id 校验顺带挡 —— 它只对规范 id 生效，
 *    历史脏 id 的行会绕过（见 services/article-content.ts 的注释）。
 *
 * ⚠️ 用纯函数单测（不起库）：判据本身是 `existingText === nextText`，
 *    抽出来就是为了能直接测。
 */
describe('句子不可修改 —— 正文是句子的身份', () => {
  it('⭐ 正文一致 → 放行（改译文 / 标签 / 判据分 / 发布状态都走这条路）', () => {
    expect(() => assertTextUnchanged('06ef2b193b83b3d7', 'Hello world.', 'Hello world.')).not.toThrow()
  })

  it('⭐⭐ 正文变了 → 抛 ArticleTextImmutableError，并给出补救做法', () => {
    let caught: unknown
    try {
      assertTextUnchanged('06ef2b193b83b3d7', 'Hello world.', 'Hello there.')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ArticleTextImmutableError)
    expect((caught as Error).message).toContain('句子不可修改')
    // ⚠️ 必须告诉人"接下来怎么做"，否则运营只会卡在这里
    expect((caught as Error).message).toContain('新建')
    expect((caught as Error).message).toContain('下架')
  })

  it('⚠️ 空值等价：历史行 text 为空 / 传 undefined 时不算"改了正文"', () => {
    expect(() => assertTextUnchanged('abc', '', '')).not.toThrow()
    expect(() =>
      assertTextUnchanged('abc', null as unknown as string, ''),
    ).not.toThrow()
    expect(() =>
      assertTextUnchanged('abc', '', undefined as unknown as string),
    ).not.toThrow()
  })

  it('⚠️ 首尾空白不算改（id 用 trim 后的正文算，判据同口径）', () => {
    expect(() => assertTextUnchanged('abc', 'Hello ', 'Hello')).not.toThrow()
    expect(() => assertTextUnchanged('abc', 'Hello', '  Hello  ')).not.toThrow()
  })

  it('⚠️ 内部空白差异**算改** —— hash 会变，那是真的另一句', () => {
    expect(() => assertTextUnchanged('abc', 'Hello world.', 'Hello  world.')).toThrow(
      ArticleTextImmutableError,
    )
  })
})
