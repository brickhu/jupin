import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(SRC, p), 'utf-8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * ⭐⭐ 守的是**「确认才生效」这一条口径的写法**（prd §7.2，用户 2026-10 定）。
 *
 * 它要防的错法很具体：出分之后用户**可以忽略那个面板**，所以"出分了"不等于"算数了"。
 * 一旦有人在**别处**再判一次"这条算不算参与"（而判据和 `scoredOf` 不一致），
 * 症状是**战绩/榜单与卡片上的分数对不上** —— 不报错、类型不报错、现有测试也不红，
 * 只是数字悄悄错了。所以判据只允许有一处，且必须带 `confirmed_at`。
 *
 * ⚠️ 这是**静态**检查（读源码文本），不连库 —— 与 routes/participation-scope.test.ts 同一种风格：
 *    它守的是"写法"，不是某一次查询的结果。
 */
describe('确认口径 —— 参与记录只认已确认的提交', () => {
  it('⭐ participations.ts 的 scoredOf 必须走统一判据 countedAsRecord()', () => {
    const src = read('services/participations.ts')
    const at = src.indexOf('function scoredOf(')
    expect(at, '找不到 scoredOf —— 它是不是被改名/删了？').toBeGreaterThan(-1)

    // 取该函数体（到第一个右花括号）
    const body = src.slice(at, src.indexOf('\n}', at))
    expect(
      body.includes('countedAsRecord()'),
      'scoredOf 没走统一判据 ⇒ 出分但没确认的提交会被算进战绩/榜单',
    ).toBe(true)
  })

  it('⭐ confirm.ts 必须：写 confirmed_at → 重算参与记录 → 清理语音（顺序不能换）', () => {
    const src = read('services/confirm.ts')
    const iMark = src.indexOf('confirmedAt: new Date()')
    const iSync = src.indexOf('await syncParticipation(')
    const iPurge = src.indexOf('await purgeSupersededAudio(')

    expect(iMark, 'confirm 没有写 confirmed_at').toBeGreaterThan(-1)
    expect(iSync, 'confirm 没有重算参与记录').toBeGreaterThan(-1)
    expect(iPurge, 'confirm 没有清理语音').toBeGreaterThan(-1)

    // ⚠️ 顺序硬性：参与记录只聚合已确认的行 ⇒ 必须先标记再重算；
    //    而"该留哪一份语音"要读参与记录 ⇒ 清理必须在重算之后
    expect(iMark, '必须先写 confirmed_at 再 syncParticipation').toBeLessThan(iSync)
    expect(iSync, '必须先 syncParticipation 再清语音（否则不知道留哪一份）').toBeLessThan(iPurge)
  })

  it('⭐⭐ 判据只允许一处（record-rule.ts）：谁也不许把那个条件抄进自己的 where', () => {
    /**
     * ⚠️⚠️ 抄一份的症状很隐蔽：**两处口径不同** ⇒ "明明超越了却显示没超越"、
     *    "战绩涨了但榜单没动" —— 不报错、类型不报错、测试也未必红。
     *    真实发生过：`participations.scoredOf` 过滤了 `confirmed_at`，
     *    而 `getBestExcluding` 没过滤 ⇒ **出分面板永远显示「保留战绩」**。
     */
    const bad: string[] = []
    for (const f of [
      'services/participations.ts',
      'services/leaderboard.ts',
      'services/cookies.ts',
      'services/scoring.ts',
      'services/settle.ts',
    ]) {
      if (/isNotNull\(\s*submissions\.confirmedAt\s*\)/.test(read(f))) bad.push(f)
    }
    expect(bad, '这些文件自己抄了一份"算不算战绩"的条件 ⇒ 两处口径会漂：').toEqual([])
    // 两个调用方都必须走统一判据
    for (const f of ['services/participations.ts', 'services/leaderboard.ts', 'services/cookies.ts']) {
      expect(read(f).includes('countedAsRecord()'), f + ' 没走统一判据').toBe(true)
    }
  })

  it('⚠️ 判据的唯一实现里带着 confirmed_at', () => {
    /**
     * 允许出现 `confirmedAt` 的文件 —— 每一个都有明确理由：
     *   · schema.ts           列的定义本身
     *   · participations.ts   ⭐ 判据（**唯一**一处）
     *   · confirm.ts          写这一列 + 清语音
     *   · submission-view.ts  把它透给客户端（客户端靠它分 `scored` / `retry`）
     *   · routes/submissions.ts  响应里那个兜底 false
     */
    const ALLOWED = new Set([
      'db/schema.ts',
      /** ⭐ 判据的**唯一**实现（`countedAsRecord`）—— 别的文件只许调它 */
      'services/record-rule.ts',
      'services/participations.ts',
      'services/confirm.ts',
      'services/submission-view.ts',
      'routes/submissions.ts',
    ])

    const offenders = walk(SRC)
      .filter((p) => !p.endsWith('.test.ts'))
      .filter((p) => readFileSync(p, 'utf-8').includes('confirmedAt'))
      .map((p) => p.slice(SRC.length))
      .filter((p) => !ALLOWED.has(p))

    expect(
      offenders,
      '这些文件也碰了 confirmedAt —— 判据一旦散开就会与"算不算战绩"漂：\n' + offenders.join('\n'),
    ).toEqual([])
  })
})
