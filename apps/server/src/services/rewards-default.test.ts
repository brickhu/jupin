import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(new URL('./rewards.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**「奖励规则默认关」这条产品口径**（用户 2026-10-15 定：
 *    「现在只奖励饼干，从来没说要奖励能量」）。
 *
 * ⚠️⚠️ 它要防的是**"本机关了、线上还在发"**这种分叉，而不是某一行代码：
 *    `ensureDefaultRules()` 用 `.ignore()`（**只插不更**）⇒ 存量环境**只能靠迁移**关，
 *    而新环境看**这里的默认值**。⇒ 两处都得是关的：
 *     ① 默认值 `enabled: false`；② 迁移 0067 的 UPDATE（在 drizzle 目录里）。
 *    ⚠️ 只改一处，两边就不一样，而且**不报错**。
 */
describe('奖励规则：默认关（只奖励饼干，不发能量）', () => {
  it('⭐⭐ 建规则的默认值必须是 enabled: false', () => {
    expect(SRC.includes('enabled: false'), '默认值又被打开了 ⇒ 新环境会开始发能量').toBe(true)
    /** 反向：不许出现"显式打开"或漏掉这一项（漏了就走列默认 true） */
    expect(/rewardAmount: 1,\s*\n\s*enabled: true/.test(SRC), '又显式打开了').toBe(false)
  })

  it('⭐⭐ 存量环境靠迁移关（两处必须同时存在）', () => {
    const sql = readFileSync(new URL('../../drizzle/0067_quiet_record_reward.sql', import.meta.url), 'utf-8')
    expect(sql.includes('UPDATE `reward_rules` SET `enabled` = 0'), '迁移 0067 没关它').toBe(true)
    expect(sql.includes("'sentence_top_record'"), '迁移关的不是这条规则').toBe(true)
  })

  /**
   * ⭐ 已作废的规则要**真的没了**（不是"留着但不求值"）。
   *
   * ⚠️ `streak_unfreeze_7` 是解冻卡那套的遗留：机制整体下线了，
   *    而"留着但不求值"会让下一个人以为「连战 7 天还有奖励」——
   *    配置表读起来就是产品口径，表里有它，就等于产品里还有它。
   */
  it('⭐ 作废的规则不许再出现在代码里', () => {
    expect(SRC.includes('streak_unfreeze_7'), '代码里又提到它了（产品口径里已经没有这条）').toBe(false)
  })

  it('⭐ 存量环境靠迁移删（0068），且删的确实是它', () => {
    const sql = readFileSync(
      new URL('../../drizzle/0068_drop_dead_rule.sql', import.meta.url),
      'utf-8',
    )
    expect(sql.includes('DELETE FROM `reward_rules`'), '迁移 0068 没删').toBe(true)
    expect(sql.includes("'streak_unfreeze_7'"), '删的不是这条规则').toBe(true)
  })
})
