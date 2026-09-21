#!/usr/bin/env node
/**
 * 给云托管数据库灌种子数据。
 *
 *   node tools/seed-cloud.mjs          # dev（默认）
 *   node tools/seed-cloud.mjs prod
 *
 * ⭐ 走**外网地址**从本机灌 —— 内网地址只在容器里通。
 *    外网地址由 API 自动查出，不用手抄。
 *
 * ⚠️ 前置：控制台里把 MySQL 的「外网地址」打开（灌完可以关掉）。
 *    官方对这个是提醒过的：「开放数据库外网地址有安全风险，不建议开启」。
 *    开发环境临时开一下可以接受，**生产环境别开**。
 *
 * ⚠️ 凭据来自 .env.dev / .env.prod 的 MYSQL_*（不是服务配置；键名不带后缀，
 *    文件名就是环境标识），
 *    所以重新开通数据库后要把新密码写进 .env。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'

const require = createRequire(resolve(ROOT, 'package.json'))
const { DescribeWxCloudBaseRunDBClusterDetail } = require(
  resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/cloudapiDirect'),
)
const { setApiCommonParameters } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/common'))
setApiCommonParameters({ region: 'ap-shanghai' })

const target = process.argv[2] === 'prod' ? 'prod' : 'dev'
// ---- 读环境变量：只加载 .env + .env.<target>（键名不带后缀，文件名即环境）----
loadEnv(target)

const envId = process.env.WXCLOUD_ENV_ID
if (!envId) {
  console.error(`❌ .env.${target} 里没有 WXCLOUD_ENV_ID`)
  process.exit(1)
}

const user = process.env.MYSQL_USERNAME ?? 'root'
const password = process.env.MYSQL_PASSWORD
const database = process.env.MYSQL_DATABASE ?? 'jushuo'
if (!password) {
  console.error(`❌ .env.${target} 里没有 MYSQL_PASSWORD`)
  console.error('   （重新开通数据库后要把新密码写进那份文件；服务配置里的旧密码不作数）')
  process.exit(1)
}

if (target === 'prod') {
  console.error('⚠️  目标环境是 PROD（正式环境）！种子数据会写进正式库。')
  console.error('    如果这不是你的本意，Ctrl-C 退出，改用不带参数的 dev 模式。')
  console.error('')
}

// ---- 查外网地址 ----
console.log(`环境：${target}（${envId}）`)
let detail
try {
  detail = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
} catch (err) {
  console.error('❌ 查询数据库失败:', err.Code ?? '', err.Message ?? err.message ?? '')
  process.exit(1)
}

const { DbInfo = {}, NetInfo = {} } = detail
console.log(`版本：${DbInfo.DbType} ${DbInfo.DbVersion}   状态：${DbInfo.ServerlessStatus || DbInfo.Status}`)

if (!DbInfo.IsOpenPubNetAccess || !NetInfo.PubNetAddress) {
  console.error('')
  console.error('❌ 数据库没有开启外网地址，本机连不上。')
  console.error('   解决：云托管控制台 → MySQL → 网络信息 → 开启外网地址')
  console.error('   （官方提示有安全风险；开发环境临时开一下，灌完关掉即可）')
  process.exit(1)
}
console.log(`外网地址：${NetInfo.PubNetAddress}`)
console.log(`内网地址：${NetInfo.PrivateNetAddress}（服务里用这个）`)
console.log(`目标库：${database}\n`)

// ---- 灌种子 ----
const url = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${NetInfo.PubNetAddress}/${database}`
console.log('开始灌种子…')
try {
  const out = execFileSync(resolve(ROOT, 'node_modules/.bin/tsx'), ['apps/server/src/db/seed.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
  })
  console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'))
} catch (err) {
  console.error('❌ 失败：')
  const msg = String(err.stdout ?? err.message ?? '')
  console.error(msg.split('\n').slice(-8).map((l) => '  ' + l).join('\n'))
  console.error('')
  console.error('  常见原因：')
  console.error(`   · 库不存在 → 控制台执行：CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`)
  console.error(`   · 密码不对 → 改 .env.${target} 的 MYSQL_PASSWORD`)
  console.error('   · 还没建表 → 先跑 pnpm deploy:' + target + '（AUTO_MIGRATE 会自动建表）')
  process.exit(1)
}
