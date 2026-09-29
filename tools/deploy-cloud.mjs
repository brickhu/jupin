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
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { envFileOf, loadEnv, ROOT, writeEnvVar } from './env.mjs'

const BIN = resolve(ROOT, 'node_modules/.bin/wxcloud')

// CLI 内部没有暴露对象存储命令，只有这个环境查询接口带着 Storages 字段
const require = createRequire(resolve(ROOT, 'package.json'))
const {
  DescribeWxCloudBaseRunEnvs,
  DescribeCloudBaseRunServer,
  // ⭐ 失败诊断用：拉平台侧的构建事件（见 waitForNewVersion 里那段说明）
  DescribeCloudBaseRunProcessLog,
  // ⭐ `--image` 用：镜像地址只在**版本详情**里，列表接口不返回它（实测踩到）
  DescribeCloudBaseRunServerVersion,
} = require(
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
/**
 * ⚠️⚠️ 版本备注**必须永远给一个**，哪怕是兜底的。
 *
 *    CLI 的参数清单里 remark 是唯一"不给就问"的一项：一旦缺省，
 *    它会打印「请输入版本备注:」然后**读 stdin 干等**。人在终端里还能敲一行，
 *    CI 里没有 stdin ⇒ job 一直挂到超时（表现为"部署卡住"，而不是报错）。
 *    备注只是给人看的，所以兜底比留空强。
 */
const remark =
  (remarkIdx >= 0 ? args[remarkIdx + 1] : undefined) ??
  new Date().toISOString().slice(0, 16).replace('T', ' ')
const detach = args.includes('--detach')
/** ⚠️ --reset：一次性删库重建（无数据环境 schema 重构用，生产环境勿用） */
const reset = args.includes('--reset')
/**
 * ⭐⭐ `--image`：**自己打镜像 + 按不可变 tag 发布**（2026-09-29 加）。
 *
 * ⚠️⚠️ 为什么要有这条路：平台侧的「源构建」会**间歇性卡死**在
 *    `create_build_image : creating`（脚本注释里记过），卡住时**连版本记录都不产生**，
 *    而且一次卡住会把该服务后续的构建一起堵死 —— 实测为此连续几次部署全部无版本产生。
 *    `--image` 把"构建"这一步搬到我们这边（CI 的 ubuntu runner / 本机 Docker）：
 *      1. 从当前服务的版本里**读出镜像仓库地址**（不写死，dev/prod 各自不同）；
 *      2. `docker build` + `docker push`，tag 用**提交 SHA**（不可变，可回溯）；
 *      3. `run:deploy --libraryImage <tag>`：平台只负责拉镜像起容器，不再自己构建。
 *    ⇒ 构建失败会在我们自己的日志里、带完整报错；平台那步只剩"拉镜像+起容器"。
 *
 * ⚠️ 需要镜像仓库凭据（CCR_USERNAME / CCR_PASSWORD）——见 tools/gh-secrets.mjs。
 */
const useImage = args.includes('--image')
const imageTagOverride = (() => {
  const i = args.indexOf('--image-tag')
  return i >= 0 ? args[i + 1] : undefined
})()
const USAGE = [
  '用法：node tools/deploy-cloud.mjs [dev|prod] [选项]',
  '',
  '选项：',
  '  --remark <说明>    版本备注（CI 传 "CI dev <sha>"；缺省用时间戳）',
  '  --image            自己 build + push 镜像，再按不可变 tag 发布（推荐）',
  '  --image-tag <tag>  直接指定镜像 tag（调试用，跳过 build/push）',
  '  --detach           不等部署结果',
  '  --reset            ⚠️ 删库重建（仅无数据环境）',
  '  --help             看这段说明',
].join('\n')

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

/**
 * ⚠️⚠️ **未知参数一律报错退出**（2026-09-29 加，起因是一次真实的误操作）：
 *    我拿 `--help` 试脚本（那时还没有 help），它被当成"没见过的参数"**静默忽略**，
 *    于是脚本**真的开始部署 dev** —— 而当时工作区里有 26 个未提交的文件。
 *    （那次侥幸没造成后果：进程在平台创建版本之前被我杀掉，云上版本数没变。）
 *    ⇒ 部署脚本必须"只认自己认识的参数"：打错一个字应该**报错**，而不是默默发一次。
 */
const KNOWN_WITH_VALUE = ['--remark', '--image-tag']
const KNOWN_FLAGS = ['--detach', '--reset', '--image']
const unknown = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (!a.startsWith('--')) continue
  if (KNOWN_WITH_VALUE.includes(a)) {
    i++
    continue
  }
  if (!KNOWN_FLAGS.includes(a)) unknown.push(a)
}
if (unknown.length) {
  console.error(`❌ 不认识的参数：${unknown.join(' ')}（不会"忽略后继续"——那可能默默发一次部署）\n\n${USAGE}`)
  process.exit(1)
}

