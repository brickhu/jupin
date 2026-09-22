#!/usr/bin/env node
/**
 * ⭐ 一次性脚本：清空历史数据（产品还没上线，见 docs/design/growth-and-energy.md 第 6 节）。
 *
 *   node tools/wipe-history.mjs              # 本机 docker（默认，**只看不改**）
 *   node tools/wipe-history.mjs --yes        # 本机 docker，真的删
 *   node tools/wipe-history.mjs dev --yes    # 云托管 dev
 *   node tools/wipe-history.mjs prod --yes   # 云托管 prod
 *
 * ⚠️⚠️ 先不带 --yes 跑一遍，看清楚它要删什么，再决定。
 *
 * ⚠️ 清的是「成绩历史 + 由它推出来的那些字段」，不是内容：
 *    articles 的正文/音频/发布状态、schedules 排期、用户的昵称头像都保留。
 *
 * ⚠️ dev 和 prod **都要跑一次** —— prod 库里也有测试提交。
 *
 * ⚠️ 云上走**外网地址**：内网地址只在容器里通。控制台里临时开一下外网
 *    （官方提示有安全风险，跑完关掉即可），前置条件与 tools/seed-cloud.mjs 一样。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--yes')
const target = args.includes('prod') ? 'prod' : args.includes('dev') ? 'dev' : 'local'

let url

if (target === 'local') {
  // ⭐ 本机：直接用它自己的 DATABASE_URL（指向 127.0.0.1 的 docker 容器）
  loadEnv('local')
  url = process.env.DATABASE_URL
  if (!url) {
    console.error('❌ .env.local 里没有 DATABASE_URL')
    process.exit(1)
  }
  console.log('目标：本机 docker（' + url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@') + '）')
} else {
  const require = createRequire(resolve(ROOT, 'package.json'))
  const { DescribeWxCloudBaseRunDBClusterDetail } = require(
    resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/cloudapiDirect'),
  )
  const { setApiCommonParameters } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/common'))
  setApiCommonParameters({ region: 'ap-shanghai' })

  loadEnv(target)
  const envId = process.env.WXCLOUD_ENV_ID
  const user = process.env.MYSQL_USERNAME ?? 'root'
  const password = process.env.MYSQL_PASSWORD
  const database = process.env.MYSQL_DATABASE ?? 'jushuo'
  if (!envId || !password) {
    console.error('❌ .env.' + target + ' 里缺 WXCLOUD_ENV_ID 或 MYSQL_PASSWORD')
    process.exit(1)
  }

  if (target === 'prod' && !apply) {
    console.error('⚠️  目标环境是 PROD（正式环境）。')
    console.error('')
  }

  let detail
  try {
    detail = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
  } catch (err) {
    console.error('❌ 查询数据库失败:', err.Code ?? '', err.Message ?? err.message ?? '')
    process.exit(1)
  }
  const { DbInfo = {}, NetInfo = {} } = detail
  if (!DbInfo.IsOpenPubNetAccess || !NetInfo.PubNetAddress) {
    console.error('❌ 数据库没有开启外网地址，本机连不上。')
    console.error('   解决：云托管控制台 → MySQL → 网络信息 → 开启外网地址（跑完可以关掉）')
    process.exit(1)
  }

  url =
    'mysql://' +
    encodeURIComponent(user) +
    ':' +
    encodeURIComponent(password) +
    '@' +
    NetInfo.PubNetAddress +
    '/' +
    database
  console.log('目标：' + target + '（' + envId + '）外网 ' + NetInfo.PubNetAddress + ' / 库 ' + database)
}

console.log('')

try {
  const out = execFileSync(resolve(ROOT, 'node_modules/.bin/tsx'), ['apps/server/scripts/wipe-history.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, WIPE_APPLY: apply ? '1' : '0' },
  })
  console.log(out.trimEnd())
} catch (err) {
  console.error(String(err.stdout ?? err.message ?? '').trimEnd())
  console.error('')
  console.error('  常见原因：')
  console.error('   · 表还没建 → 先 pnpm deploy:' + target + '（AUTO_MIGRATE 会自动建表）')
  console.error('   · 连不上 → 确认外网地址开着、密码与 .env.' + target + ' 一致')
  process.exit(1)
}
