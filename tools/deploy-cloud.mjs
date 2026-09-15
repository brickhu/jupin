#!/usr/bin/env node
/**
 * 部署到微信云托管。
 *
 *   node tools/deploy-cloud.mjs dev
 *   node tools/deploy-cloud.mjs dev --remark "提交链路改造"
 *   node tools/deploy-cloud.mjs dev --detach        # 不等构建日志
 *
 * ⭐ 为什么要脚本而不是手敲命令：
 *   云托管的**服务环境变量是整份覆盖的**，手敲 --envParamsJson 一不小心就把
 *   数据库连接信息冲掉，服务直接连不上库。
 *   所以这里先读回当前配置，把 MYSQL_* 原样保留，再合并本项目的变量。
 *
 * 前置：
 *   ① 根目录 .env 里有 WXCLOUD_CLI_SECRET 与 WXCLOUD_ENV_ID / WXCLOUD_ENV_ID_PROD
 *   ② 先 wxcloud login --appId <AppID> --privateKey <CLI密钥>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = resolve(ROOT, 'node_modules/.bin/wxcloud')
const ENV_FILE = resolve(ROOT, '.env')

// CLI 内部没有暴露对象存储命令，只有这个环境查询接口带着 Storages 字段
const require = createRequire(resolve(ROOT, 'package.json'))
const { DescribeWxCloudBaseRunEnvs } = require(
  resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/cloudapiDirect'),
)
const { setApiCommonParameters } = require(resolve(ROOT, 'node_modules/@wxcloud/cli/lib/api/common'))
setApiCommonParameters({ region: 'ap-shanghai' })

/**
 * 从云托管 API 读出该环境的对象存储桶与地域。
 *
 * ⭐ 为什么要自动读：这两个值原本要去「控制台-对象存储-存储配置」手抄，
 *    抄错的表现是运行期读音频失败（签名错/桶不存在），排查成本高。
 *    而 API 里本来就有（EnvInfo.Storages[].Bucket / Region）。
 */
async function resolveStorageConfig(envId) {
  try {
    const envs = await DescribeWxCloudBaseRunEnvs()
    const list = envs?.EnvList ?? envs ?? []
    const found = list.find((e) => e.EnvId === envId)
    const s = found?.Storages?.[0]
    return s ? { bucket: s.Bucket, region: s.Region } : null
  } catch (err) {
    console.warn('⚠️ 读取对象存储配置失败：' + (err.Message ?? err.message ?? err))
    return null
  }
}

// ---- 参数 ----
const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--')) ?? 'dev'
const remarkIdx = args.indexOf('--remark')
const remark = remarkIdx >= 0 ? args[remarkIdx + 1] : undefined
const detach = args.includes('--detach')
/** ⚠️ --reset：一次性删库重建（无数据环境 schema 重构用，生产环境勿用） */
const reset = args.includes('--reset')
if (!['dev', 'prod'].includes(target)) {
  console.error('用法：node tools/deploy-cloud.mjs [dev|prod] [--remark 说明] [--detach]')
  process.exit(1)
}