if (!['dev', 'prod'].includes(target)) {
  console.error(USAGE)
  process.exit(1)
}

/**
 * ⭐⭐ **prod 不许 --reset**（2026-09 加）。
 *
 * ⚠️ 这条不是"防手滑"，是防**一条命令毁掉生产库**：
 *    `--reset` 会一路传到容器（SCHEMA_RESET=true）→ `DROP DATABASE IF EXISTS`（db/index.ts），
 *    而且部署用的是 `--noConfirm`，**全程没有第二次确认**。
 *    原来唯一的防线是那句注释（"生产环境勿用"）和"人记得别敲"。
 *
 * ⚠️ 刻意**不留** `--i-know-what-im-doing` 这类逃生门：真要重建生产库，
 *    正确做法是去云控制台手工操作（那一步天然需要人看着）；
 *    留一个开关只会让"某天有人加上它"变成下一次事故的入口。
 */
if (target === 'prod' && reset) {
  console.error(
    '\n❌ 拒绝对 prod 使用 --reset：它会 DROP 掉生产库，且这一步没有二次确认。\n' +
      '   真要在生产上重建 schema：请去云控制台手工执行，并先确认备份。\n' +
      '   （对 dev 用 --reset 不受影响。）',
  )
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

const SERVICE = 'jupin'

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

/**
 * ⭐ 跑一条外部命令（docker 用），把输出直接透到终端。
 * ⚠️ 失败时**只抛出最后几行**（同 wxcloud 的理由：命令里可能带凭据，别整段回显）。
 */
function run(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts })
  } catch (err) {
    throw new Error(`${cmd} ${argv.slice(0, 3).join(' ')} … 失败（退出码 ${err.status ?? '?'}）`)
  }
}

/**
 * ⭐ 镜像仓库地址**从平台读**，不写死。
 *    取最近一个版本的 ImageUrl，把 tag 去掉即得仓库（如
 *    `ccr.ccs.tencentyun.com/tcb-xxxx/ca-yyyy_jupin`）——
 *    dev 与 prod 的仓库路径不同，写死必然错一个。
 */
async function imageRepoOf() {
  const fromEnv = (process.env.CCR_REPO ?? '').trim()
  if (fromEnv) return fromEnv.replace(/:[^/:]+$/, '')
  /**
   * ⚠️⚠️ `ImageUrl` **只在版本详情接口里**（`DescribeCloudBaseRunServerVersion`），
   *    列表接口 `DescribeCloudBaseRunServer` 不返回它 ——
   *    一开始按列表写，实测直接抛"读不到镜像仓库地址"（服务明明有镜像）。
   */
  const r = await DescribeCloudBaseRunServer({ EnvId: envId, ServerName: SERVICE, Offset: 0, Limit: 30 })
  const versions = [...(r.VersionItems ?? [])]
    .filter((v) => typeof v.VersionName === 'string')
    .sort((a, b) => String(b.CreatedTime).localeCompare(String(a.CreatedTime)))
  let lastErr = ''
  for (const v of versions.slice(0, 6)) {
    try {
      const d = await DescribeCloudBaseRunServerVersion({
        EnvId: envId,
        ServerName: SERVICE,
        VersionName: v.VersionName,
      })
      const detail = d?.VersionItems?.[0] ?? d
      const url = detail?.ImageUrl
      if (typeof url === 'string' && url.includes('/')) return url.replace(/:[^/:]+$/, '')
    } catch (e) {
      /**
       * ⚠️ 不要静默吞：我第一版就是 catch {} 什么都不留，
       *    结果报出的是"没有 ImageUrl"——而真因是 `DescribeCloudBaseRunServerVersion is not defined`
       *    （漏了 import）。**错误信息误导比报错更贵**。这里留住最后一条真实原因。
       */
      lastErr = String(e?.message ?? e ?? '').slice(0, 200)
    }
  }
  throw new Error(
    '读不到镜像仓库地址（该服务的版本里都没有 ImageUrl）—— 可用 CCR_REPO=<ccr.ccs.tencentyun.com/ns/repo> 显式指定' +
      (lastErr ? `\n   最后一次查询的真实原因：${lastErr}` : ''),
  )
}

/** 不可变 tag：提交 SHA 前 12 位（CI 用 GITHUB_SHA，本机用 git） */
function imageTagOf(repo) {
  if (imageTagOverride) return imageTagOverride
  const sha = (process.env.GITHUB_SHA ?? '').trim()
  const short = sha
    ? sha.slice(0, 12)
    : execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  return `${repo}:${short}`
}

