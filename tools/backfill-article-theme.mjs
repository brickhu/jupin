#!/usr/bin/env node
/**
 * 解析目标库地址并运行 tools/backfill-article-theme.ts。
 *
 *   node tools/backfill-article-theme.mjs        # 本地（.env.local 的 DATABASE_URL）
 *   node tools/backfill-article-theme.mjs dev    # dev 云库（走外网地址）
 *   node tools/backfill-article-theme.mjs prod   # prod（谨慎）
 *
 * ⚠️ dev/prod 走**外网地址**从本机连（与 seed-cloud.mjs 同一套），
 *    前提是控制台把 MySQL 的外网地址打开了。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'

const arg = process.argv[2]
const target = arg === 'prod' ? 'prod' : arg === 'dev' ? 'dev' : 'local'
loadEnv(target)

let url = process.env.DATABASE_URL

if (target !== 'local') {
  const require = createRequire(resolve(ROOT, 'package.json'))
  const { DescribeWxCloudBaseRunDBClusterDetail } = require(
    resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/cloudapiDirect'),
  )
  const { setApiCommonParameters } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/common'))
  setApiCommonParameters({ region: 'ap-shanghai' })

  const envId = process.env.WXCLOUD_ENV_ID
  if (!envId) {
    console.error('❌ .env.' + target + ' 里没有 WXCLOUD_ENV_ID')
    process.exit(1)
  }
  const user = process.env.MYSQL_USERNAME ?? 'root'
  const password = process.env.MYSQL_PASSWORD
  const database = process.env.MYSQL_DATABASE ?? 'jushuo'
  if (!password) {
    console.error('❌ .env.' + target + ' 里没有 MYSQL_PASSWORD')
    process.exit(1)
  }

  console.log('环境：' + target + '（' + envId + '）')
  const detail = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
  const { DbInfo = {}, NetInfo = {} } = detail
  if (!DbInfo.IsOpenPubNetAccess || !NetInfo.PubNetAddress) {
    console.error('❌ 数据库没有开启外网地址，本机连不上。')
    console.error('   云托管控制台 → MySQL → 网络信息 → 开启外网地址')
    process.exit(1)
  }
  url = 'mysql://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@' + NetInfo.PubNetAddress + '/' + database
  console.log('外网地址：' + NetInfo.PubNetAddress)
}

if (!url) {
  console.error('❌ 没有 DATABASE_URL（本地看 .env.local，云端看 .env.' + target + '）')
  process.exit(1)
}

console.log('目标库：' + url.replace(/:[^:@/]+@/, ':***@'))
try {
  const out = execFileSync(resolve(ROOT, 'node_modules/.bin/tsx'), ['tools/backfill-article-theme.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
  })
  console.log(out.trim())
} catch (err) {
  console.error(String(err.stdout ?? err.message ?? ''))
  process.exit(1)
}
