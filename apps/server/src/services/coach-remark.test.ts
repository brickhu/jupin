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

  it('⭐ 太短的不收（<24 字 = 模型又写成了一句碎片）', () => {
    expect(parseCoachReply(JSON.stringify({ comment: '发音很稳' }))).toBeNull()
  })

  it('⭐ 短俏皮话要收（比硬凑 40 字好听）', () => {
    const short = 'accept 吞音、θ 也溜了，整句气势全泄，可惜了。'
    expect(short.length).toBeGreaterThanOrEqual(24)
    expect(parseCoachReply(JSON.stringify({ comment: short }))?.comment).toBe(short)
  })

  /**
   * ⚠️⚠️ 这条是**真机实测**逼出来的（2026-10-15 用真模型跑三条样本）：
   *    模型经常写到 ~100 字，硬 `slice(0,70)` 会切出「…主播念到关键处突」这种**半句话** ——
   *    锐评最值钱的就是最后那个包袱，切在那儿比不写还糟。
   */
  it('⭐⭐ 超长在**句子边界**收，绝不从词中间切断', () => {
    const long = '这一句连读绝了。可惜 accept 吞音了。'.repeat(6)
    const got = parseCoachReply(JSON.stringify({ comment: long }))?.comment ?? ''
    expect(got.length).toBeLessThanOrEqual(70)
    expect(['。', '！', '？'].includes(got.slice(-1)), '结尾不是句末 ⇒ 收在了半句上（逗号收住的仍是半句）').toBe(true)
  })

  it('⚠️ 完全没边界可收（一长串无标点）时才硬切', () => {
    const got = parseCoachReply(JSON.stringify({ comment: '好'.repeat(200) }))?.comment ?? ''
    expect(got.length).toBe(70)
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
    expect(CODE.includes('必须具体到这一遍'), '没要求具体 ⇒ 会退化成"发音有待提高"').toBe(true)
    /** ⭐ 用户 2026-10-15 的第三条示例：可以直接引用句子里的词（'NEVER GIVE UP'） */
    expect(CODE.includes('NEVER GIVE UP'), '少了"引用句中的词"那条示例').toBe(true)
    /** ⭐ 夸满了就不必硬找缺点（那条示例全是夸，没有硬伤） */
    expect(CODE.includes('夸满了就不必硬找缺点'), '又在强求"必须找一个缺点"了').toBe(true)
    /** ⭐ 低分也不强制"先给台阶"（用户给的那条低分示例是纯损、一句没夸） */
    expect(CODE.includes('在向 HR 申请离职'), '少了"低分纯损"那条示例').toBe(true)
    expect(!CODE.includes('先给个台阶**（别让人难堪），再用'), '又在强制低分必须给台阶').toBe(true)
    /** ⭐ 对比梗模板 */
    expect(CODE.includes('对比梗'), '少了"对比梗"这条手法').toBe(true)
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

  /**
   * ⭐⭐ 守的是**风格**（用户 2026-10-15：「关键是要写到幽默有趣，甚至可以毒舌」）。
   *
   * ⚠️ 这类要求靠"说教"没用 —— 提示词里必须真的出现**风格示例**（few-shot 才是有效杠杆），
   *    而"毒舌"必须有**边界**（只损这一遍的发挥，不损人），否则会变成人身攻击。
   */
  it('⭐⭐ 提示词要求幽默有梗、允许毒舌，且给了风格示例', () => {
    expect(CODE.includes('幽默'), '没要求幽默').toBe(true)
    expect(CODE.includes('毒舌'), '没允许毒舌').toBe(true)
    expect(CODE.includes('风格示例'), '没有示例 —— 模型会退回教科书腔').toBe(true)
  })

  it('⭐⭐ 毒舌必须有边界：只损"这一遍的发挥"，不损人', () => {
    expect(CODE.includes('毒舌的边界'), '没写边界').toBe(true)
    expect(CODE.includes('不许损**人**'), '边界写得不明确（会滑向人身攻击）').toBe(true)
  })

  it('⭐ 明令禁止正能量套话（"继续加油"不是锐评）', () => {
    expect(CODE.includes('正能量套话')).toBe(true)
  })

  /**
   * ⚠️⚠️ 下面两条都是**真机实测**逼出来的（2026-10-15 跑真模型时抓到的）：
   */
  it('⭐⭐ 输出里的中文引号要清掉（模型把示例里的「」学进了正文）', () => {
    const r = parseCoachReply(JSON.stringify({ comment: '「Actions」的 æ 被你读成了打嗝，这话说得像在念说明书。' }))
    expect(r?.comment.includes('「')).toBe(false)
    expect(r?.comment.includes('」')).toBe(false)
  })

  it('⭐⭐ 分数/百分比必须禁（模型会把 58 分写成"48 分不冤"）；事实计数可用但必须对', () => {
    expect(CODE.includes('分数与百分比一个都不要出现'), '没禁分数 ⇒ 模型会编一个错的分数').toBe(true)
    expect(CODE.includes('48 分不冤'), '没把实测的那次编造写进提示词当反例').toBe(true)
    /** ⭐ 别一刀切：真机实测"歇了四回"（longGapCount=4）比"停顿较多"生动得多 */
    expect(CODE.includes('事实计数可以说'), '把有用的正确计数也一起禁了').toBe(true)
  })
})