/**
 * 自己构建并推送镜像。
 *
 * ⚠️ 登录凭据来自 CCR_USERNAME / CCR_PASSWORD（腾讯云镜像仓库的访问凭证）。
 *    没配就直接失败并说清怎么办 —— 不要退化成"静默走源构建"：
 *    那会让人以为 `--image` 生效了，而实际上又踩回那个会卡的死路。
 */
function buildAndPushImage(tag) {
  const user = (process.env.CCR_USERNAME ?? '').trim()
  const pass = (process.env.CCR_PASSWORD ?? '').trim()
  if (!user || !pass) {
    throw new Error(
      '镜像方式部署需要 CCR_USERNAME / CCR_PASSWORD（腾讯云「容器镜像服务 → 访问凭证」）。\n' +
        '   CI 里把它们加成仓库 secrets；本机可以临时 export。',
    )
  }
  const registry = tag.split('/')[0]
  console.log(`· docker login ${registry} …`)
  run('docker', ['login', registry, '-u', user, '--password-stdin'], { input: pass, stdio: 'inherit' })
  console.log(`· docker build -f apps/server/Dockerfile -t ${tag} .`)
  run('docker', ['build', '-f', 'apps/server/Dockerfile', '-t', tag, '.'])
  console.log(`· docker push ${tag}`)
  run('docker', ['push', tag])
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
  /**
   * ⭐ 云上 Dockerfile 的 CMD 不 seed，不开这个 dev 环境就是空句库（真机朗读页读不到正文）。
   *
   * ⚠️⚠️ **必须先看环境变量**：`.github/workflows/deploy.yml` 会把仓库变量
   *    `vars.SEED_ON_START` 传进来，用来做"prod 首次部署灌一次种子"。
   *    这里原来是硬编码 `target === 'dev' ? 'true' : 'false'` ⇒ 那个 Variable
   *    从来没有被读过，**prod 首次部署灌种子这条路是假的**（文档与 workflow 注释都以为它生效）。
   * ⚠️ 缺省仍然是"dev 开 / prod 关"：prod 每次冷启动都灌种子既慢又没必要。
   */
  SEED_ON_START: process.env.SEED_ON_START ?? (target === 'dev' ? 'true' : 'false'),
  // 深度自检（/health?deep=1）：只在 dev 开 —— 它会真的调微信开放接口和对象存储
  DIAG_ENABLED: target === 'dev' ? 'true' : 'false',
  // --reset 时删库重建；否则明确关掉，避免误删
  SCHEMA_RESET: reset ? 'true' : 'false',

  /**
   * ⭐⭐ 支付环境：**dev 永远沙箱，prod 永远现网**。
   *
   * ⚠️⚠️ 这一条绝不能让人手填：env 的默认值是 0（现网），
   *    而「忘了配」在 dev 上的后果是 **测试的时候真扣钱** ——
   *    更糟的是它**不会报错**（支付照常成功，只是花了真钱）。
   *    放在这里 = 由目标环境结构性决定，和 ENGINE / SEED_ON_START 同一套做法。
   * ⚠️ 反过来 prod 必须是 0：腾讯规定「现网版本的 env 只能是 0」（报错 -15011），
   *    填错的话线上会直接付不了款（这是期望中的 fail closed）。
   */
  XPAY_ENV: target === 'dev' ? '1' : '0',
  // ⚠️ mock 通道只属于本机：云上必须走真实虚拟支付（PAY 的默认值本来就是 xpay）
  PAY: 'xpay',
  // ⭐ COS_BUCKET / COS_REGION 由下面的 resolveStorageConfig() 自动填入，不用手抄
  MIGRATIONS_DIR: 'drizzle',
  // ⚠️ 音频改为永久保留，只在检测失败时删除 —— 见 routes/submissions.ts
  DELETE_AUDIO_AFTER_SCORE: 'false',
  /**
   * ⭐⭐ 旁加载（开放接口服务）用的是**自签证书**，而 Node 自带一份根证书链、不认它。
   *     官方《云调用常见问题》给的正是这一条：
   *       「部分自带根证书的运行时，需要手动设置证书，证书目录为 /app/cert/certificate.crt」
   *     ⚠️ 必须在**进程启动前**由环境变量给出（Node 只在启动时读它），
   *        所以只能放服务环境变量，不能在代码里补。
   *     ⚠️ 没这个的话，容器里对 api.weixin.qq.com 的 HTTPS 请求会报
   *        `fetch failed ← self-signed certificate` —— 而这句话离「证书」很远，很难查。
   */
  NODE_EXTRA_CA_CERTS: '/app/cert/certificate.crt',
}

// ⚠️ MYSQL_DATABASE 没配的话补一个默认库名
if (!params.MYSQL_DATABASE) params.MYSQL_DATABASE = 'jushuo'

