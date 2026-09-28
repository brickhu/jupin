import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../src/db'
import { energyLedger, users } from '../src/db/schema'

/**
 * 能量对账 —— **只读**，不改任何数据。
 *
 *   逐用户比较 users.energy（缓存）与 SUM(energy_ledger.delta)（流水=真相），
 *   列出不一致的（id / 余额 / 流水合计 / 差值），最后给总量对比。
 *
 * ⚠️ 这是「缓存 + 流水」结构下唯一缺失的对账（见 docs/domain-model.md 1.11）。
 *    所有读余额的接口都读缓存（energy.ts 的 readEnergy），所以漂移时界面完全正常，
 *    只能靠这条命令发现。
 *
 * ⚠️ 刻意**没有 --apply**：漂移的历史数据怎么修是另一个决定，本命令只报告、不动数据。
 *    （对照 pnpm db:participations 的 --apply：那条重建是纯派生索引的幂等操作。）
 *
 * ⚠️ 环境由 APP_ENV 决定（.env / .env.<mode>），与其它脚本一致：
 *    APP_ENV=prod pnpm db:energy 才是看线上。
 *
 * ⚠️ 有漂移时退出码 1（与 db:participations 同约定），方便挂进 CI。
 */
console.log('能量对账（只读，不改数据）')

const rows = await db
  .select({
    id: users.id,
    energy: users.energy,
    ledger: sql<string>`coalesce(sum(${energyLedger.delta}), 0)`,
  })
  .from(users)
  .leftJoin(energyLedger, eq(energyLedger.userId, users.id))
  .groupBy(users.id, users.energy)
  .orderBy(asc(users.id))

let totalEnergy = 0
let totalLedger = 0
const mismatches: { id: number; energy: number; ledger: number; diff: number }[] = []

for (const row of rows) {
  const energy = Number(row.energy)
  const ledger = Number(row.ledger)
  totalEnergy += energy
  totalLedger += ledger
  if (energy !== ledger) mismatches.push({ id: row.id, energy, ledger, diff: energy - ledger })
}

console.log('用户数：' + rows.length)
console.log('users.energy 合计：' + totalEnergy)
console.log('energy_ledger.delta 合计：' + totalLedger)
console.log('总差值（余额 - 流水）：' + (totalEnergy - totalLedger))

if (mismatches.length > 0) {
  console.log('')
  console.log('❌ 不一致 ' + mismatches.length + ' 个用户：')
  for (const m of mismatches) {
    console.log(
      '   user=' + m.id + '  余额=' + m.energy + '  流水合计=' + m.ledger +
        '  差值=' + (m.diff > 0 ? '+' : '') + m.diff,
    )
  }
  process.exit(1)
}

console.log('')
console.log('✅ 一致（每个用户的余额 = 其流水合计）')
process.exit(0)
