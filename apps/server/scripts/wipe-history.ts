import mysql from 'mysql2/promise'

/**
 * 一次性脚本：清空**历史数据**（规格：docs/design/growth-and-energy.md 第 6 节）。
 *
 *   ⚠️ 不要直接跑它 —— 由 tools/wipe-history.mjs 调用，那里负责
 *      解析目标环境（local / dev / prod）和 --yes 确认。
 *
 * ⚠️⚠️ 为什么不做成 migration：
 *    migration 会在每次 AUTO_MIGRATE 时被检查执行，也会在别人重建库时被重放 ——
 *    一条 DELETE 留在迁移历史里，迟早会清掉不该清的东西。一次性脚本跑完即作废。
 *
 * ⚠️ 默认**只看不改**；真的要删必须带 WIPE_APPLY=1。
 *
 * ⚠️⚠️ 为什么"清 submissions"要连 users / articles 一起动：
 *    users 上的 streak_* / growth_* / energy_* 和 articles 上的
 *    participant_count / conquered_count **都是从 submissions 推出来的**。
 *    只删 submissions 的话，它们会变成孤儿 ——
 *    「连战 12 天」而一条提交都查不到、竞技场显示「19 人参与」而底下一条成绩都没有。
 *    后者正是「两个数对不上」那一类最难查的问题。
 */

const url = process.env.DATABASE_URL
if (!url) {
  console.error('❌ 没有 DATABASE_URL')
  process.exit(1)
}
const apply = process.env.WIPE_APPLY === '1'

const conn = await mysql.createConnection(url)

/**
 * 逐条统计 —— 表不存在（迁移还没跑过）时给 0 并记下来，
 * 而不是整个脚本炸掉：prod 有可能还没升级到这一版。
 */
async function count(table: string, where = ''): Promise<{ n: number; missing: boolean }> {
  try {
    const [rows] = await conn.query('SELECT COUNT(*) AS n FROM ' + table + (where ? ' WHERE ' + where : ''))
    const n = Number((rows as { n: number }[])[0]?.n ?? 0)
    return { n, missing: false }
  } catch {
    return { n: 0, missing: true }
  }
}

const targets: { label: string; table: string; where?: string; note: string }[] = [
  { label: '成绩历史', table: 'submissions', note: '全表删（含逐词、分项、AI 点评、录音引用）' },
  { label: '· 点赞', table: 'likes', note: '外键指向 submissions，必须先删' },
  { label: '· AI 点评', table: 'reviews', note: '外键指向 submissions，必须先删' },
  { label: '解冻卡', table: 'unfreeze_cards', note: '卡表本来就是新的，这里是兜底' },
  { label: '奖励发放流水', table: 'reward_grants', note: '' },
  { label: '能量流水', table: 'energy_ledger', note: '' },
  {
    label: '被污染的冗余计数',
    table: 'articles',
    where: 'participant_count <> 0 OR conquered_count <> 0',
    note: '⚠️ 最容易漏的一条：不清的话竞技场会显示"19 人参与"却没有成绩',
  },
]

console.log('')
console.log('将要处理：')
console.log('  ' + '条数'.padEnd(10) + '对象'.padEnd(20) + '说明')
let total = 0
for (const t of targets) {
  const { n, missing } = await count(t.table, t.where)
  total += n
  const nText = missing ? '(表不存在)' : String(n)
  console.log('  ' + nText.padEnd(12) + t.label.padEnd(18) + t.note)
}

const users = await count('users')
const probes = await count('users', "openid LIKE 'probe%'")
console.log('')
console.log('  账号：' + users.n + ' 个（**不删**，只重置下面的字段）')
console.log('    其中探针账号 ' + probes.n + " 个（openid 以 probe 开头，会被删掉）")
console.log('')
console.log('会重置的字段（users）：')
console.log('  streak_days / streak_best / last_read_date / unfreeze_marker_streak')
console.log('  invalid_count / invalid_date')
console.log('  growth_self / growth_diligence / growth_standout')
console.log('  energy / energy_date')
console.log('')
console.log('**保留不动**：articles 的正文 / 音频 / 发布状态、schedules 排期、')
console.log('              用户的昵称头像、reward_rules 规则表')
console.log('')

if (!apply) {
  console.log('（只看不改）要真的执行，加上 --yes。')
  await conn.end()
  process.exit(0)
}

if (total === 0 && probes.n === 0) {
  console.log('✅ 没有需要清的东西，什么都没做。')
  await conn.end()
  process.exit(0)
}

console.log('开始清理…')
await conn.beginTransaction()
try {
  // ⚠️ 顺序不能反：likes / reviews 有指向 submissions 的外键
  await conn.query('DELETE FROM likes')
  await conn.query('DELETE FROM reviews')
  await conn.query('DELETE FROM submissions')

  await conn.query('DELETE FROM unfreeze_cards')
  await conn.query('DELETE FROM reward_grants')
  await conn.query('DELETE FROM energy_ledger')

  await conn.query(
    'UPDATE users SET streak_days = 0, streak_best = 0, last_read_date = NULL,' +
      ' unfreeze_marker_streak = 0, invalid_count = 0, invalid_date = NULL,' +
      ' growth_self = 0, growth_diligence = 0, growth_standout = 0,' +
      ' energy = 0, energy_date = NULL',
  )

  // ⚠️ 冗余计数必须跟着成绩一起归零（见文件头）
  await conn.query('UPDATE articles SET participant_count = 0, conquered_count = 0')

  const [del] = await conn.query("DELETE FROM users WHERE openid LIKE 'probe%'")

  await conn.commit()
  console.log('')
  console.log('✅ 清理完成。删掉的探针账号：' + Number((del as { affectedRows?: number }).affectedRows ?? 0) + ' 个')
} catch (err) {
  await conn.rollback()
  console.error('❌ 失败，已回滚（什么都没改）：' + (err as Error).message)
  await conn.end()
  process.exit(1)
}

// ---- 复核 ----
console.log('')
console.log('复核：')
for (const t of targets) {
  const { n } = await count(t.table, t.where)
  console.log('  ' + t.label + '：' + n + (n === 0 ? ' ✅' : ' ⚠️ 还有残留'))
}

await conn.end()
