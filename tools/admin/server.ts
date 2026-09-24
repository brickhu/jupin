#!/usr/bin/env node
/**
 * ⭐ 本地 admin 服务 —— 句库管理（127.0.0.1:4983，无构建、纯 node:http）。
 *
 *   pnpm admin              起服务
 *   pnpm admin --port 4983  换端口
 *
 * ⚠️ 为什么是「本地服务」而不是把功能塞进小程序：
 *    这些动作要写仓库里的文件（正文 JSON、标准音）+ 跑 fish/LLM ——
 *    它们天生属于**内容生产**，不属于用户端。
 * ⚠️ 只监听 127.0.0.1：它是操作台，不是给人访问的站点。
 * ⚠️ 多环境（local / dev / prod）只影响**写哪个库**：
 *    内容文件永远写在本机仓库（仓库就是内容的真相），
 *    库只是「这个环境认不认这条句子」的索引。
 *    音频进对象存储是**部署那一步**的事（dev 靠 SEED_ON_START，prod 靠手动 upload）——
 *    本工具不碰桶，免得两个地方各灌一次。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { eq, desc, inArray } from 'drizzle-orm'

import { type Db, createDb, probeDatabase } from '../../apps/server/src/db'
import { mp3DurationMs } from '../../apps/server/src/services/mp3-duration'
import { readStaticFile } from '../../apps/server/src/services/content'
import type { ArticleWord } from '../../packages/shared/src/types/content'
import { MODES, ROOT, envFileOf, loadEnv, parseEnvFile, writeEnvVar } from '../env.mjs'
import { articleTags, articles, schedules } from '../../apps/server/src/db/schema'
import { syncArticleIndex } from '../../apps/server/src/services/article-index'
import { audioKeyOf } from '../../apps/server/src/services/standard-audio'
import { parseRange } from '../../apps/server/src/lib/http-range'
import { articleIdOf } from '../pipeline/src/lib/article-id'
import { MIN_PLAY_SEC, produceStandardAudio, writeWordTimestamps } from '../pipeline/src/lib/audio-assets'
import { generateArticleMeta } from '../pipeline/src/lib/article-meta'
import { themeFromHash } from '../../packages/shared/src/theme'
import { ARTICLE_ID_LENGTH } from '../../packages/shared/src/constants'
import { contentPathOf } from '../../packages/shared/src/content-path'
import { plainWordsOf } from '../../packages/shared/src/tokenize'
import { DIFFICULTY_LABEL, DIFFICULTY_ORDER, normalizeDifficulty, normalizeTags } from '../../packages/shared/src/difficulty'
import { addDays, isValidDay, today } from '../../packages/shared/src/day'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WEB_DIR = join(HERE, 'web')
const STATE_FILE = join(HERE, '.state.json')

const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1]) || 4983

/** ⚠️ LLM / fish 的凭据都在 .env.local —— 这个进程自己要用，先加载 */
loadEnv('local')

/* ================================================================
 * 环境
 * ================================================================ */

type Mode = (typeof MODES)[number]

interface Target {
  mode: Mode
  /** 库连接串；null = 连不上（note 里写为什么） */
  url: string | null
  note: string
  /**
   * ⭐ **真实试一次查询**的错误信息（null = 能用）。
   *
   * ⚠️⚠️ 为什么不能只看「连接串解析出来了」：
   *    云托管的 MySQL 是「服务器通、库不一定在」—— 实例重建后是一张白纸，
   *    `jushuo` 这个库要等一次部署去自举建库。
   *    实测 prod 就是这样：能连上服务器，但每条查询都报
   *    `Unknown database 'jushuo'`。
   *    只看连接串的话，界面上 prod 是**可点的**，点进去句库空白 + 一行原始 MySQL 错，
   *    而真实原因（这个环境还没初始化）完全看不出来。
   */
  error: string | null
  /** 上次探测的时间戳（探一次要过网，缓存 30 秒） */
  probedAt: number
}

/** 读某个环境那份 env（.env 打底 + .env.<mode> 覆盖），**不改 process.env** */
function varsOf(mode: Mode): Record<string, string> {
  return { ...parseEnvFile(resolve(ROOT, '.env')), ...parseEnvFile(envFileOf(mode)) }
}

/**
 * ⭐ dev / prod 的库在云上，而**内网地址只在容器里通** ——
 *    本机要连只能走「外网地址」，它得先去控制台开。
 *    这里用云托管自己的 API 查（与 tools/seed-cloud.mjs 同一套），不让人手抄地址。
 */
async function publicDbAddress(mode: Mode): Promise<string | null> {
  if (mode === 'local') return null
  const envId = varsOf(mode).WXCLOUD_ENV_ID
  if (!envId) return null
  try {
    const require = createRequire(resolve(ROOT, 'package.json'))
    const CLI = resolve(ROOT, 'node_modules/@wxcloud/cli/lib')
    const { DescribeWxCloudBaseRunDBClusterDetail } = require(CLI + '/api/cloudapiDirect')
    const { setApiCommonParameters } = require(CLI + '/api/common')
    setApiCommonParameters({ region: 'ap-shanghai' })
    const d = await DescribeWxCloudBaseRunDBClusterDetail({ EnvId: envId })
    const net = d?.NetInfo ?? {}
    if (d?.DbInfo?.IsOpenPubNetAccess && net.PubNetAddress) return String(net.PubNetAddress)
    return null
  } catch (err) {
    console.warn('[admin] 查数据库外网地址失败：' + (err as Error).message)
    return null
  }
}

