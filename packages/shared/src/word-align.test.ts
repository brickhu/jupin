import { describe, expect, it } from 'vitest'

import { alignWordScores } from './word-align'

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
