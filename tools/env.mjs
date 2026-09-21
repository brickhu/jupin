/**
 * ⭐ 环境变量只有一个来源：**根目录的四份 .env**。
 *
 *   .env         公用   —— 账号级凭据（小程序 AppID/Secret、CLI 密钥）、小程序构建注入值、本机端口
 *   .env.local   本地   —— DevTools（模拟器）+ 本机 docker + 内容流水线
 *   .env.dev     云托管 dev
 *   .env.prod    云托管 prod
 *
 * ⚠️⚠️ 同名键**只在对应的那份文件里出现一次**。分层的意义就在这：
 *    比如 ENGINE / STORAGE 这类「本机想 mock、云上要真引擎」的开关，
 *    以前散在两个文件里（根 .env + apps/server/.env），结果
 *    「本机的 mock 把云端的自动判据整个盖住了」——本项目真踩过。
 *
 * 优先级（三层，后者覆盖前者；**真实环境变量永远最高**）：
 *
 *   进程环境变量  >  .env.<mode>  >  .env
 *
 * ⚠️ 为什么不用 Node 自带的 process.loadEnvFile() 叠两层：
 *    它**不覆盖已有键**，所以先加载 .env 再加载 .env.dev 时，
 *    .env.dev 里的同名键会被 .env 顶住 —— 分层静默失效
 *    （表现是「改了 .env.dev 却不生效」）。所以这里自己解析、自己按顺序写。
 *
 * ⚠️ 真实环境变量优先这一条不是锦上添花：docker-compose 会给容器注入
 *    DATABASE_URL=mysql://…@db:3306/jushuo，而 .env.local 里那份是给**宿主机**用的
 *    （127.0.0.1:5544）。顺序反了，容器就会去连宿主机的地址然后连不上。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（本文件在 tools/ 下） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 允许的三种运行模式 —— 与 .env.<mode> 的文件名一一对应 */
export const MODES = ['local', 'dev', 'prod']

/**
 * 解析一份 .env。容忍注释、空行、值里带 = 的情况。
 * ⚠️ 刻意不支持引号包裹与多行值：这个项目的 .env 里没有那种写法，
 *    支持它们只会让"值到底是什么"变得需要推理。
 */
export function parseEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

/**
 * 按 mode 分层加载，并把结果写进 process.env。
 *
 * @returns 本次**从文件里读到的**键值（不含进程里原有的）
 * ⚠️ 调用方之后直接读 process.env 即可 —— 优先级已经在写入时处理好了。
 */
export function loadEnv(mode = 'local') {
  if (!MODES.includes(mode)) {
    throw new Error(`未知的运行模式 "${mode}"，只能是：${MODES.join(' / ')}`)
  }

  // 先记下"进程里原本就有"的键：它们优先级最高，任何文件都不能覆盖
  const fromProcess = new Set(Object.keys(process.env))
  const loaded = {}

  for (const file of ['.env', `.env.${mode}`]) {
    const parsed = parseEnvFile(resolve(ROOT, file))
    for (const [k, v] of Object.entries(parsed)) {
      if (fromProcess.has(k)) continue
      process.env[k] = v
      loaded[k] = v
    }
  }
  return loaded
}

/** 某个 mode 对应的文件绝对路径 */
export function envFileOf(mode) {
  return resolve(ROOT, `.env.${mode}`)
}

/**
 * 幂等地把某个键写进某份 .env（已存在就替换那一行）。
 * 用途只有一个：首次部署时生成 TOKEN_SECRET 并固化下来
 * —— 每次部署都换密钥会把已有 token 全部作废。
 */
export function writeEnvVar(file, key, value) {
  const line = `${key}=${value}`
  if (!existsSync(file)) {
    appendFileSync(file, line + '\n')
    return
  }
  const raw = readFileSync(file, 'utf8')
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm')
  const next = re.test(raw) ? raw.replace(re, line) : raw.replace(/\n?$/, '\n') + line + '\n'
  if (next !== raw) writeFileSync(file, next)
}