// ⭐ 讯飞凭据 —— 公用 .env 里的（两个环境共用同一个讯飞应用）
// ⚠️ 只在**有值**时写入：显式写 undefined 会被 JSON.stringify 丢掉，
//    反而把服务上原有的值抹掉。
/**
 * ⭐ 内容管理接口的口令（`/api/admin/*` 的 ADMIN_TOKEN）。
 *
 * ⚠️⚠️ 这个脚本**不是"把 .env 全量传给服务"** —— 它只显式列关键键
 *    （见下面 XFYUN / XPAY 两个循环）。所以新加一个服务端环境变量时，
 *    **必须在这里也加一行**，否则本机 `.env.<env>` 里配得好好的，
 *    云上却是停的：症状是 `/api/admin/*` 返回 503「服务端没有配置 ADMIN_TOKEN」，
 *    而"我明明配了"会让人完全找错方向（这与 SEED_ON_START 那次是同一类坑）。
 * ⚠️ 没配就**不传**（而不是传空串）：服务端对"没配"的处置是 503 拒绝服务，
 *    比"配了一个空口令"更安全、也更好排查。
 */
if (process.env.ADMIN_TOKEN) params.ADMIN_TOKEN = process.env.ADMIN_TOKEN

for (const k of XFYUN_KEYS) {
  if (process.env[k]) params[k] = process.env[k]
}

/**
 * ⭐ 虚拟支付凭据（见 docs/design/payment-and-purchase.md §9）。
 *
 * ⚠️ **只在有值且不是占位符时写入**：`.env` 里把道具 ID 留成 `...` 是很自然的做法，
 *    而把 `...` 注入进去的后果是「服务以为自己配好了道具」，
 *    然后在微信侧报 -15010 / -15013 —— 离真正的原因（还没建道具）很远。
 * ⚠️ 不过滤 OfferID / AppKey 的占位符，是因为它们更短、更容易误判；
 *    那三个道具 ID 才是最可能被留成占位符的。
 */
const XPAY_KEYS = [
  'XPAY_OFFER_ID',
  'XPAY_APP_KEY',
  'XPAY_SANDBOX_APP_KEY',
  'XPAY_PRODUCT_ENERGY_10',
  'XPAY_PRODUCT_ENERGY_300',
  'XPAY_PRODUCT_ENERGY_3000',
  'XPAY_PRODUCT_ENERGY_10_SANDBOX',
  'XPAY_PRODUCT_ENERGY_300_SANDBOX',
  'XPAY_PRODUCT_ENERGY_3000_SANDBOX',
]
/** 占位符守卫：值必须像真的（字母数字，长度 >= 4），否则当没配 */
const isRealValue = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{4,}$/.test(v)
for (const k of XPAY_KEYS) {
  const v = process.env[k]
  if (isRealValue(v)) params[k] = v
  /**
   * ⚠️⚠️ 有值但被跳过时**必须出声**。
   *    这个守卫曾经**静默**过滤掉两个 AppKey —— 因为 .env 里那两行尾部带了
   *    `# 现网` 这样的行内注释，值变成了 `abc123 # 现网`。
   *    结果：服务端 offerId 有、appKey 没有，购买页永远买不了，
   *    而 CI 日志里一行异常都没有。（后来是 /health 的 pay 块照出来的。）
   */
  if (v !== undefined && v !== '' && !isRealValue(v)) {
    console.warn('⚠️ ' + k + ' 的值不像有效凭据（长度或字符不合规），已跳过 —— 检查 .env 里是不是带了行内注释')
  }
}

/**
 * ⭐ AI 教练用的大模型（出「点评 + 提升建议」）。
 * ⚠️ 三个都只在**有值**时写入 —— 没配 = 这个功能在云端整个关掉，
 *    不产生任何费用（每次提交都要调一次，属于要花钱的能力）。
 * ⚠️ 三个必须**一起**带上：只给 key 不给 baseUrl/model 会退到默认的
 *    DeepSeek 与 deepseek-chat，可能不是你想用的那个。
 */
