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
 *   ① 根 .env 里有 WXCLOUD_APPID / WXCLOUD_CLI_SECRET（账号级，两个环境共用）
 *   ② .env.dev / .env.prod 里有目标环境自己的 WXCLOUD_ENV_ID 与 MYSQL_*
 *   ③ 先 wxcloud login --appId <AppID> --privateKey <CLI密钥>
 *
 * ⚠️ 环境变量分层见 tools/env.mjs：部署 dev 只加载 .env + .env.dev。
 *    所以本机的 ENGINE=mock / STORAGE=local 再也盖不到云端 —— 那正是过去的坑
 *    （两个 .env 混着读，本机的 mock 把云端的自动判据整个顶住）。
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { envFileOf, loadEnv, ROOT, writeEnvVar } from './env.mjs'

const BIN = resolve(ROOT, 'node_modules/.bin/wxcloud')

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

// ---- 读环境变量：**只加载属于本次目标的那两份** ----
// ⚠️ loadEnv 会把结果写进 process.env（真实环境变量优先），所以下面一律读 process.env
loadEnv(target)
/** 目标环境自己的那份文件（TOKEN_SECRET 会写回这里） */
const TARGET_ENV_FILE = envFileOf(target)

/** 讯飞凭据的三个键 —— 缺一不可，缺任何一个都不能切真引擎 */
const XFYUN_KEYS = ['XFYUN_APP_ID', 'XFYUN_API_KEY', 'XFYUN_API_SECRET']

/**
 * ⭐ 小程序凭据（AppID + AppSecret）—— **服务端要用的**，必须推到服务环境变量里。
 *
 * ⚠️ 为什么必须跟着部署走：容器里 process.env 是**这份 envParams 说了算**，
 *    不推上来，服务端读到的就是空的 —— 而症状是「本地好好的，云上标准音灌不进去」。
 * 用途：① 对象存储的经典 HTTPS 接口（/tcb/*，换 access_token）
 *      ② code2session 登录降级路径
 */
const WX_KEYS = ['WX_APPID', 'WX_SECRET']

/**
 * ⭐ 引擎选择：**有完整凭据就用真引擎**，否则退回 mock。
 * ⚠️ 真引擎**按调用计费**，所以这个选择必须显式可覆盖：设 `ENGINE=mock` 可强制回退。
 *    刻意不写死 —— 写死 mock 会让「配了密钥却一直是假结果」这种问题藏很久
 *    （本项目已经藏了一整轮）。
 */
function resolveEngine() {
  // ⚠️ ENGINE 现在天然分环境：.env.local 的 mock 根本不会被加载进来
  //    （部署 dev 只读 .env + .env.dev）。显式值优先，没写才按凭据自动判。
  const forced = process.env.ENGINE
  if (forced) return forced
  return XFYUN_KEYS.every((k) => process.env[k]) ? 'xfyun' : 'mock'
}
// ⚠️ 两个文件里**键名相同**（都叫 WXCLOUD_ENV_ID）—— 文件名本身就是环境标识，
//    加 _DEV / _PROD 后缀等于把「哪份文件管哪个环境」这件事写在两个地方。
const envId = process.env.WXCLOUD_ENV_ID
if (!envId) {
  console.error(`❌ .env.${target} 里没有 WXCLOUD_ENV_ID`)
  console.error(`   （环境变量按 tools/env.mjs 分层：部署 ${target} 只读 .env + .env.${target}）`)
  process.exit(1)
}

/**
 * TOKEN_SECRET 生成一次就固化进**该环境自己的** .env，避免每次部署都换密钥、
 * 把已有 token 全部作废。
 * ⚠️ 写到 .env.<target> 而不是公用 .env：dev 和 prod 不该共用一份会话密钥
 *    （共用的话，dev 泄露就等于 prod 泄露，而它们本可以互不相干）。
 */
function ensureTokenSecret() {
  if (process.env.TOKEN_SECRET) return process.env.TOKEN_SECRET
  const secret = randomBytes(32).toString('hex')
  writeEnvVar(TARGET_ENV_FILE, 'TOKEN_SECRET', secret)
  console.log(`· 已在 .env.${target} 生成 TOKEN_SECRET`)
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
  // ⭐ 引擎：凭据齐全就用讯飞真引擎（见 resolveEngine）
  ENGINE: resolveEngine(),
  STORAGE: 'wxcloud',
  WX_CLOUD_ENV_ID: envId,
  // 容器启动时跑迁移 + 自举建库。⚠️ 多副本时关掉（会并发迁移），本项目副本数为 1
  AUTO_MIGRATE: 'true',
  // ⭐ 云上 Dockerfile 的 CMD 不 seed，不开这个 dev 环境就是空句库（真机朗读页读不到正文）
  SEED_ON_START: target === 'dev' ? 'true' : 'false',
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

// ⭐ 讯飞凭据 —— 公用 .env 里的（两个环境共用同一个讯飞应用）
// ⚠️ 只在**有值**时写入：显式写 undefined 会被 JSON.stringify 丢掉，
//    反而把服务上原有的值抹掉。
for (const k of XFYUN_KEYS) {
  if (process.env[k]) params[k] = process.env[k]
}

// ⭐ 小程序凭据同上：**只在有值时写**，否则会把服务上已有的值抹掉
for (const k of WX_KEYS) {
  if (process.env[k]) params[k] = process.env[k]
}

if (params.ENGINE === 'xfyun' && !XFYUN_KEYS.every((k) => params[k])) {
  console.warn('⚠️ ENGINE=xfyun 但凭据不全，容器会启动失败或全部评测报错：')
  console.warn('   ' + XFYUN_KEYS.map((k) => k + '=' + (params[k] ? '有' : '❌缺')).join('  '))
}
console.log(`· 评测引擎：${params.ENGINE}` + (params.ENGINE === 'xfyun' ? '（真实调用，按次计费）' : '（假结果，仅开发用）'))

// ⚠️ 缺这两个键不阻断部署（本地 STORAGE=local 时用不到），
//    但云上是 STORAGE=wxcloud：缺了就是「标准音灌不进去、登录降级路径也走不通」，
//    而报错发生在启动之后很远的地方 —— 所以在部署这一刻就说清楚。
const wxMissing = WX_KEYS.filter((k) => !params[k])
if (wxMissing.length > 0) {
  console.warn(`⚠️ 服务环境变量里缺 ${wxMissing.join(', ')}：`)
  console.warn('   对象存储（/tcb/* 经典 HTTPS 接口）与 code2session 都会失败。')
  console.warn('   填法：**公用** .env 里加 WX_APPID= / WX_SECRET= （两个环境共用同一个小程序），再重新部署。')
}

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
 * ⭐ 目标环境的 MySQL 连接信息覆盖服务配置里的同名变量。
 *
 * ⚠️ 键名不带后缀：dev 的那份在 .env.dev、prod 的在 .env.prod，
 *    **文件名就是环境标识**。以前是 MYSQL_*_DEV / MYSQL_*_PROD 挤在同一份文件里，
 *    读的时候还要拼后缀 —— 那等于把「哪份配置管哪个环境」写在两个地方。
 */
for (const k of ['MYSQL_ADDRESS', 'MYSQL_USERNAME', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']) {
  const v = process.env[k]
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
