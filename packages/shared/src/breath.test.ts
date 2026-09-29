import { describe, expect, it } from 'vitest'

import { breathGroupCount, breathGroupsOf, syllableCount, syllablesPerBreathGroup } from './breath'

/**
 * ⚠️ 这个文件守的是**"句子长度"那条判据的口径**（用户 2026-09 的意见：
 *    原来按词数判不合理，改成按**呼吸群 + 音节**）。
 *
 * ⚠️ 口径本身只有 `breath.ts` 一处实现：提示词喂给模型的三个数、
 *    以及我这边复核，都调它。改了这里就等于改了判据的定义。
 */
describe('呼吸群（breath group）', () => {
  it('按停顿标点切段：, ; : . ! ? … — – 都算停顿', () => {
    expect(breathGroupsOf('a, b; c: d. e! f? g… h— i– j')).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
    ])
  })

  it('括号与引号**不切**（它们不改停顿）', () => {
    // ⚠️ 这句只有一个句末停顿 ⇒ **1 个**呼吸群；括号与引号都不切
    const groups = breathGroupsOf('He said (quietly) "hello there" and left.')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toContain('He said (quietly)')
    expect(groups[0]).toContain('and left')
    // ⚠️ 不逐字符断言：引号里的句点会被遮蔽（见 breath.ts 里那条"已知取舍"），
    //    而标点不是判据的一部分（只数呼吸群与音节）。
  })

  it('括号里的逗号**也不切**（停顿由括号外决定）', () => {
    const groups = breathGroupsOf('He left (quietly, without a word), and she stayed.')
    expect(groups).toHaveLength(2)
    // ⚠️ 括号保持完整；被遮蔽的那个标点不保留（它只用于数音节，不是判据）
    expect(groups[0]).toBe('He left (quietly, without a word)')
    expect(groups[1]).toBe('and she stayed')
  })

  it('真实句子：逗号切两群；冒号分号逗号切成四群', () => {
    expect(breathGroupCount('Everything should be made as simple as possible, but not simpler.')).toBe(2)
    expect(
      breathGroupCount('The world is like a mirror: Frown at it and it frowns at you; smile, and it smiles too.'),
    ).toBe(4)
  })

  it('没有标点 ⇒ 一个呼吸群（这正是"一口气读不完"的那种句子）', () => {
    const t =
      'The precipitous proliferation of gratuitous misinformation has substantially attenuated the epistemic authority of established journalistic institutions.'
    expect(breathGroupCount(t)).toBe(1)
  })

  it('多行输入按行也算停顿', () => {
    expect(breathGroupsOf('first line\nsecond line')).toEqual(['first line', 'second line'])
  })
})

describe('音节数（有词表时用词表，没有就粗估）', () => {
  const words = [
    { text: 'Everything', syllables: ['Every', 'thing'] },
    { text: 'should', syllables: ['should'] },
    { text: 'be', syllables: ['be'] },
  ]

  it('有词表：逐词取 syllables 长度', () => {
    expect(syllableCount('Everything should be', words)).toBe(4)
  })

  it('无词表：按空白切词、每词算 1 拍（宁可粗估也不返回 0）', () => {
    expect(syllableCount('Everything should be')).toBe(3)
  })

  it('各群拍数按呼吸群分开算（"某群超 15 拍"那条修正要靠它）', () => {
    const t = 'Everything should be, made as simple as possible but not simpler.'
    const per = syllablesPerBreathGroup(t)
    expect(per).toHaveLength(2)
    expect(per[0]).toBe(3)
    expect(per[1]).toBeGreaterThan(5)
  })

  it('大小写与标点不影响查表', () => {
    expect(syllableCount('EVERYTHING, should', words)).toBe(3)
  })
})