for (const k of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) {
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

/**
 * ⚠️⚠️ `--override` 只能用在**已有版本的**服务上。
 *
 *    它的语义是「缺省的参数沿用上一个版本」，而 CLI 的实现是去读
 *    DescribeCloudBaseRunServer 的第一个版本、再拿它的 VersionName 查详情 ——
 *    全新服务没有版本，VersionName 就是 undefined，接口直接报 MissingParameter，
 *    整个部署失败（而报错信息离"新服务"这个原因很远）。
 *
 *    ⇒ 没有版本时不带它：反正也没有"上一个版本"可继承，
 *      而其余参数（targetDir/dockerfile/port/releaseType/remark）我们都显式给了，
 *      所以 CLI 不会弹交互式提问。
 */
async function serviceHasVersion() {
  try {
    const r = await DescribeCloudBaseRunServer({ EnvId: envId, ServerName: SERVICE, Offset: 0, Limit: 1 })
    return (r.VersionItems ?? []).length > 0
  } catch {
    // 服务不存在等情况：交给 run:deploy 自己报错，别在这里抢戏
    return false
  }
}
const firstDeploy = !(await serviceHasVersion())

/**
 * ⭐⭐ 镜像模式：**先把镜像推上去，再让平台只负责拉**（2026-09-29 加，见 --image 的说明）。
 *    ⚠️ 这一步放在 `run:deploy` 之前：镜像没推成功就根本不该去动服务。
 */
let imageTag = ''
if (useImage) {
  const repo = await imageRepoOf()
  imageTag = imageTagOf(repo)
  console.log(`· 镜像方式部署：${imageTag}`)
  buildAndPushImage(imageTag)
}

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
]
/**
 * ⚠️ 镜像模式下必须**同时**给 --libraryImage 与 --targetDir/--dockerfile：
 *    CLI 靠 libraryImage 决定"不构建、直接拉"，但缺了 targetDir 它会去问交互式问题
 *    （CI 里没有 stdin ⇒ 卡到超时）。
 */
if (useImage) argv.push('--libraryImage', imageTag)
if (firstDeploy) {
  console.log(`· ${SERVICE} 还没有任何版本 —— 首次部署，不带 --override`)
} else {
  argv.push('--override') // 未指定的参数（cpu/mem/副本数策略）沿用旧版本
}
if (remark) argv.push('--remark', remark)
if (detach) argv.push('--detach')

console.log(`\n· 开始部署到 ${target}（envId=${envId}）…\n`)

/** 当前服务已有的版本名 */
async function versionNames() {
  try {
    const r = await DescribeCloudBaseRunServer({ EnvId: envId, ServerName: SERVICE, Offset: 0, Limit: 20 })
    return new Set((r.VersionItems ?? []).map((v) => v.VersionName))
  } catch {
    return new Set()
  }
}

/**
 * ⭐ 等这一次提交产生的新版本进入终态，并返回它。
 *
 * ⚠️⚠️ 为什么不能只靠 CLI 的返回值判断成败：
 *    「创建实例」这一步会**间歇性地 create_failed**（构建明明成功，最后一步炸），
 *    而这时的 CLI **既不报错也不返回，就那样挂着** —— 实测挂了 20 分钟没动静。
 *    CI 里那就是一路占着 runner 直到 job 超时。
 *    ⇒ 所以这里自己按版本状态判定：normal = 成功，create_failed = 可重试的失败。
 *
 * ⚠️⚠️⚠️ 但"出现了一个新版本"**不等于**"我们的新代码上台了"（2026-09-29 踩到，很隐蔽）：
 *    平台会因为**配置变更**（比如随部署一起写的环境变量）自己造一个版本，
 *    特征是 `BuildId=0` / `UploadType=image` / 备注由平台生成（"server config change"）——
 *    **里面没有我们的任何新代码**。
 *    原实现只要"新版本名 + 状态 normal"就报成功 ⇒ 脚本打印 ✅，
 *    而线上跑的还是上一个版本的代码（现象：**CI 全绿，但新接口在 dev 上根本不存在**，
 *    用户看到的就是"api docs 里只有 1 个接口"）。
 *    ⇒ 判据改成：**备注必须等于我们这次传的 remark**（CI 传的是 `CI dev <sha>`）。
 *      平台的配置变更版本备注对不上，会被明确跳过而不是被当成成功。
 */
