import { describe, expect, it } from 'vitest'

import { alignWordScores, missingWordsOf } from './word-align'

/**
 * ⚠️ 这些断言盯的是**颜色会不会张冠李戴**：
 *    对齐错了不会报错，只会让每个词都有颜色、而颜色是别人的。
 */
describe('alignWordScores —— 引擎词表对齐到参考原文', () => {
  it('一一对应时就是恒等映射', () => {
    const ref = 'The best way to predict the future'
    const eng = ['the', 'best', 'way', 'to', 'predict', 'the', 'future']
    expect(alignWordScores(ref, eng)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('⭐ 中间多出一个插入词：后面的词不能被带偏（实测那条 fil）', () => {
    const ref = 'The best way to predict the future is to invent it.'
    const eng = ['the', 'best', 'way', 'to', 'predict', 'fil', 'the', 'future', 'is', 'to', 'invent', 'it']
    expect(alignWordScores(ref, eng)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11])
  })

  it('漏读一个词：那一位留空（不上色），其余各自对上', () => {
    const ref = 'The best way to predict the future'
    const eng = ['the', 'best', 'to', 'predict', 'the', 'future']
    expect(alignWordScores(ref, eng)).toEqual([0, 1, null, 2, 3, 4, 5])
  })

  it('大小写与标点不影响对齐（The / it. / way,）', () => {
    const ref = 'The way, it.'
    expect(alignWordScores(ref, ['THE', 'way', 'it'])).toEqual([0, 1, 2])
  })

  it('重复词按位置对齐，不会整体前移（the 出现两次）', () => {
    const ref = 'the cat the dog'
    expect(alignWordScores(ref, ['the', 'cat', 'the', 'dog'])).toEqual([0, 1, 2, 3])
  })

  it('引擎什么都没给 / 原文为空：全 null，不抛', () => {
    expect(alignWordScores('', ['the'])).toEqual([])
    expect(alignWordScores('the cat', [])).toEqual([null, null])
  })
})

/**
 * ⭐⭐ 「漏读预检」的判据 —— 盯的是**假阳性**：
 *     学习者读对了、只是 ASR 听岔了，绝不能被判成「没读到」。
 *
 * ⚠️ 下面前两条是 **2026-10 从真实录音里量出来的原话**（9 段录音，假阳性 50% 就是它们造成的）——
 *    不是编的构造用例。用 LCS（alignWordScores 的算法）跑这两条会把 `simpler` 报成漏读。
 */
describe('missingWordsOf —— 只报真缺位，替换/插入一律不算', () => {
  const REF = 'Everything should be made as simple as possible, but not simpler.'
  const w = (s: string) => s.split(/\s+/)

  it('⭐ 实测反例：simpler 被听成 similar（替换）⇒ 不算漏读', () => {
    const hyp = w('Everything should be made as simple as possible, but not similar.')
    expect(missingWordsOf(REF, hyp)).toEqual([])
  })

  it('⭐ 实测反例：simpler 被听成 by the seminar（三处替换）⇒ 不算漏读', () => {
    const hyp = w('Everything should be made as simple as possible by the seminar.')
    expect(missingWordsOf(REF, hyp)).toEqual([])
  })

  it('插入词不算漏读（as simple 多出一个 as）', () => {
    const hyp = w('Everything should be made as simple as possible, but not as simple.')
    expect(missingWordsOf(REF, hyp)).toEqual([])
  })

  it('完整读对 ⇒ 不报任何词', () => {
    expect(missingWordsOf(REF, w(REF))).toEqual([])
  })

  it('⭐ 真的缺一段：连续三个词没了 ⇒ 精确报出那三个下标', () => {
    // 参考：0everything 1should 2be 3made 4as 5simple 6as 7possible 8but 9not 10simpler
    const hyp = w('Everything should be made possible, but not simpler.')
    expect(missingWordsOf(REF, hyp)).toEqual([4, 5, 6])
  })

  it('整句都没读到（转写为空）⇒ 报出所有词', () => {
    expect(missingWordsOf(REF, [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('原文为空 ⇒ 不抛、也不报', () => {
    expect(missingWordsOf('', ['the'])).toEqual([])
  })

  it('⚠️ 与前作的分工：同一输入 alignWordScores 会报「没对上」，这里不报', () => {
    const hyp = w('Everything should be made as simple as possible, but not similar.')
    // 用 LCS 的那套：simpler 那一位对不上 ⇒ null（这正是 50% 假阳性的来源）
    expect(alignWordScores(REF, hyp).filter((x) => x === null)).toHaveLength(1)
    // 换成缺位判据：那一位被解释成「读错」而不是「没读到」
    expect(missingWordsOf(REF, hyp)).toEqual([])
  })
})
