#!/usr/bin/env node
/**
 * 查看云托管 MySQL 的真实连接信息。
 *
 *   node tools/cloud-db-info.mjs
 *
 * ⭐ 为什么需要这个工具（CLI 本身没有数据库命令）：
 *    云托管 MySQL 是 **serverless 实例**，内网地址在实例重建后会变，
 *    而服务环境变量不会自动跟着变 —— 本项目就因此吃了 ETIMEDOUT：
 *    配置里还写着 10.23.106.149，真实地址早已是 10.10.103.14。
 *
 *    CLI 只暴露了 DescribeWxCloudBaseRunDBClusterDetail 这一个数据库接口，
 *    没有命令包装它，所以这里直接调用 CLI 内部的 API 客户端。
 *
 * 拿到地址后：写进根目录 .env 的 MYSQL_ADDRESS，再 pnpm deploy:dev。
 * （deploy-cloud.mjs 里本地 .env 的 MYSQL_* 会覆盖服务配置）
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'

const require = createRequire(resolve(ROOT, 'package.json'))
const CLI = resolve(ROOT, 'node_modules/@wxcloud/cli/lib')

const { DescribeWxCloudBaseRunDBClusterDetail } = require(CLI + '/api/cloudapiDirect')
const { setApiCommonParameters } = require(CLI + '/api/common')
setApiCommonParameters({ region: 'ap-shanghai' })

// ---- 读环境变量：只加载 .env + .env.<target> ----
const target = process.argv[2] === 'prod' ? 'prod' : 'dev'
loadEnv(target)
const envId = process.env.WXCLOUD_ENV_ID

if (!envId) {
  console.error(`❌ .env.${target} 里没有 WXCLOUD_ENV_ID`)
  process.exit(1)
}

console.log(`环境：${target}（${envId}）\n`)

let detail
try {
  detail = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
} catch (err) {
  console.error('❌ 查询失败:', err.Code ?? '', err.Message ?? err.message ?? JSON.stringify(err))
  console.error('   如果提示实例不存在，说明该环境还没开通 MySQL。')
  process.exit(1)
}

const { DbInfo = {}, NetInfo = {} } = detail

console.log('数据库')
console.log('  集群 ID      ', detail.DbClusterId)
console.log('  类型 / 版本  ', DbInfo.DbType, DbInfo.DbVersion, DbInfo.DbVersion === '5.7' ? '⚠️ 已 EOL（2023-10）' : '')
console.log('  集群状态     ', DbInfo.ClusterStatus)
console.log('  serverless   ', DbInfo.ServerlessStatus, DbInfo.ServerlessStatus === 'pause' ? '（自动暂停中，首个连接会触发恢复）' : '')
console.log('  自动暂停     ', DbInfo.IsOpenAutoPause ? `开启（${DbInfo.AutoPauseDelay}s 空闲后暂停）` : '关闭')
console.log('  算力范围     ', DbInfo.MinCpu, '~', DbInfo.MaxCpu, 'CCU')
console.log('  已用存储     ', ((DbInfo.UsedStorage ?? 0) / 1024).toFixed(3), 'GB  /  上限', ((DbInfo.StorageLimit ?? 0) / 1024).toFixed(0), 'GB')
console.log('')
console.log('网络')
console.log('  ⭐ 内网地址  ', NetInfo.PrivateNetAddress, '  ← 容器里用这个')
console.log('  外网地址     ', DbInfo.IsOpenPubNetAccess ? NetInfo.PubNetAddress + '  ← 本机可用' : '未开启')
console.log('  VPC          ', NetInfo.Net)
console.log('')

// ⚠️ 键名不带后缀：目标环境由**文件名**决定（.env.dev / .env.prod）
const current = process.env.MYSQL_ADDRESS
const file = `.env.${target}`
if (current && current !== NetInfo.PrivateNetAddress) {
  console.log(`⚠️  ${file} 里的 MYSQL_ADDRESS 与真实内网地址不一致：`)
  console.log(`      ${file}  :`, current)
  console.log('      真实      :', NetInfo.PrivateNetAddress)
  console.log(`    → 改 ${file}，然后 pnpm deploy:${target}`)
} else if (current) {
  console.log(`✅ ${file} 里的 MYSQL_ADDRESS 与真实内网地址一致`)
} else {
  console.log(`ℹ️  ${file} 里没有 MYSQL_ADDRESS，服务用的是自己的配置。`)
  console.log(`    要覆盖它就写：MYSQL_ADDRESS=${NetInfo.PrivateNetAddress}`)
}