async function waitForNewVersion(before) {
  const DEADLINE = Date.now() + 12 * 60_000
  let last = ''
  const skipped = new Set()
  while (Date.now() < DEADLINE) {
    await sleep(10_000)
    let items = []
    try {
      const r = await DescribeCloudBaseRunServer({ EnvId: envId, ServerName: SERVICE, Offset: 0, Limit: 20 })
      items = r.VersionItems ?? []
    } catch {
      continue
    }
    const fresh = items.filter((v) => !before.has(v.VersionName))
    if (fresh.length === 0) continue
    /**
     * ⚠️ 只认**我们这次提交**的版本：备注对不上的（平台配置变更版本）跳过并说明原因，
     *    免得它把"部署成功"这个结论偷走。
     */
    const ours = fresh.filter((v) => v.Remark === remark)
    for (const other of fresh.filter((v) => v.Remark !== remark && !skipped.has(v.VersionName))) {
      skipped.add(other.VersionName)
      console.log(
        `· 跳过 ${other.VersionName}：备注是「${other.Remark ?? ''}」而不是我们这次的「${remark}」` +
          `（BuildId=${other.BuildId ?? '?'}）—— 平台为配置变更造的版本，不含本次代码`,
      )
    }
    if (ours.length === 0) continue
    // 取最新提交的那个
    const v = ours.sort((a, b) => String(a.CreatedTime).localeCompare(String(b.CreatedTime))).at(-1)
    if (v.Status !== last) {
      last = v.Status
      console.log(`· ${v.VersionName} 状态：${v.Status}`)
    }
    if (v.Status === 'normal') return { ok: true, name: v.VersionName }
    if (v.Status === 'create_failed' || v.Status === 'failed') {
      /**
       * ⭐⭐ 失败时**把平台的构建事件拉出来**（2026-09 加，起因是 CI 反复 create_failed）。
       *
       * ⚠️⚠️ 为什么要它：`create_failed` 有两种完全不同的成因，而它们**长得一样**：
       *    ① 我们的 Dockerfile 构建失败 —— 构建日志里会有报错行；
       *    ② **平台侧的「构建镜像」被创建出来之后卡住** —— 我们这边的构建日志
       *       停在 `ZIP package extracted.` 之后一行都没有，什么线索都给不出来。
       * ⚠️⚠️⚠️ 还有一条**更隐蔽的连带效应**（2026-09-29 实测确认，代价是几小时）：
       *    **平台侧卡住的构建会把这个服务后续的构建一起堵死** ——
       *    现象：连续几次 CI 部署都"创建不出任何版本"（版本列表里连一行新记录都没有），
       *    而最后一次成功的版本（jupin-094）明明还在。
       *    那天的事实链：run 79 的构建卡在 `create_build_image : creating`（平台侧），
       *    它的 CI job 一直挂着 ⇒ 我**取消那个 CI job** 之后，紧接着一次干净部署
       *    **几十秒内就走完了** `create_build_image → check_build_image : succ → 部署完成`。
       *    ⇒ 结论：遇到"怎么也造不出新版本"时，先确认**有没有一个已卡的构建**
       *      （版本列表里最新的那条是不是 `create_build_image : creating` 挂着），
       *      把**发起那次构建的 CI run 取消掉**，再重发 —— 而不是反复重试。
       *      ⚠️ 注意：取消 CI job **不会**杀平台侧的构建任务，但能让我们这边重新排队成功。
       *
       *    实测（jupin-084 / jupin-088）：进程日志只有
       *      `create_build_image : creating` 一行，然后 **10 分钟后被平台判失败**。
       *    不把这一行打出来，排查的人只会盯着我们的 Dockerfile 看 —— 而问题不在那儿。
       */
      try {
        const detail = await DescribeCloudBaseRunServer({
          EnvId: envId,
          ServerName: SERVICE,
          Offset: 0,
          Limit: 20,
        })
        const full = (detail.VersionItems ?? []).find((x) => x.VersionName === v.VersionName)
        if (full?.RunId) {
          const proc = await DescribeCloudBaseRunProcessLog({ EnvId: envId, RunId: full.RunId })
          const logs = (proc?.Logs ?? []).slice(-6)
          if (logs.length) {
            console.log(`· ${v.VersionName} 的平台构建事件：`)
            for (const l of logs) console.log('    ' + String(l).trim())
            if (String(logs.at(-1)).includes('create_build_image')) {
              console.log(
                '  ⚠️ 只见「创建构建镜像」、没有后续事件 ⇒ **平台侧卡住**，不是我们的 Dockerfile 失败\n' +
                  '     （我们的镜像正常只要 ~80 秒：见同一服务里成功版本的构建日志）',
              )
            }
          }
        }
      } catch {
        /* 拉不到就算了：诊断信息不该把部署本身搞失败 */
      }
      return { ok: false, name: v.VersionName }
    }
  }
  /**
   * ⚠️⚠️ 超时**必须把"这次到底出现了什么版本"打出来**（2026-09-29 加）。
   *
   *    起因：CI 全绿，但线上还是旧代码（用户看到的是"api docs 只有 1 个接口"）。
   *    复盘时手上只有一句"超时未出结果"，而真正的事实是
   *    **平台只造了一个"配置变更"版本、压根没造代码版本** ——
   *    不把版本清单打出来，下一个人还要再查一遍。
   */
  try {
    const r = await DescribeCloudBaseRunServer({ EnvId: envId, ServerName: SERVICE, Offset: 0, Limit: 20 })
    const all = [...(r.VersionItems ?? [])].sort((a, b) =>
      String(a.CreatedTime).localeCompare(String(b.CreatedTime)),
    )
    console.log(`\n· 超时 —— 这次等的是备注为「${remark}」的版本。最近的版本清单：`)
    for (const v of all.slice(-5)) {
      console.log(
        `    ${v.VersionName} | ${v.Status} | 备注「${v.Remark ?? ''}」| BuildId=${v.BuildId ?? '?'} | ` +
          `${v.UploadType ?? '?'} | ${v.CreatedTime} | 流量=${v.FlowRatio ?? 0}%`,
      )
    }
    if (all.filter((v) => v.Remark === remark).length === 0) {
      console.log(
        '  ⚠️ 一个属于本次提交的版本都没有 ⇒ **平台没为这次部署造出代码版本**（构建那一步就没了）。\n' +
          '     常见成因：平台侧「创建构建镜像」卡住（脚本注释里记过），或上传包过大被静默拒绝。\n' +
          '     ⚠️ 此时**不要**把"有一个新版本变 normal"当成成功 —— 那可能是平台的配置变更版本，里面没有本次代码。',
      )
    }
  } catch {
    /* 清单只是一份诊断，拉不到就算了 */
  }
  return { ok: false, name: '(超时未出结果)' }
}

