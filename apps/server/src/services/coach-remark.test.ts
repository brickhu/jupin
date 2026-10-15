import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseCoachReply } from './coach'

const SRC = readFileSync(new URL('./coach.ts', import.meta.url), 'utf-8')
/** 剥注释 —— 否则"解释这条规则的注释"会自己触发断言 */
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

/** 一条够长的锐评（≥40 字） */
const GOOD =
  '这一句连读绝了，有硅谷高管内味儿，全场气势拉满！唯一的缺点就是 accept 吞音了，导致气势弱了半截。'

/**
 * ⭐⭐ 守的是**AI 锐评**这条口径（prd §7.2b，用户 2026-10-15 重新定义）。
 *
 * ⚠️⚠️ 它原来是「4–8 字短语 + 2-3 句练法」两个字段，而且**存了但谁也看不到**
 *    （显示它的 `pages/reading` 已删、没有任何接口返回它）。现在它是一句锐评，
 *    展示在**竞技场页**（这一句上我最好那一把）。
 */
describe('AI 锐评', () => {
  it('⭐ 解析：留着标点（锐评本来就要感叹号），只去包裹引号与换行', () => {
    const r = parseCoachReply(JSON.stringify({ comment: '「' + GOOD + '」' }))
    expect(r?.comment).toBe(GOOD)
    expect(r?.comment.includes('！'), '标点被削掉了 —— 那是"4-8 字短语"时代的口径').toBe(true)
  })

  it('⭐ 太短的不收（<40 字 = 模型又写成了一句短语）', () => {
    expect(parseCoachReply(JSON.stringify({ comment: '发音很稳' }))).toBeNull()
  })

  it('⭐ 超长的截到 70 字（版位只有两行）', () => {
    const long = '好'.repeat(200)
    expect(parseCoachReply(JSON.stringify({ comment: long }))?.comment.length).toBe(70)
  })

  it('⚠️ 不合法 / 空一律 null（端侧整块不渲染，绝不影响成绩落库）', () => {
    expect(parseCoachReply('不是 JSON')).toBeNull()
    expect(parseCoachReply(JSON.stringify({ comment: '' }))).toBeNull()
    expect(parseCoachReply(JSON.stringify({}))).toBeNull()
  })

  it('⭐⭐ 产出**只有一个字段**（advice 已删 —— 讯飞报告已经很全面）', () => {
    expect(CODE.includes('advice'), 'advice 又回来了 ⇒ 同一件事两处（用户明确说不要）').toBe(false)
    expect(CODE.includes('aiAdvice')).toBe(false)
  })

  it('⭐⭐ 提示词必须：用上句子语境 + 点名具体词/音 + 禁止编排名', () => {
    expect(CODE.includes('translation'), '没把译文喂给模型 ⇒ 出不来"内味儿"那种话').toBe(true)
    expect(CODE.includes('tags')).toBe(true)
    expect(CODE.includes('点名具体的词或音'), '没要求点名 ⇒ 会退化成"发音有待提高"').toBe(true)
    expect(CODE.includes('名次'), '没禁止名次断言 ⇒ 模型会编"全场MVP"（它看不到榜单）').toBe(true)
  })

  it('⭐ 温度要够高（0.4 那档出来的是教科书腔）', () => {
    expect(CODE.includes('temperature: 0.8'), '温度又调回保守值了').toBe(true)
  })

  it('⭐ 语气跟分数走（三档）', () => {
    for (const k of ['>= 85', '>= 60']) {
      expect(CODE.includes(k), '少了分数档 ' + k + ' ⇒ 40 分与 95 分会拿到同一种腔调').toBe(true)
    }
  })
})
