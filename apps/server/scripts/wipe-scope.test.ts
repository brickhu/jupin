import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCRIPT = readFileSync(new URL('./wipe-history.ts', import.meta.url), 'utf-8')
const MIGRATION = readFileSync(
  new URL('../drizzle/0069_wipe_user_history.sql', import.meta.url),
  'utf-8',
)

/** 从脚本里抠出它要清的表名 */
function scriptTables(): string[] {
  return [...SCRIPT.matchAll(/table: '([a-z_]+)'/g)].map((m) => m[1]).filter((t) => t !== undefined).sort()
}
/** 从迁移里抠出它要清的表名 */
function migrationTables(): string[] {
  return [...MIGRATION.matchAll(/DELETE FROM `([a-z_]+)`/g)].map((m) => m[1]).filter((t) => t !== undefined).sort()
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
})
