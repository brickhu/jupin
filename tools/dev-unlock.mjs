#!/usr/bin/env node
/**
 * 本地开发工具：把本地库里的账号置为会员（每天 50 次挑战），方便反复跑「提交 → 打分」。
 *
 *   node tools/dev-unlock.mjs            # 解锁全部本地账号
 *   node tools/dev-unlock.mjs --status   # 只看状态，不改
 *   node tools/dev-unlock.mjs --user 10  # 只解锁某一个
 *
 * ⚠️ 为什么是「置为会员」而不是把额度判断改掉：
 *    挑战额度本来就是「免费每天 1 次 / 付费每天 50 次」（见 services/quota.ts），
 *    会员是产品的真实机制。用一个已存在的产品路径来解锁，
 *    好过为了开发方便在生产代码里开一个 if 口子。
 *
 * ⭐⭐ 正常情况下**不需要跑它**：服务端已经把「非生产环境一律给会员」做成了不变量
 *    （见 services/user.ts 的 withLocalDevPrivilege，每次取用户时生效）。
 *    本脚本保留为**手动兜底**：服务端没跑起来时直接改库，或想看一眼本地有哪些账号。
 *
 * ⚠️ 判据从「openid 以 dev_ 开头」改成了「本地库里的一切」：
 *    本地现在走**真实登录**（模拟器里 wx.login 的 code 也是真的，换回来就是本人
 *    微信账号的 openid，见 routes/auth.ts），真实 openid 当然没有 dev_ 前缀。
 *    安全边界变成了**只连本机那个 docker 容器里的 jushuo 库** —— 见下面的连接常量，
 *    它们全部可用环境变量覆盖，但默认值只可能指向本地开发库。
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
    ['exec', CONTAINER, 'mysql', '-u' + USER, '-p' + PASS, '-D', DB, '-N', '-B', '-e', query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function show(label) {
  const rows = sql(
    'SELECT id, openid, IFNULL(nickname, \'-\'), IFNULL(member_until, \'-\'),' +
      ' (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id)' +
      ' FROM users u ORDER BY id DESC LIMIT 20',
  )
  console.log('\n--- ' + label + ' ---')
  console.log('id\topenid\t昵称\t会员到期\t提交数')
  console.log(rows.trim() || '(本地库还没有账号)')
}

try {
  sql('SELECT 1')
} catch (err) {
  console.error('❌ 连不上本地数据库容器 ' + CONTAINER + '。')
  console.error('   先确认它在跑：pnpm dev:docker:ps')
  console.error('   ' + String(err.stderr ?? err.message).split('\n')[0])
  process.exit(1)
}

show('解锁前')

if (statusOnly) {
  console.log('\n（--status：只看不改）')
  process.exit(0)
}

const scope = onlyUser ? 'WHERE id=' + onlyUser : ''
const before = sql('SELECT COUNT(*) FROM users ' + scope).trim()
const updated = sql(
  'UPDATE users SET member_until = DATE_ADD(NOW(), INTERVAL ' + MEMBER_YEARS + ' YEAR) ' +
    scope + ';' +
    ' SELECT ROW_COUNT();',
).trim()

console.log('\n✅ 解锁 ' + updated + ' / ' + before + ' 个本地账号')
show('解锁后')
console.log('\n⚠️ 只动本机 docker 容器里的 ' + DB + ' 库，碰不到任何云上环境。')
