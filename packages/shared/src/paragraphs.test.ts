import { describe, expect, it } from 'vitest'
import { splitParagraphs } from './paragraphs'

describe('splitParagraphs —— 拆分是确定性的，段数 = 条数', () => {
  it('空行分段，一段一条', () => {
    expect(splitParagraphs('A one.\n\nB two.\n\nC three.')).toEqual(['A one.', 'B two.', 'C three.'])
  })

  it('多个连续空行只算一次分段（粘过来的文本常常多敲了回车）', () => {
    expect(splitParagraphs('A.\n\n\n\nB.')).toEqual(['A.', 'B.'])
    expect(splitParagraphs('A.\n   \nB.')).toEqual(['A.', 'B.'])
  })

  it('段内的单个换行是硬折行 ⇒ 合成一个空格（否则同一句会算出两个 id）', () => {
    expect(splitParagraphs('The world is like\na mirror.')).toEqual(['The world is like a mirror.'])
    // ⚠️ 这条是 id 的命脉：折过行与没折过行必须给出**同一个** text
    expect(splitParagraphs('The world is like\na mirror.')[0]).toBe(
      splitParagraphs('The world is like a mirror.')[0],
    )
  })

  it('Windows 换行、段内多空格、首尾空白都归一', () => {
    expect(splitParagraphs('  A   one. \r\n\r\n B\ttwo.  ')).toEqual(['A one.', 'B two.'])
  })

  it('空输入 / 只有空白 ⇒ 空数组（不是 [""]）', () => {
    for (const v of ['', '   ', '\n\n', undefined as unknown as string]) {
      expect(splitParagraphs(v)).toEqual([])
    }
  })

  it('不做纠错、不动标点与大小写 —— 那是 LLM 那一步的事', () => {
    expect(splitParagraphs('frown at itand it frowns.')).toEqual(['frown at itand it frowns.'])
  })
})
