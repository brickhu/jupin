import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCRIPT = readFileSync(new URL('./wipe-history.ts', import.meta.url), 'utf-8')
const MIGRATION = readFileSync(
  new URL('../drizzle/0069_wipe_user_history.sql', import.meta.url),
  'utf-8',
)

/** 从脚本里抠出它要清的表名（**保持源码顺序** —— 那就是删除顺序） */
function scriptTablesInOrder(): string[] {
  return [...SCRIPT.matchAll(/table: '([a-z_]+)'/g)].map((m) => m[1]).filter((t) => t !== undefined)
}
/** 排序版（比对"集合是否相同"用） */
function scriptTables(): string[] {
  return [...scriptTablesInOrder()].sort()
}
/** 从迁移里抠出它要清的表名（**保持源码顺序**） */
function migrationDeleteOrder(): string[] {
  return [...MIGRATION.matchAll(/DELETE FROM `([a-z_]+)`/g)].map((m) => m[1]).filter((t) => t !== undefined)
}
/** 排序版（比对"集合是否相同"用） */
function migrationTables(): string[] {
  return [...migrationDeleteOrder()].sort()
}

/**
 * ⭐⭐ 守的是**"清库范围"只有一个事实**。
 *
 * ⚠️⚠️ 现在有两处会清用户的库：① 人工脚本 `wipe-history`（本机 / 排查用）；
 *    ② 迁移 `0069`（dev/prod 的流水线路径 —— 容器里没有日志也没有命令行，
 *    人工脚本那条路在云上实际走不通）。
 *    两者**范围必须逐表一致**，否则会出现"本机清干净了、线上漏一张表"这种
 *    **不报错**的分叉 —— 而漏的那张表恰恰是"余额归零了、流水还在"那类对账问题
 *    （`cookie_ledger` 就是这么漏过一次）。
 *
 * ⚠️ 这是**静态**检查（读源码文本）：它守的是"两边写的是同一批表"。
 */
describe('清库范围：脚本与迁移必须一致', () => {
  it('⭐⭐ 两处 DELETE 的表名集合必须完全相同', () => {
    expect(migrationTables().length, '迁移里一条 DELETE 都没有？').toBeGreaterThan(0)
    expect(scriptTables(), '脚本与迁移的清库范围漂了（漏一张表不报错，但会对不上账）').toEqual(
      migrationTables(),
    )
  })

  it('⭐⭐ 余额流水必须在内（`users.cookies/energy` 是缓存，真相在流水里）', () => {
    for (const t of ['cookie_ledger', 'energy_ledger']) {
      expect(migrationTables().includes(t), t + ' 没被清 ⇒ 余额归零而流水还在，对不上账').toBe(true)
    }
  })

  it('⚠️ 财务与账号**不在**清库范围（清了等于没收用户的钱）', () => {
    for (const t of ['users', 'payments', 'subscriptions', 'favorites']) {
      expect(migrationTables().includes(t), t + ' 被清了 —— 它不属于"可以清掉的用户数据"').toBe(false)
    }
  })

  it('⚠️ 迁移必须带 statement-breakpoint（漏了 = 一条多语句 SQL ⇒ 语法错、整条不生效）', () => {
    const dels = (MIGRATION.match(/DELETE FROM /g) ?? []).length
    const bps = (MIGRATION.match(/statement-breakpoint/g) ?? []).length
    expect(bps, '断点比语句少 ⇒ drizzle 切不开').toBeGreaterThanOrEqual(dels)
  })

  /**
   * ⭐⭐ **删除必须由那一份清单驱动**（不能再手写一遍 DELETE）。
   *
   * ⚠️⚠️ 真实发生过：脚本里原来有**两份**东西 —— 报表用的 `targets` 列表 +
   *    另写的硬编码 `DELETE FROM …`。我给清单加了 `cookie_ledger`，
   *    报表立刻显示"要清 1 条"，而**真正的删除里没有它** ⇒ prod 复核时才发现
   *    "还有残留"。⇒ 判据是**结构上只有一份**（循环走清单），而不是"记得两边都改"。
   */
  it('⭐⭐ 删除语句必须由清单驱动（不许再手写一份 DELETE 列表）', () => {
    /**
     * 允许：拼字符串的循环；不允许：写死的表名（带反引号或不带都算）。
     * ⚠️ 唯一允许写死的是 `users` 那一条（删探针账号，与"清表"是两回事）。
     */
    const KNOWN = ['participations', 'reviews', 'submissions', 'reward_grants', 'energy_ledger', 'cookie_ledger', 'likes']
    const hardcoded = KNOWN.filter((t) =>
      new RegExp('DELETE FROM [`]?' + t + '[`]?\\b').test(SCRIPT),
    )
    expect(hardcoded, '脚本里又出现了写死的 DELETE ⇒ 列表和删除会漂（就是"报表说清了、其实没删"）').toEqual([])
    expect(SCRIPT.includes('DELETE FROM ' + "' + t.table"), '删除不是走清单循环').toBe(true)
  })

  it('⭐⭐ 删除顺序：子表在前（participations / reviews 有外键指向 submissions）', () => {
    /**
     * ⚠️ 判据是**"子表在前"**，不是"两份清单逐位相同"：
     *    它们各自是一份独立的清单（脚本给人看、迁移给 drizzle 跑），
     *    只有**外键约束**是共同的真规则；要求逐位相同是**假约束**
     *    （我第一版就写成了逐位比较，结果被 energy/cookie 两张同层表的次序卡住）。
     */
    for (const [name, order] of [
      ['脚本', scriptTablesInOrder()],
      ['迁移', migrationDeleteOrder()],
    ] as const) {
      const iPart = order.indexOf('participations')
      const iRev = order.indexOf('reviews')
      const iSub = order.indexOf('submissions')
      expect(iPart, name + '：participations 不在清单里').toBeGreaterThan(-1)
      expect(iPart, name + '：participations 必须排在 submissions 之前（外键）').toBeLessThan(iSub)
      expect(iRev, name + '：reviews 必须排在 submissions 之前（外键）').toBeLessThan(iSub)
    }
  })
})