/**
 * ⭐⭐ 上传包体积闸门（2026-09 加，起因是一次真实的 `create_failed`）。
 *
 * 事故：CLI 会把**整个仓库根**打成 zip 传上去，而 `.dockerignore` 只管 Docker 构建上下文、
 *      **管不到这个上传包**。本机的 pnpm store（`.pnpm-home` 487M）与一批 `.tmp-*`
 *      临时目录（实测 .tmp-ecdict 88M）被一起打包 ⇒ 包撑到 ~90MB，
 *      云端在"创建实例"那一步**静默失败**（`create_failed`，构建日志里一行报错都没有）。
 *      当时的判断全被带偏：查 CI、查镜像、查配置，查了几小时。
 *
 * ⇒ 部署前先量一遍"按当前 .dockerignore 会传上去什么"，超过阈值**直接在此拦下**：
 *    · > WARN  ：只警告（可能是正常的代码增长，人自己判断）
 *    · > FAIL  ：不再往下走 —— 继续发也是大概率 create_failed，还把发布次数耗掉
 *
 * ⚠️ 量的是**未压缩总量**（不解压不压缩，快且稳定）：实测 6MB 级是健康值，
 *    超过 40MB 基本就是有本机目录混进来了。
 * ⚠️ 判据用 CLI **真正读的那个**函数（getDockerIgnore），不是我们自己的复制品 ——
 *    否则闸门守的是一份"我们以为的规则"。
 */
const PKG_WARN_BYTES = 40 * 1024 * 1024
const PKG_FAIL_BYTES = 80 * 1024 * 1024

/**
 * @param req 注入的 createRequire（**故意从参数进来**而不是函数里读 import.meta）：
 *            这样这个函数能被单独抽出来测 —— 它上一版就是"抽出来测不了、
 *            于是量错了也没人发现"。
 */
/**
 * 把 `.dockerignore` 的模式匹配成"这个相对路径排没排掉"。
 *
 * ⚠️⚠️ 为什么不 require minimatch（第一版就是这么写的，两次都错）：
 *    ① 这个仓库用 pnpm 的隔离布局，`require('minimatch')` 在根目录**解析不到**
 *       （只有 .pnpm 里有一份 3/5/10 三个版本），于是闸门静默跳过 —— 等于没写；
 *    ② 退化成手写 `===` 比较更糟：`.tmp-*` 这种**通配**规则永远匹配不到 `.tmp-ecdict`，
 *       量出的包比真包大一倍多，把一个正常的部署直接拦死（假阳比漏报更坏）。
 *    ⇒ 只支持这个文件真正用到的两种通配，自己实现，零依赖、可单独验证：
 *       `**​/` 前缀（匹配任意层）与 `*`（不跨 `/`）。
 */
function ignoreHit(rel, pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/, '\\$&')
    }
  }
  return new RegExp('^' + re + '$').test(rel)
}

/**
 * @param req 注入的 createRequire（**故意从参数进来**而不是函数里读 import.meta）：
 *            这样这个函数能被单独抽出来测 —— 它上一版就是"抽出来测不了、
 *            于是量错了也没人发现"。
 */