async function resolveTarget(mode: Mode): Promise<Target> {
  const vars = varsOf(mode)
  if (mode === 'local') {
    const url = vars.DATABASE_URL ?? ''
    return { mode, url: url || null, note: url ? '' : '.env.local 里没有 DATABASE_URL', error: null, probedAt: 0 }
  }
  const pub = await publicDbAddress(mode)
  if (!pub) {
    return {
      mode,
      url: null,
      note: '数据库没开外网地址（云托管控制台 → MySQL → 网络信息 → 开启外网地址），本机连不上',
      error: null,
      probedAt: 0,
    }
  }
  const user = vars.MYSQL_USERNAME ?? 'root'
  const pass = encodeURIComponent(vars.MYSQL_PASSWORD ?? '')
  const db = vars.MYSQL_DATABASE ?? 'jushuo'
  return {
    mode,
    url: 'mysql://' + user + ':' + pass + '@' + pub + '/' + db,
    note: '',
    error: null,
    probedAt: 0,
  }
}

const targets = new Map<Mode, Target>()

/** 探测结果的有效期：探一次要过网（云库还可能冷启动），不能每个请求都探 */
const PROBE_TTL_MS = 30_000

/**
 * ⭐ 真查一次，回答「这个环境**能不能用**」，而不只是「连不连得上」。
 *
 * ⚠️ 查 `articles` 表而不是 `SELECT 1`：admin 要用的就是这张表，
 *    一次探测同时覆盖两种坏状态 ——
 *      · 库不存在（实例重建后的白纸）→ Unknown database 'jushuo'
 *      · 库在但没跑迁移 → Table 'jushuo.articles' doesn't exist
 *    两种对运营说的是同一句话：这个环境还没初始化好（跑一次部署即可）。
 * ⚠️ 绝不让它抛：探测失败本身就是**结果**，要显示给人看。
 */
async function probeOf(t: Target): Promise<string | null> {
  if (!t.url) return t.note || '没有连接串'
  /**
   * ⚠️⚠️ 这里**只能**走 probeDatabase（单连接），绝不能走 dbOf(池)：
   *    dbOf 内部要回调 targetOf 拿连接串，而 targetOf 又把「写进缓存」
   *    放在探测之后 ⇒ 立刻变成 probe → dbOf → targetOf → probe 的无限互递归。
   *    实测症状不是报错，是**堆内存涨到 4GB 后 OOM 崩掉**（每次递归还真的会去查一遍云 API）。
   */
  return probeDatabase(t.url)
}

async function targetOf(mode: Mode): Promise<Target> {
  const hit = targets.get(mode)
  if (hit && Date.now() - hit.probedAt < PROBE_TTL_MS) return hit
  const t = hit ?? (await resolveTarget(mode))
  t.error = await probeOf(t)
  t.probedAt = Date.now()
  targets.set(mode, t)
  return t
}

/**
 * 每个环境一个连接池（懒建）。
 *
 * ⚠️ 走 apps/server 的 createDb 而不是在这里 createPool：池参数（timezone/bigint）
 *    必须和线上服务逐字一致，抄一份迟早会漂。见 db/index.ts 的注释。
 */
const pools = new Map<Mode, Db>()

async function dbOf(mode: Mode): Promise<Db> {
  const hit = pools.get(mode)
  if (hit) return hit
  const t = await targetOf(mode)
  if (!t.url) throw new Error('这个环境连不上：' + t.note)
  const d = createDb(t.url)
  pools.set(mode, d)
  return d
}

/* ================================================================
 * 会话（签名 cookie，无状态；密钥落 .state.json，重启不掉线）
 * ================================================================ */

/**
 * 日期解析：YYYY-MM-DD / today / tomorrow / +N。
 * ⚠️ 与旧 CLI 同口径 —— 运营嘴里说的就是「明天」和「+3」。
 */
function resolveDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (s === 'today') return today()
  if (s === 'tomorrow') return addDays(today(), 1)
  const rel = /^\+(\d{1,3})$/.exec(s)
  if (rel) return addDays(today(), Number(rel[1]))
  return isValidDay(s) ? s : null
}

/** 把外部输入收窄成 Mode（环境名是**不可信输入**，绝不允许直接落进 S.env） */
function modeOf(v: unknown): Mode | null {
  const s = String(v ?? '')
  return (MODES as readonly string[]).includes(s) ? (s as Mode) : null
}

function loadState(): { secret: string; env: Mode } {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    // ⚠️ 落盘的值可能是老版本写下的/被人手改过，必须当作不可信输入校验一遍
    const env = (MODES as readonly string[]).includes(raw.env) ? (raw.env as Mode) : 'local'
    if (raw.secret) return { secret: raw.secret, env }
  } catch {
    /* 第一次跑：下面会建 */
  }
  const fresh: { secret: string; env: Mode } = { secret: randomBytes(32).toString('hex'), env: 'local' }
  writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2))
  return fresh
}

let S = loadState()

function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(S, null, 2))
}

const signed = (exp: number) => createHmac('sha256', S.secret).update(String(exp)).digest('hex')

function issueCookie(): string {
  const exp = Date.now() + 7 * 86400000
  return exp + '.' + signed(exp)
}

