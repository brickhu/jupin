#!/usr/bin/env node
/**
 * 把 .env / .env.<env> 里的值**同步成 GitHub Secrets** —— CI 部署缺的就是它们。
 *
 *   node tools/gh-secrets.mjs dev            # 只打印命令（不执行，先看一眼）
 *   node tools/gh-secrets.mjs dev --apply    # 真的设置（需要先 gh auth login）
 *   node tools/gh-secrets.mjs prod --apply
 *
 * ⚠️⚠️ 为什么需要它：CI 的 Deploy workflow 在「检查 secrets 是否配齐」那一步
 *    就直接失败 —— 而那 7 个值其实**本地全都有**，只是从来没有搬到 GitHub。
 *    手工一个个复制粘贴既慢又容易漏（漏一个的后果是部署到一半才报错）。
 *
 * ⚠️ Workflow 用的是 **Environment**（dev / prod），所以 secrets 要挂在
 *    Environment 上而不是仓库级：两个环境的 MYSQL_* / TOKEN_SECRET 本来就不一样。
 *    ⚠️ TOKEN_SECRET 各环境必须不同、且**不能变** —— 变了所有人的登录态当场失效。
 *
 * ⚠️ 账号级的键（小程序 AppID / 云托管密钥 / 讯飞）两个环境**同值**，
 *    所以 dev 和 prod 各设一份同样的内容即可（Environment secret 不会互相继承）。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { ROOT, parseEnvFile } from './env.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const target = args.includes('prod') ? 'prod' : 'dev'

/** 账号级：两个环境同值，来自根 .env */
const ACCOUNT_LEVEL = [
  'WXCLOUD_APPID',
  'WXCLOUD_CLI_SECRET',
  'XFYUN_APP_ID',
  'XFYUN_API_KEY',
  'XFYUN_API_SECRET',
  'WX_APPID',
  'WX_SECRET',
]

/** 环境级：dev 与 prod 不同，来自 .env.<target> */
const ENV_LEVEL = [
  'WXCLOUD_ENV_ID',
  'MYSQL_ADDRESS',
  'MYSQL_USERNAME',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'TOKEN_SECRET',
]

const base = parseEnvFile(resolve(ROOT, '.env'))
const perEnv = parseEnvFile(resolve(ROOT, '.env.' + target))

const resolved = []
const missing = []
for (const key of ACCOUNT_LEVEL) {
  const v = process.env[key] ?? base[key]
  if (v) resolved.push([key, v])
  else missing.push(key + '（应在根 .env）')
}
for (const key of ENV_LEVEL) {
  const v = perEnv[key]
  if (v) resolved.push([key, v])
  else missing.push(key + '（应在 .env.' + target + '）')
}

console.log('目标 environment：' + target)
console.log('要设置 ' + resolved.length + ' 个 secrets' + (apply ? '（--apply：会真的写）' : '（只打印，不写）'))
console.log('')

if (missing.length) {
  console.error('❌ 本地就缺这些，先补进对应的 .env 再跑本脚本：')
  for (const m of missing) console.error('   · ' + m)
  console.error('')
  console.error('   （线上服务的这些值在云托管控制台里；本机 .env 只是副本）')
  process.exit(1)
}

if (!apply) {
  /**
   * ⚠️ 默认**只打印键名，不打印值**。
   *    这些值会进终端回滚缓冲、CI 日志、以及任何在看着屏幕的人 ——
   *    而它们（云托管密钥 / 数据库密码 / TOKEN_SECRET）泄漏一次的代价远大于省下的那点麻烦。
   *    要核对某个值时用 --show 单独看。
   */
  const show = args.includes('--show')
  console.log('将要设置的 secrets（' + (show ? '含值' : '默认不显示值，要看得加 --show') + '）：')
  for (const [key, value] of resolved) {
    console.log('  ' + key.padEnd(22) + (show ? JSON.stringify(value) : '(已从 .env 读到，' + String(value).length + ' 字符)'))
  }
  console.log('')
  console.log('确认没问题就加 --apply 重跑（需要先 gh auth login）。')
  process.exit(0)
}

let ok = 0
for (const [key, value] of resolved) {
  try {
    execFileSync('gh', ['secret', 'set', key, '--env', target, '--body', value], { stdio: 'pipe' })
    console.log('  ✅ ' + key)
    ok += 1
  } catch (err) {
    console.error('  ❌ ' + key + '：' + String(err.stderr ?? err.message).trim().split('\n')[0])
    console.error('     常见原因：没 gh auth login、或这个 environment 还不存在')
    console.error('     （Environment 要在仓库 Settings → Environments 里先建一个同名的）')
    process.exit(1)
  }
}

console.log('')
console.log('✅ 设置完成：' + ok + ' / ' + resolved.length)
console.log('   再把 dev 分支推一次（或点 Re-run jobs）就能看到 CI 真正跑部署了。')