function measureUploadPayload(req) {
  let getDockerIgnore
  try {
    getDockerIgnore = req('@wxcloud/cli/lib/functions/getDockerIgnore.js').getDockerIgnore
  } catch {
    // CLI 不在（CI 里可能是另一种安装布局）⇒ 不拦，只说明没量到
    console.log('· （没找到 @wxcloud/cli 的 getDockerIgnore，跳过上传包体积检查）')
    return null
  }
  const ignore = getDockerIgnore(ROOT) ?? []

  /**
   * ⚠️ 判据是**路径的每一级祖先**：readdir-glob 只按"条目路径"命中规则，
   *    所以 `.tmp-ecdict/a/b` 之所以被排掉，是因为**祖先** `.tmp-ecdict` 命中了 `.tmp-*`。
   *    （这也是 .dockerignore 里"目录必须写 dir/**"那条经验的来源。）
   */
  const ignored = (rel) => {
    const parts = rel.split('/')
    let prefix = ''
    for (const p of parts) {
      prefix = prefix ? prefix + '/' + p : p
      if (ignore.some((pat) => ignoreHit(prefix, String(pat)))) return true
    }
    return false
  }

  let bytes = 0
  let files = 0
  const perDir = new Map()
  const walk = (abs, rel) => {
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name
      if (ignored(r)) continue
      if (e.isDirectory()) walk(path.join(abs, e.name), r)
      else if (e.isFile()) {
        let st
        try {
          st = fs.statSync(path.join(abs, e.name))
        } catch {
          continue
        }
        files++
        bytes += st.size
        // ⚠️ 只统计"顶层目录"的占比，好让人一眼看出是谁把包撑起来的
        const top = r.includes('/') ? r.slice(0, r.indexOf('/')) + '/' : r
        perDir.set(top, (perDir.get(top) ?? 0) + st.size)
      }
    }
  }
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (ignored(e.name)) continue
    if (e.isDirectory()) walk(path.join(ROOT, e.name), e.name)
    else if (e.isFile()) {
      files++
      try {
        bytes += fs.statSync(path.join(ROOT, e.name)).size
      } catch {
        /* 忽略读不到的 */
      }
    }
  }
  return { bytes, files, perDir }
}

/**
 * ⚠️ 镜像模式**跳过**上传包闸门：那条闸门管的是"源构建要传的 zip"，
 *    镜像模式下我们推的是镜像、根本不传 zip —— 量它只会误导。
 */
if (!useImage) {
  const m = measureUploadPayload(createRequire(import.meta.url))
  if (m) {
    const mb = (m.bytes / 1048576).toFixed(1)
    console.log(`· 上传包内容：${m.files} 个文件 / ${mb} MB（未压缩；.dockerignore 生效后）`)
    const heavy = [...m.perDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    if (heavy.length) {
      console.log('  最大的几块：' + heavy.map(([k, v]) => `${k} ${(v / 1048576).toFixed(1)}MB`).join(' · '))
    }
    if (m.bytes > PKG_FAIL_BYTES) {
      console.error(
        `\n❌ 上传包 ${mb}MB 太大（阈值 ${PKG_FAIL_BYTES / 1048576}MB）—— 继续发大概率 create_failed。\n` +
          '   看上面"最大的几块"：多半是本机目录没被 .dockerignore 挡住。\n' +
          '   ⚠️ 注意 `.dockerignore` 里**目录要写 dir/**（带点的目录不会被自动展开，见该文件头部说明）。',
      )
      process.exit(1)
    }
    if (m.bytes > PKG_WARN_BYTES) {
      console.log(`⚠️ 上传包 ${mb}MB 偏大（健康值 6MB 级）—— 确认上面那几块是应该传的。`)
    }
  }
}

const MAX_ATTEMPTS = 3
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const before = await versionNames()
  let cliError = ''
  try {
    // ⚠️ 给 CLI 一个超时：create_failed 时它会一直挂着，不设上限 CI 会等到 job 超时
    wxcloud(argv, { stdio: 'inherit', timeout: 14 * 60_000 })
  } catch (err) {
    cliError = err.message ?? ''
  }

  /**
   * ⚠️ 量一下 CLI **真正打出来的那个 zip**（它自己会删，所以在这里抢读一次）。
   *    与上面那个预估互为对照：预估算的是"该传什么"，这个是"实际传了多大"。
   */
  try {
    const zip = fs
      .readdirSync(ROOT)
      .filter((f) => f.startsWith('.cloudrun_') && f.endsWith('.zip'))
      .map((f) => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]
    if (zip) {
      const mb = (fs.statSync(path.join(ROOT, zip.f)).size / 1048576).toFixed(1)
      console.log(`· 实际上传包 ${zip.f}：${mb} MB（压缩后）`)
      if (Number(mb) > 60) {
        console.log('⚠️ 压缩后超过 60MB —— 下次很容易撞上 create_failed，去清本机目录或补 .dockerignore。')
      }
    }
  } catch {
    /* 读不到就算了，别因为一个诊断把部署搞失败 */
  }

  const result = await waitForNewVersion(before)
  if (result.ok) {
    console.log(`\n✅ 已发布：${result.name}（${target}）`)
    process.exit(0)
  }

  const busy = /ResourceInUse|部署发布任务运行中/.test(cliError)
  if (attempt < MAX_ATTEMPTS) {
    console.log(
      `\n· 第 ${attempt} 次没成（${result.name}${busy ? ' · 有发布任务在跑' : ''}），60 秒后重试…`,
    )
    await sleep(60_000)
    continue
  }

  console.error(`\n❌ 部署失败（试了 ${MAX_ATTEMPTS} 次，最后一次：${result.name}）`)
  if (cliError) console.error(cliError)
  process.exit(1)
}
// 循环正常走完说明每次都失败（最后一次已在循环内 exit）；到这里再兜一次
process.exit(1)