function cookieOk(raw: string | undefined): boolean {
  if (!raw) return false
  const dot = raw.indexOf('.')
  if (dot < 0) return false
  const exp = Number(raw.slice(0, dot))
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const want = signed(exp)
  const got = raw.slice(dot + 1)
  if (got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

/** 管理员口令 —— 没配就现生成一个写回 .env.local，并**打在控制台**（不猜、不默认） */
function ensureAdminCredentials(): { user: string; pass: string; generated: boolean } {
  const user = process.env.ADMIN_USER || 'admin'
  const existing = process.env.ADMIN_PASSWORD
  if (existing) return { user, pass: existing, generated: false }
  const pass = randomBytes(9).toString('base64url')
  writeEnvVar(envFileOf('local'), 'ADMIN_PASSWORD', pass)
  process.env.ADMIN_PASSWORD = pass
  return { user, pass, generated: true }
}

const ADMIN = ensureAdminCredentials()

/* ================================================================
 * 文章 id 的形状
 * ================================================================ */

/**
 * 文章 id 的正则 —— **从唯一的长度常量拼出来**。
 * ⚠️ 不要在这里写死 {16}：长度定义在 shared/constants（schema 的列宽也用它），
 *    写死就是第二个会漂的真相（上一版这里就是 4 处写死的 {64}）。
 */
const ID_HEX = '[0-9a-f]{' + ARTICLE_ID_LENGTH + '}'
const RE_ARTICLE = new RegExp('^/api/articles/(' + ID_HEX + ')$')
const RE_AUDIO = new RegExp('^/api/audio/(' + ID_HEX + ')(?:\\.mp3|/w(\\d+)\\.mp3)?$')
const RE_SCHEDULE = new RegExp('^/api/articles/(' + ID_HEX + ')/schedule$')
const RE_REDO = new RegExp('^/api/articles/(' + ID_HEX + ')/audio$')

/* ================================================================
 * HTTP 小工具
 * ================================================================ */

function send(res: ServerResponse, status: number, body: unknown): void {
  const isText = typeof body === 'string'
  const text = isText ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function ok(res: ServerResponse, data: unknown): void {
  send(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, err: unknown, status = 400): void {
  send(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是 JSON')
  }
}

function cookieOf(req: IncomingMessage, key: string): string | undefined {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1)
  }
  return undefined
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
}

/**
 * 发一个静态文件。
 *
 * ⚠️⚠️ 必须支持 `Range`，而且这不是「省流量」的优化，是**功能开关**：
 *    浏览器只有在服务端支持 range 请求时才会把媒体标成 seekable；
 *    否则 `audio.seekable` 是 [0,0]，给 `currentTime` 赋值会被**夹回 0** ——
 *    症状就是「点词定位播放整个失效：点哪个词都在播句子开头」。
 *    （实测：文件已完整 buffered（0–3.3s）但 seekable=[0,0]，赋 1.59 读回 0。）
 *
 * ⚠️ 请求了 Range 但解析不出来（多区间 / 不可满足）时，这里**退回整份 200** ——
 *    严格说该回 416，但浏览器对 200 处理得很好，而多一个状态码分支就多一处要测。
 */
async function serveFile(req: IncomingMessage, res: ServerResponse, abs: string): Promise<void> {
  const buf = await readFile(abs)
  const type = MIME[extname(abs)] ?? 'application/octet-stream'
  const range = parseRange(req.headers.range, buf.length)

  if (range) {
    res.writeHead(206, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + buf.length,
      'Content-Length': String(range.end - range.start + 1),
      'Cache-Control': 'no-store',
    })
    res.end(buf.subarray(range.start, range.end + 1))
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    // ⭐ 明确告诉浏览器「可以按字节取」—— 这是它判断「能 seek」的依据
    'Accept-Ranges': 'bytes',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

/* ================================================================
 * 句库
 * ================================================================ */

/**
 * 难度 → 中文档位。
 * ⚠️ 库里的 difficulty 是裸 int（可能是历史脏值 / null），必须先过 normalizeDifficulty ——
 *    直接拿它索引 DIFFICULTY_LABEL 会得到 undefined，页面上就是一片空白档位。
 */
function difficultyLabelOf(v: unknown): string | null {
  const d = normalizeDifficulty(v)
  return d === null ? null : DIFFICULTY_LABEL[d]
}

async function contentOf(id: string): Promise<Record<string, unknown> | null> {
  const p = contentAbsPathOf(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

/** 正文从**本机仓库**读（正文的真相在文件里），结构化字段从库读 */
async function listArticles(mode: Mode, q: string, limit: number) {
  const d = await dbOf(mode)
  const rows = await d.select().from(articles).orderBy(desc(articles.createdAt)).limit(limit)
  const ids = rows.map((r) => r.id)
  const tagRows = ids.length ? await d.select().from(articleTags).where(inArray(articleTags.articleId, ids)) : []
  const tagMap = new Map<string, string[]>()
  for (const t of tagRows) {
    const list = tagMap.get(t.articleId) ?? []
    list.push(t.tag)
    tagMap.set(t.articleId, list)
  }
  const out = []
  for (const r of rows) {
    const c = await contentOf(r.id)
    out.push({
      id: r.id,
      isActive: r.isActive,
      difficulty: r.difficulty ?? null,
      difficultyLabel: difficultyLabelOf(r.difficulty),
      /** ⭐ 发布时间（草稿为 null）—— 列表里替代原来的标签列展示 */
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      standardAudio: r.standardAudio ?? null,
      text: typeof c?.text === 'string' ? c.text : null,
      translation: typeof c?.translation === 'string' ? c.translation : null,
      tags: (tagMap.get(r.id) ?? []).sort(),
      words: Array.isArray(c?.words) ? c.words : [],
    })
  }
  const needle = q.trim().toLowerCase()
  if (!needle) return out
  return out.filter(
    (r) =>
      (r.text ?? '').toLowerCase().includes(needle) || (r.translation ?? '').toLowerCase().includes(needle),
  )
}

/**
 * ⭐ 把一条句子的字段写进正文 JSON（本机仓库）+ 库里那一行。
 * ⚠️ **只改字段，不动 text** —— text 一改就是另一条句子（id = sha256(text) 前 16 位），
 *    那是「新增」而不是「编辑」。
 */
/**
 * 校验**手工改过**的词级播放区间。
 *
 * ⚠️⚠️ 为什么必须严，而不是「信前端」：
 *    ① 客户端只在 `words.length === 切词数` 时才启用点词播放
 *       （reading.ts 的 wordTimes），条数一错就**静默**退回预切切片 ——
 *       界面看起来正常，只是点词不再精确；
 *    ② `content-files.test.ts` 还会在 CI 里检查「每个词的区间 ≥300ms」
 *       「最后一个词的结束点不越过音频时长」—— 存进去一个坏值，
 *       下一次 pnpm test 就红，而那时没人记得是谁改的。
 *    所以挡在写文件之前，并且报错要指明是**第几个词**。
 */
async function validateWords(
  id: string,
  text: string,
  raw: unknown,
): Promise<{ words?: ArticleWord[]; error?: string }> {
  if (!Array.isArray(raw)) return { error: 'words 必须是数组' }
  // ⚠️ 切词走唯一实现（plainWordsOf）：客户端只在条数相等时才启用点词播放，
  //    这里如果用了别的规则，校验就会拦下正常内容（或放坏内容过去）
  const tokens = plainWordsOf(text)
  if (raw.length !== tokens.length) {
    return {
      error:
        'words 有 ' + raw.length + ' 条，正文是 ' + tokens.length + ' 个词 —— 对不上。' +
        '条数不一致时客户端会**关掉**点词播放（静默退回预切切片），所以不允许保存。',
    }
  }

  // 音频时长：用来挡住「区间越过音频末尾」（点词会播到空白）
  let durationMs: number | null = null
  const mp3 = await readStaticFile('content/audio/' + id + '.mp3')
  if (mp3) durationMs = mp3DurationMs(Buffer.from(mp3))

  const out: ArticleWord[] = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] as Partial<ArticleWord> | undefined
    const at = '第 ' + (i + 1) + ' 个词'
    if (!w || typeof w !== 'object') return { error: at + '不是对象' }
    if (String(w.word ?? '') !== tokens[i]) {
      return { error: at + '是「' + String(w.word ?? '') + '」，正文里是「' + tokens[i] + '」—— 顺序或内容对不上' }
    }
    const startMs = Math.round(Number(w.startMs))
    const endMs = Math.round(Number(w.endMs))
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: at + '的时间不是数字' }
    if (startMs < 0) return { error: at + '的起点为负' }
    if (endMs <= startMs) return { error: at + '的结束点不在起点之后' }
    const minMs = Math.round(MIN_PLAY_SEC * 1000)
    if (endMs - startMs < minMs) {
      return {
        error:
          at + '（' + tokens[i] + '）的区间只有 ' + (endMs - startMs) + 'ms，' +
          '短于最小可听长度 ' + minMs + 'ms —— 剥出来是一声空响（弱读虚词最容易撞上）',
      }
    }
    if (durationMs !== null && endMs > durationMs + 120) {
      return {
        error:
          at + '（' + tokens[i] + '）结束于 ' + endMs + 'ms，超过音频时长 ' + Math.round(durationMs) +
          'ms + 余量 —— 点它会播到空白',
      }
    }
    out.push({
      ...(w as ArticleWord),
      pos: typeof w.pos === 'number' ? w.pos : i,
      word: tokens[i]!,
      startMs,
      endMs,
    })
  }
  return { words: out }
}

/**
 * 正文 JSON 的**绝对**路径（本机仓库）—— 内容寻址：文件名就是 id。
 * ⚠️ 名字里带 Abs：服务端那边有个同义的 `contentPathOf(id)`，它返回的是
 *    **相对静态根的 URL 路径**（`/content/articles/<id>.json`）。两者不能混。
 */
function contentAbsPathOf(id: string): string {
  // ⚠️ 相对路径用 shared 的唯一实现；这里只把它钉到本机仓库根
  return resolve(ROOT, contentPathOf(id).replace(/^\/+/, ''))
}

/**
 * 只改正文 JSON 里的指定字段（其余原样保留）。
 *
 * ⚠️ 合并而不是覆盖：正文里还有 pipeline 写进去的 words / 未来可能加的字段，
 *    这个台子不该假装自己知道正文的完整形状。
 */
async function writeContentFile(id: string, fields: Record<string, unknown>): Promise<void> {
  const p = contentAbsPathOf(id)
  const prev = existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : {}
  const next: Record<string, unknown> = { ...prev, ...fields }
  if (!Array.isArray(next.words)) next.words = []
  await writeFile(p, JSON.stringify(next, null, 2) + '\n')
}

async function upsertArticle(
  mode: Mode,
  input: {
    id: string
    text: string
    translation: string
    difficulty: number
    tags: string[]
    /**
     * true = 发布，false = 下架，**undefined = 保持现状**。
     * ⚠️ 三态而不是布尔：详情页的「保存」只改译文/标签/难度，
     *    一条已发布的句子必须原样留在线上 —— 否则每次修个错别字都会把它悄悄下架。
     */
    publish: boolean | undefined
    /** 手工修正过的词级播放区间（不传就不动正文里的 words） */
    words?: ArticleWord[]
  },
): Promise<boolean> {
  // ⚠️ 不传 words：那是 pipeline 的产物，这里只负责译文/难度/标签这几个字段
  await writeContentFile(input.id, {
    id: input.id,
    text: input.text,
    translation: input.translation,
    difficulty: input.difficulty,
    tags: input.tags,
    // ⚠️ 只在真的传了 words 时才写：不传就是「别动流水线产出的时间戳」
    ...(input.words ? { words: input.words } : {}),
  })

  const d = await dbOf(mode)

  // ⚠️ 发布状态以**库里那一行**为准：没有行（新句子）就是未发布
  const [cur] = await d
    .select({ isActive: articles.isActive })
    .from(articles)
    .where(eq(articles.id, input.id))
    .limit(1)
  const publish = input.publish === undefined ? Boolean(cur?.isActive) : input.publish
  const justPublished = publish && !cur?.isActive

  const row = {
    id: input.id,
    // ⚠️ 不再写 content_json：那一列已删，正文路径由 id 推导（services/content.ts 的 contentPathOf）
    // ⚠️ 发布状态只有 is_active 一列（content_status 已删，迁移 0033）——
    //    以前这里两列一起写，就得永远保证它们同步，而同步本身没有任何东西在检查。
    isActive: publish,
    theme: themeFromHash(input.id),
    standardAudio: audioKeyOf(input.id),
    difficulty: input.difficulty,
    /**
     * ⭐ 发布时间只在**草稿 → 已发布**那一刻写，而且**只由这一处写**。
     *
     * ⚠️ 单纯改译文/标签不该刷新它（那会把「什么时候上的线」变成「最后一次编辑」）；
     *    下架也不清空它（它记的是最近一次上线的时刻，草稿状态另有列表达）。
     * ⚠️⚠️ 刻意**不接受客户端指定**（用户 2026-09 的决定）：能手改的话它就不再表示
     *    「什么时候上的线」了。PUT 处理里对 publishedAt 是**明确拒收**，不是静默忽略 ——
     *    免得以后有人加了字段却发现「怎么改了没反应」。
     */
    ...(justPublished ? { publishedAt: new Date() } : {}),
  }
  await d.insert(articles).values(row).onDuplicateKeyUpdate({ set: row })
  await syncArticleIndex(input.id, d)
  return publish
}

/**
 * ⭐ 生成任务：LLM 出译文/难度/标签 → fish 出标准音 → 词级区间落盘 → 建一条**草稿行**。
 *
 * ⚠️ 为什么生成时就建行（而不是只写文件）：loadSeedArticles 会扫 content/articles/*.json
 *    并**按默认值**插入（isActive 默认 true）—— 只写文件不建行，下一次部署它就直接上线了。
 *    建一条 draft 行（isActive=false）就把这条堵死，和 CLI 的 add-sentence 也是同一套。
 * ⚠️ 为什么是异步任务：fish 一句要几秒到十几秒，同步 HTTP 会超时（也会让人以为卡死）。
 */

interface Job {
  status: 'running' | 'done' | 'error'
  step: string
  log: string[]
  result?: Record<string, unknown>
  error?: string
}

const jobs = new Map<string, Job>()

async function runGenerate(job: Job, mode: Mode, text: string): Promise<void> {
  const id = articleIdOf(text)
  job.log.push('id = ' + id.slice(0, 16) + '…')

  job.step = 'LLM：译文 / 难度 / 标签'
  const meta = await generateArticleMeta(text)
  job.log.push(
    '难度 ' + (meta.difficulty === null ? '—' : DIFFICULTY_LABEL[meta.difficulty]) +
      '｜标签 ' + (meta.tags.join(' / ') || '—'),
    '理由：' + (meta.reason || '—'),
  )
  if (meta.difficulty === null) throw new Error('模型没给出可用的难度档位（0–3），这条先别发')

  /**
   * ⭐ 正文必须**在跑音频之前**落盘。
   *
   * ⚠️ 第一版把写文件放在最后，结果是 fish 的音频合成完了、
   *    写词级时间戳那一步直接 ENOENT —— 因为 writeWordTimestamps 是
   *    「读 content/articles/<id>.json → 塞进 words → 写回」，
   *    文件不存在就没有可写回的地方。
   * ⚠️ 失败时必须把新建的这个文件删掉：下次部署 loadSeedArticles 会扫到它，
   *    并按 DB 默认值（isActive 默认 true）插进库里 ——
   *    那就等于**悄悄上线一句没有音、没有词的句子**。
   *    已有文件（重新生成同一句）不能删，那不是这次新建的。
   */
  const jsonPath = contentAbsPathOf(id)
  const existed = existsSync(jsonPath)
  /** 音频这一步的产物；失败时保持 null（后面的 result 要用） */
  let audio: { wordCount: number; durationMs: number } | null = null
  try {
    await writeContentFile(id, {
      id,
      text,
      translation: meta.translation,
      difficulty: meta.difficulty,
      tags: meta.tags,
      words: [],
    })

    job.step = 'fish：标准音 + 词级时间戳'
    const prod = await produceStandardAudio(id, text, { force: true })
    const n = await writeWordTimestamps(id, prod.alignment)
    job.log.push(
      '整句 ' + prod.alignment.audioDuration.toFixed(2) + 's，' + prod.wordCount + ' 个词，时间戳 ' + n + ' 条',
    )
    audio = { wordCount: prod.wordCount, durationMs: Math.round(prod.alignment.audioDuration * 1000) }
  } catch (err) {
    if (!existed) await unlink(jsonPath).catch(() => {})
    throw err
  }

  job.step = '写库（草稿）'
  await upsertArticle(mode, {
    id,
    text,
    translation: meta.translation,
    difficulty: meta.difficulty,
    tags: meta.tags,
    publish: false,
  })

  job.step = '完成'
  job.status = 'done'
  job.result = {
    id,
    text,
    translation: meta.translation,
    difficulty: meta.difficulty,
    difficultyLabel: DIFFICULTY_LABEL[meta.difficulty],
    tags: meta.tags,
    reason: meta.reason,
    wordCount: audio?.wordCount ?? 0,
    durationMs: audio?.durationMs ?? 0,
    words: (await contentOf(id))?.words ?? [],
  }
}

/**
 * 只为一条**已有**的句子重做标准音与词级时间戳。
 *
 * ⚠️ 为什么值得一个独立任务：这是音频出问题（缺文件 / 某个词的区间不对 /
 *    正文的 words 是空的）时**唯一**的修复手段 ——
 *    旧 CLI 的 `audio --id` 就是干这个的，删掉它不能让这个动作消失。
 * ⚠️ 正文一个字都不动，所以 id 不变：这是「重做音」，不是「新增句子」。
 */
async function runRegenerateAudio(job: Job, id: string, text: string, force: boolean): Promise<void> {
  job.step = 'fish：标准音 + 词级时间戳'
  const prod = await produceStandardAudio(id, text, { force })
  const n = await writeWordTimestamps(id, prod.alignment)
  job.log.push(
    '整句 ' + prod.alignment.audioDuration.toFixed(2) + 's，' + prod.wordCount + ' 个词，' +
      '时间戳 ' + n + ' 条' + (prod.skipped ? '（复用已有音频）' : '（重新合成）'),
  )
  job.step = '完成'
  job.status = 'done'
  job.result = {
    id,
    wordCount: prod.wordCount,
    durationMs: Math.round(prod.alignment.audioDuration * 1000),
    words: (await contentOf(id))?.words ?? [],
  }
}

/** 把一个后台任务登记进内存表并立刻开跑（HTTP 立刻返回 jobId） */
function startJob(run: (job: Job) => Promise<void>): string {
  const jobId = randomBytes(8).toString('hex')
  const job: Job = { status: 'running', step: '排队', log: [] }
  jobs.set(jobId, job)
  void run(job).catch((err) => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
  })
  return jobId
}

/* ================================================================
 * 路由
 * ================================================================ */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  // ---- 静态 ----
  if (!path.startsWith('/api/')) {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    const abs = resolve(WEB_DIR, rel)
    /**
     * ⚠️ 必须比到「分隔符边界」，不能只 startsWith(WEB_DIR)：
     *    `resolve(WEB_DIR, '../webfoo/x')` 得到的是 **webfoo** 目录下的文件，
     *    它的字符串前缀恰好是 .../web —— 只做前缀比较就把它放出去了。
     */
    if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + sep)) return send(res, 403, 'forbidden')
    if (existsSync(abs)) return serveFile(req, res, abs)

    /**
     * ⭐ SPA 回退：`/articles`、`/article/<id>` 是**客户端路由**，盘上没有对应文件，
     *    所以没有扩展名的路径一律交给 index.html，由前端自己解析。
     * ⚠️ 只对「不像静态资源」的路径回退：否则一个写错的 `/app.js` 会返回 200 的 HTML，
     *    浏览器报的错会离真正的原因（文件名写错了）十万八千里。
     */
    if (!extname(rel)) return serveFile(req, res, join(WEB_DIR, 'index.html'))
    return send(res, 404, 'not found')
  }

  // ---- 登录 ----
  if (path === '/api/login' && req.method === 'POST') {
    const b = await body(req)
    if (String(b.user ?? '') !== ADMIN.user || String(b.password ?? '') !== ADMIN.pass) {
      return fail(res, '账号或密码不对', 401)
    }
    /**
     * ⭐ 环境**在登录时选定**，而不是登录后再切。
     *
     * ⚠️ 为什么不给「登录后随便切」：这个台子的每个动作都会落到某个环境的库上
     *    （改译文、发布、排期、重生成音频），环境是「这次会话的前提」，
     *    不是一个随时可拨的显示开关。放登录页还有个实际好处 ——
     *    选一个坏环境会**当场**失败并说明原因，而不是登录成功之后
     *    句库空白 + 一行原始报错。
     * ⚠️ 选定的环境写进 .state.json：下次登录默认还是它（登录页会预选）。
     */
    const wanted = modeOf(b.env) ?? S.env
    const t = await targetOf(wanted)
    const problem = t.url ? t.error : t.note || '连不上'
    if (problem) return fail(res, wanted + ' 这个环境用不了：' + problem)

    if (wanted !== S.env) {
      S = { ...S, env: wanted }
      saveState()
    }

    res.setHeader('Set-Cookie', 'jushuo_admin=' + issueCookie() + '; Path=/; HttpOnly; SameSite=Lax')
    return ok(res, { user: ADMIN.user, env: S.env })
  }

  const authed = cookieOk(cookieOf(req, 'jushuo_admin'))
  if (path === '/api/session') return ok(res, { authed, user: authed ? ADMIN.user : null, env: S.env })

  /**
   * ⭐ 环境列表**不需要登录**：环境是在登录页选的（见 /api/login），
   *    登录页得先知道有哪些环境、哪些能用。
   * ⚠️ 泄漏面可以接受：只有环境名和「能不能用」，没有任何凭据；
   *    而这个进程只监听 127.0.0.1，本来就不是对外服务。
   */
  if (path === '/api/envs') {
    const labels: Record<string, string> = { local: '本机 Docker', dev: '云托管 dev', prod: '云托管 prod' }
    const list = []
    for (const m of MODES) {
      const t = await targetOf(m)
      list.push({
        mode: m,
        label: labels[m],
        /** ⚠️ 「能连上」≠「能用」：必须真查过一次才算可用 */
        reachable: Boolean(t.url) && !t.error,
        note: t.error ?? t.note,
      })
    }
    return ok(res, { current: S.env, list })
  }

  if (!authed) return fail(res, '未登录', 401)

  if (path === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'jushuo_admin=; Path=/; Max-Age=0')
    return ok(res, {})
  }

  // ---- 环境 ----
  // ---- 音频（预览；与小程序读的是同一份文件）----
  // ⚠️ 两种形状：/<id>.mp3（整句）与 /<id>/w3.mp3（逐词切片）—— 前端 audio 标签用的是前者
  const audio = RE_AUDIO.exec(path)
  if (audio) {
    const audioId = audio[1]!
    const abs = audio[2] === undefined
      ? resolve(ROOT, 'content/audio', audioId + '.mp3')
      : resolve(ROOT, 'content/audio', audioId, 'w' + audio[2] + '.mp3')
    if (!existsSync(abs)) return send(res, 404, 'not found')
    return serveFile(req, res, abs)
  }

  // ---- 句库列表 ----
  if (path === '/api/articles' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500)
    const list = await listArticles(S.env, q, limit)
    return ok(res, { env: S.env, list, difficultyLabels: DIFFICULTY_LABEL, difficultyOrder: DIFFICULTY_ORDER })
  }

  // ---- 生成（异步任务）----
  if (path === '/api/generate' && req.method === 'POST') {
    const b = await body(req)
    const text = String(b.text ?? '').trim()
    if (!text) return fail(res, '缺少 text')
    const mode = S.env
    const jobId = startJob((job) => runGenerate(job, mode, text))
    return ok(res, { jobId })
  }

  const jobPath = /^\/api\/jobs\/([0-9a-f]+)$/.exec(path)
  if (jobPath) {
    const j = jobs.get(jobPath[1]!)
    if (!j) return fail(res, '没有这个任务', 404)
    return ok(res, j)
  }

  // ---- 单条 ----
  const one = RE_ARTICLE.exec(path)
  if (one && req.method === 'GET') {
    const id = one[1]!
    const d = await dbOf(S.env)
    const [row] = await d.select().from(articles).where(eq(articles.id, id)).limit(1)
    if (!row) return fail(res, '句库没有这一条', 404)
    const c = await contentOf(id)
    const tags = await d.select().from(articleTags).where(eq(articleTags.articleId, id))
    const sched = await d
      .select({ date: schedules.date })
      .from(schedules)
      .where(eq(schedules.articleId, id))
    return ok(res, {
      id: row.id,
      isActive: row.isActive,
      difficulty: row.difficulty ?? null,
      /** ⭐ 详情页也要显示发布时间（列表里有，详情里没有会很奇怪） */
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      /**
       * ⭐ 朗读卡的配色。
       * ⚠️ 在这里就把 null 解析掉，前端不重算：配色算法只允许有一份实现
       *    （shared/theme.ts），浏览器端拿不到 @jushuo/shared（那是 TS）。
       */
      theme: row.theme ?? themeFromHash(row.id),
      standardAudio: row.standardAudio ?? null,
      text: typeof c?.text === 'string' ? c.text : null,
      translation: typeof c?.translation === 'string' ? c.translation : '',
      /**
       * ⚠️ 标签的**真相在正文 JSON**，而且**顺序有意义**（第一个最重要，见 db/schema.ts
       *    里 article_tags 的注释）。article_tags 只是集合索引，**丢了顺序** ——
       *    所以详情优先用正文里的那份，索引只作为兜底。
       *    （踩过：详情读索引 → 界面里是排序后的顺序 → 一保存就把 JSON 的标签顺序改了。）
       */
      tags: Array.isArray(c?.tags) && c.tags.length ? c.tags : tags.map((t) => t.tag).sort(),
      words: Array.isArray(c?.words) ? c.words : [],
      contentOnDisk: Boolean(c),
      scheduledDates: sched.map((s) => s.date).sort(),
    })
  }

  // ---- 保存 / 发布 ----
  if (one && (req.method === 'PUT' || req.method === 'POST')) {
    const id = one[1]!
    const b = await body(req)
    const c = await contentOf(id)
    if (!c) {
      return fail(res, '这条句子的正文不在本机仓库里（content/articles/' + id + '.json 不存在），改不了')
    }
    const translation = String(b.translation ?? c.translation ?? '').trim()
    const difficulty = normalizeDifficulty(b.difficulty ?? c.difficulty)
    if (difficulty === null) return fail(res, 'difficulty 必须是 0–3 之一')
    const tags = normalizeTags(b.tags ?? c.tags)

    /**
     * ⭐ 词级播放区间：**手工修正**用（引擎对弱读虚词给的边界会落在停顿上，
     *    自动化修不了每一个，得留一条手改的路）。
     * ⚠️ 只在请求带了 words 时才校验 —— 普通保存不该被迫回传整份区间。
     */
    let words: ArticleWord[] | undefined
    if (b.words !== undefined) {
      const check = await validateWords(id, String(c.text ?? ''), b.words)
      if (check.error) return fail(res, check.error)
      words = check.words
    }

    /**
     * ⚠️ 发布时间**只由服务端产生**（草稿 → 发布那一刻），客户端不能指定。
     *    这里明确**拒收**而不是静默忽略：不说的话，调用方会以为改成功了。
     */
    if (b.publishedAt !== undefined) {
      return fail(res, '发布时间不能手改：它表示「什么时候上的线」，只由「草稿 → 发布」那一刻产生')
    }

    // ⚠️ 不带 publish 字段 = **保持现状**（见 upsertArticle 的三态说明）
    const publish = await upsertArticle(S.env, {
      id,
      text: String(c.text ?? ''),
      translation,
      difficulty,
      tags,
      publish: b.publish === undefined ? undefined : b.publish === true,
      words: words,
    })
    return ok(res, {
      id,
      translation,
      difficulty,
      tags,
      /** ⭐ 保存后的发布状态 —— 唯一真相是 is_active（content_status 已删） */
      published: publish,
      /** 保存后返回区间条数，前端据此确认「真的写进去了」 */
      wordCount: words ? words.length : undefined,
    })
  }

  /**
   * ---- 排期：把某一句**钉到某天** ----
   *
   * ⚠️ 为什么这个动作必须留在这里：旧 CLI（tools/jushuo-admin.ts）被删掉后，
   *    它是全仓库**唯一**能明确指定「某天读哪句」的入口 ——
   *    scheduleAhead 只会按天号自动轮转（routes 里顺带跑），
   *    没有它，运营就没法换某一天的题。
   *
   * ⚠️ 两条沿用旧 CLI 的护栏，都不是洁癖：
   *    ① 草稿不能排期 —— 排上去等于那天用户读到一句没上线的句子（而排期表是硬引用）；
   *    ② 同一天已排别的句子时，必须显式 force 覆盖 ——
   *       悄悄改掉别人排好的档期是**用户可见**的事故（那天所有人读到的句子变了）。
   */
  const sched = RE_SCHEDULE.exec(path)
  if (sched && req.method === 'POST') {
    const id = sched[1]!
    const b = await body(req)
    const date = resolveDate(String(b.date ?? ''))
    if (!date) return fail(res, '日期要写成 YYYY-MM-DD（或 today / tomorrow / +N）')

    const d = await dbOf(S.env)
    const [row] = await d
      .select({ isActive: articles.isActive })
      .from(articles)
      .where(eq(articles.id, id))
      .limit(1)
    if (!row) return fail(res, '句库没有这一条', 404)
    /**
     * ⚠️ 判据是 **isActive** —— 发布状态现在**只有这一列**（content_status 已删，
     *    迁移 0033）。它以前是 is_active 的同义副本，两列各有互相矛盾的 DB 默认值，
     *    灌库路径插出来的行据此会判成「草稿」，拒绝一条明明在线的句子。
     */
    if (!row.isActive) {
      return fail(res, '这条还是草稿（未发布），先发布再排期')
    }

    const [existing] = await d.select().from(schedules).where(eq(schedules.date, date)).limit(1)
    if (existing && existing.articleId !== id && b.force !== true) {
      return fail(
        res,
        date + ' 已经排了 ' + existing.articleId.slice(0, 12) + '…（' + existing.source + '）。要换请点「覆盖」',
        409,
      )
    }

    await d
      .insert(schedules)
      .values({ date, articleId: id, source: 'scheduled' })
      .onDuplicateKeyUpdate({ set: { articleId: id, source: 'scheduled' } })

    return ok(res, {
      date,
      articleId: id,
      replaced: existing && existing.articleId !== id ? existing.articleId : null,
    })
  }

  /** ---- 重做某条的标准音（正文不动）---- */
  const redo = RE_REDO.exec(path)
  if (redo && req.method === 'POST') {
    const id = redo[1]!
    const b = await body(req)
    const c = await contentOf(id)
    if (!c || typeof c.text !== 'string' || !c.text) {
      return fail(res, '这条句子的正文不在本机仓库里（content/articles/' + id + '.json），补不了音')
    }
    const text = c.text
    const jobId = startJob((job) => runRegenerateAudio(job, id, text, b.force !== false))
    return ok(res, { jobId })
  }

  return fail(res, '没有这个接口：' + path, 404)
}

/* ================================================================
 * 启动
 * ================================================================ */

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => fail(res, err, 500))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('⭐ 句拼 admin   http://127.0.0.1:' + PORT)
  console.log('')
  console.log('   账号：' + ADMIN.user)
  if (ADMIN.generated) {
    console.log('   口令（刚生成，已写进 .env.local 的 ADMIN_PASSWORD）：' + ADMIN.pass)
  } else {
    console.log('   口令：.env.local 里的 ADMIN_PASSWORD')
  }
  /**
   * ⚠️ 这里打印的是**记住的**环境，不是「最终会用哪个」——
   *    登录时 /api/envs 会真探一次，用不了就自动退回本机（见那个接口的注释）。
   *    所以写清楚，别让人以为服务端已经确认过它能用了。
   */
  console.log('   环境：在登录页选（默认记住 ' + S.env + '；不可用的环境会被标出并拒绝登录）')
  console.log('')
})