// ---- 读 .env ----
function readEnvFile() {
  if (!existsSync(ENV_FILE)) return {}
  const out = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

const fileEnv = readEnvFile()
const envId = target === 'prod' ? fileEnv.WXCLOUD_ENV_ID_PROD : fileEnv.WXCLOUD_ENV_ID
if (!envId) {
  console.error(`❌ .env 里没有 WXCLOUD_ENV_ID${target === 'prod' ? '_PROD' : ''}`)
  process.exit(1)
}

/** TOKEN_SECRET 生成一次就固化进 .env，避免每次部署都换密钥、把已有 token 全部作废 */
function ensureTokenSecret() {
  if (fileEnv.TOKEN_SECRET) return fileEnv.TOKEN_SECRET
  const secret = randomBytes(32).toString('hex')
  appendFileSync(ENV_FILE, `\n# 云托管服务的 TOKEN_SECRET（由 deploy-cloud.mjs 生成）\nTOKEN_SECRET=${secret}\n`)
  console.log('· 已在 .env 生成 TOKEN_SECRET')
  return secret
}

const SERVICE = 'jushuo'

/**
 * 调用 wxcloud。
 *
 * ⚠️⚠️ 必须自己 try/catch：execFileSync 抛出的 error.message 会把**完整命令行**拼进去，
 *      而命令行里有 MYSQL_PASSWORD 和 TOKEN_SECRET —— 一旦原样抛出或打印，
 *      密钥就直接落到终端和日志文件里。（本项目真实踩过。）
 */
function wxcloud(argv, opts = {}) {
  try {
    return execFileSync(BIN, argv, { cwd: ROOT, encoding: 'utf8', ...opts })
  } catch (err) {
    const captured = [err.stderr, err.stdout].filter((s) => typeof s === 'string').join('\n')
    const detail = captured.trim().split('\n').slice(-12).join('\n')
    throw new Error(
      `wxcloud ${argv[0]} 失败（退出码 ${err.status ?? '?'}）` + (detail ? `:\n${detail}` : ''),
    )
  }
}

/**
 * 云托管同一服务同一时刻只允许一个发布任务。
 * 上一轮失败/回滚的收尾期间再次发布，会直接报
 *   ResourceInUse: 当前已有部署发布任务运行中
 * 这不是真正的失败，等一下重试即可。
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- 1. 读回当前服务配置（关键：保住 MySQL 连接信息）----
console.log(`· 读取 ${target} / ${SERVICE} 当前配置…`)
const rawConfig = wxcloud(['service:config', 'read', '-e', envId, '-s', SERVICE])
// 输出首行是 CLI 版本横幅，其后才是 JSON
const jsonStart = rawConfig.indexOf('{')
const current = JSON.parse(rawConfig.slice(jsonStart))
const currentParams = current.envParams ? JSON.parse(current.envParams) : {}

// ---- 2. 合并环境变量 ----
const params = {
  ...currentParams,          // ⭐ 先铺旧的：MYSQL_ADDRESS / MYSQL_USERNAME / MYSQL_PASSWORD / MYSQL_DATABASE 全在这
  NODE_ENV: 'production',
  PORT: '3000',
  TZ: 'UTC',
  TOKEN_SECRET: ensureTokenSecret(),
  // 真实引擎（讯飞 ISE）的密钥还没配，先用 mock 打通链路
  ENGINE: 'mock',
  STORAGE: 'wxcloud',
  WX_CLOUD_ENV_ID: envId,
  // 容器启动时跑迁移 + 自举建库。⚠️ 多副本时关掉（会并发迁移），本项目副本数为 1
  AUTO_MIGRATE: 'true',
  // 深度自检（/health?deep=1）：只在 dev 开 —— 它会真的调微信开放接口和对象存储
  DIAG_ENABLED: target === 'dev' ? 'true' : 'false',
  // --reset 时删库重建；否则明确关掉，避免误删
  SCHEMA_RESET: reset ? 'true' : 'false',
  // ⭐ COS_BUCKET / COS_REGION 由下面的 resolveStorageConfig() 自动填入，不用手抄
  MIGRATIONS_DIR: 'drizzle',
  // ⚠️ 音频改为永久保留，只在检测失败时删除 —— 见 routes/submissions.ts
  DELETE_AUDIO_AFTER_SCORE: 'false',
}

// ⚠️ MYSQL_DATABASE 没配的话补一个默认库名
if (!params.MYSQL_DATABASE) params.MYSQL_DATABASE = 'jushuo'

/**
 * ⭐ 本地 .env 里的 MYSQL_* 覆盖服务配置里的同名变量。
 *
 * 为什么需要这个逃生口：云托管 MySQL 是 **serverless 实例**，
 * 内网地址在实例重建/迁移后会变，而服务环境变量不会自动跟着变 ——
 * 本项目就因此吃了 ETIMEDOUT（配置里是 10.23.106.149，真实地址已是 10.10.103.14）。
 *
 * 这条路径比去控制台手改更好：控制台改配置要求「没有部署任务在跑」，
 * 否则报 ResourceInUse；而随部署一起提交没有这个问题。
 *
 * 查真实地址的办法（CLI 没有数据库命令，但有内部 API）：
 *   DescribeWxCloudBaseRunDBClusterDetail → NetInfo.PrivateNetAddress
 */
/**
 * ⚠️ 按目标环境取对应的覆盖值：dev 读 MYSQL_*_DEV，prod 读 MYSQL_*_PROD。
 *    两个环境的密码不同，用同一个变量名会互相覆盖。
 *    也兼容不带后缀的 MYSQL_*（历史写法，仅 dev 用）。
 */
const suffix = target === 'prod' ? '_PROD' : '_DEV'
for (const k of ['MYSQL_ADDRESS', 'MYSQL_USERNAME', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']) {
  const v = fileEnv[k + suffix] ?? (target === 'dev' ? fileEnv[k] : undefined)
  if (v) params[k] = v
}

// ⭐ 对象存储桶 / 地域从 API 自动读
const storageCfg = await resolveStorageConfig(envId)
if (storageCfg) {
  params.COS_BUCKET = storageCfg.bucket
  params.COS_REGION = storageCfg.region
  console.log(`· 对象存储：${storageCfg.bucket} @ ${storageCfg.region}`)
} else {
  console.warn('⚠️ 没能读到对象存储配置 —— 提交链路读音频会失败')
}

const missing = ['MYSQL_ADDRESS', 'MYSQL_USERNAME', 'MYSQL_PASSWORD'].filter((k) => !params[k])
if (missing.length) {
  console.warn(`⚠️ 服务配置里缺少 ${missing.join(', ')} —— 容器会连不上数据库。`)
  console.warn('   请先在云托管控制台开通 MySQL，或手动补进服务环境变量。')
}

console.log('· 环境变量（值已隐去）：')
for (const k of Object.keys(params).sort()) {
  const secretish = /PASSWORD|SECRET|KEY/i.test(k)
  console.log(`    ${k} = ${secretish ? '***' : params[k]}`)
}

// ---- 3. 部署 ----
const argv = [
  'run:deploy',
  '--envId', envId,
  '--serviceName', SERVICE,
  // ⭐ 构建上下文 = 仓库根：pnpm workspace 必须能看到 pnpm-workspace.yaml 与 packages/shared
  '--targetDir', '.',
  '--dockerfile', 'apps/server/Dockerfile',
  '--containerPort', '3000',
  '--envParamsJson', JSON.stringify(params),
  '--noConfirm',
  '--override',              // 未指定的参数（cpu/mem/副本数策略）沿用旧版本
]
if (remark) argv.push('--remark', remark)
if (detach) argv.push('--detach')

console.log(`\n· 开始部署到 ${target}（envId=${envId}）…\n`)

const MAX_ATTEMPTS = 4
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    wxcloud(argv, { stdio: 'inherit' })
    process.exit(0)
  } catch (err) {
    const msg = err.message ?? ''
    const busy = /ResourceInUse|部署发布任务运行中/.test(msg)
    if (busy && attempt < MAX_ATTEMPTS) {
      console.log(`\n· 已有发布任务在跑，60 秒后重试（${attempt}/${MAX_ATTEMPTS}）…`)
      await sleep(60_000)
      continue
    }
    console.error(`\n❌ 部署失败：${msg}`)
    process.exit(1)
  }
}
