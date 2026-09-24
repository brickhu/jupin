import { describe, expect, it } from 'vitest'
import { plainWordsOf } from './tokenize'

/**
 * ⚠️ 这条测试守的是**下标契约**，不是「切词好不好看」：
 *    下标错位在两个方向上都很难发现（点词播放静默退化 / 听到相邻词），
 *    所以规则本身必须被钉住 —— 改它等于改所有内容的对齐口径。
 */
describe('plainWordsOf —— 切词规则的唯一定义', () => {
  it('按空白切，连续空白只算一个分隔', () => {
    expect(plainWordsOf('a  b\tc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('**标点跟着它前面的词**（不能顺手去掉）', () => {
    expect(plainWordsOf("Don't count the days, make the days count.")).toEqual([
      "Don't", 'count', 'the', 'days,', 'make', 'the', 'days', 'count.',
    ])
  })

  it('首尾空白与空串都不产出 token', () => {
    expect(plainWordsOf('   ')).toEqual([])
    expect(plainWordsOf('')).toEqual([])
  })

  it('不改大小写、不做词形还原', () => {
    expect(plainWordsOf('The the THE')).toEqual(['The', 'the', 'THE'])
  })

  it('中文/混排不会被拆开（它只按空白切）', () => {
    expect(plainWordsOf('hello 世界 world')).toEqual(['hello', '世界', 'world'])
  })
})
