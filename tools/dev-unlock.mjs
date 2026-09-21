#!/usr/bin/env node
/**
 * 本地开发工具：把额度提到会员档，方便反复跑「提交 → 打分」流程。
 *
 * ⚠️ 为什么是「置为会员」而不是把额度判断改掉：
 *    挑战额度本来就是「免费每天 1 次 / 付费每天 50 次」（见 services/quota.ts），
 *    会员是产品的真实机制。用一个已存在的产品路径来解锁，
 *    好过为了开发方便在生产代码里开一个 if 口子。
 *
 * ⚠️⚠️ 只动 openid 以 `dev_` 开头的账号。
 *    本地联调时 openid 是 `dev_${wx.login 的 code}`（见 routes/auth.ts），
 *    线上的 openid 是真实微信 openid、**不会**有 dev_ 前缀 ——
 *    所以这条限制让本工具**在原理上不可能误伤真实用户**。
 *
 * ⚠️ 每次在开发者工具里重新登录都可能生成**新的 dev_ 账号**
 *    （wx.login 的 code 变了 → openid 变了 → 新用户），
 *    所以这个脚本设计成可反复执行、每次覆盖全部 dev_ 账号。
 *
 * ⭐⭐ 现在**已经不需要手动跑它了**：服务端 `services/user.ts` 里已经把
 *    「本地 dev_ 账号自动置为会员」做成了不变量（每次取用户时生效）。
 *    这个判断当初就写在这里、却要靠人记得执行 —— 结果真的忘了，
 *    表现为「测试到一半突然提交不了」，而且极难查。
 *
 *    本脚本保留为**手动兜底**：需要在服务端没跑起来时直接改库、
 *    或想看一眼当前有哪些 dev 账号时用它。
 *
 * 用法：
 *   node tools/dev-unlock.mjs            # 解锁全部 dev_ 账号
 *   node tools/dev-unlock.mjs --status   # 只看状态，不改
 *   node tools/dev-unlock.mjs --user 10  # 只解锁某一个（仍须是 dev_ 账号）
 */
import { execFileSync } from 'node:child_process'

const CONTAINER = process.env.DEV_DB_CONTAINER ?? 'jushuo-db'
const USER = process.env.DEV_DB_USER ?? 'jushuo'
const PASS = process.env.DEV_DB_PASSWORD ?? 'dev'
const DB = process.env.DEV_DB_NAME ?? 'jushuo'

const args = process.argv.slice(2)
const statusOnly = args.includes('--status')
const onlyUser = args.includes('--user') ? Number(args[args.indexOf('--user') + 1]) : null

/** ⚠️ 会员期限给 10 年 —— 足够长，且不依赖任何「永不过期」的魔法值 */
const MEMBER_YEARS = 10

function sql(query) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'mysql', `-u${USER}`, `-p${PASS}`, '-D', DB, '-N', '-B', '-e', query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function show(label) {
  const rows = sql(
    `SELECT id, openid, IFNULL(member_until,'-'), next_free_at,
            (SELECT COUNT(*) FROM submissions s WHERE s.user_id=u.id)
     FROM users u WHERE openid LIKE 'dev\\_%' ORDER BY id`,
  )
  console.log(`\n--- ${label} ---`)
  console.log('id\topenid\t会员到期\t下次免费\t提交数')
  console.log(rows.trim() || '(没有 dev_ 账号)')
}

try {
  sql('SELECT 1')
} catch (err) {
  console.error(`❌ 连不上本地数据库容器 ${CONTAINER}。`)
  console.error('   先确认它在跑：pnpm dev:docker:ps')
  console.error('   ' + String(err.stderr ?? err.message).split('\n')[0])
  process.exit(1)
}

show('解锁前')

if (statusOnly) {
  console.log('\n（--status：只看不改）')
  process.exit(0)
}

const scope = onlyUser ? `AND id=${onlyUser}` : ''
const before = sql(`SELECT COUNT(*) FROM users WHERE openid LIKE 'dev\\_%' ${scope}`).trim()
const updated = sql(
  `UPDATE users
      SET member_until = DATE_ADD(NOW(), INTERVAL ${MEMBER_YEARS} YEAR),
          next_free_at = '1970-01-01 00:00:00'
    WHERE openid LIKE 'dev\\_%' ${scope};
   SELECT ROW_COUNT();`,
).trim()

console.log(`\n✅ 解锁 ${updated} / ${before} 个 dev_ 账号`)
show('解锁后')
console.log('\n⚠️ 只影响 openid 以 dev_ 开头的本地联调账号；线上真实用户不可能被本工具碰到。')
