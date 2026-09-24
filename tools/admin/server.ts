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
import type { ArticleWordItem, ArticleWordStress, DifficultyScores } from '../../packages/shared/src/types/content'
import { MODES, ROOT, envFileOf, loadEnv, parseEnvFile, writeEnvVar } from '../env.mjs'
import { articleTags, articles, schedules } from '../../apps/server/src/db/schema'
import { syncArticleIndex } from '../../apps/server/src/services/article-index'
import { audioKeyOf } from '../../apps/server/src/services/standard-audio'
import { parseRange } from '../../apps/server/src/lib/http-range'
import { articleIdOf } from '../pipeline/src/lib/article-id'
import { produceStandardAudio } from '../pipeline/src/lib/audio-assets'
import { gradeArticles } from '../pipeline/src/lib/article-meta'
import type { ArticleCandidate } from '../pipeline/src/lib/article-meta'
import { themeFromHash } from '../../packages/shared/src/theme'
import { ARTICLE_ID_LENGTH } from '../../packages/shared/src/constants'
import { contentPathOf } from '../../packages/shared/src/content-path'
import { plainWordsOf } from '../../packages/shared/src/tokenize'
import {
  DIFFICULTY_BANDS,
  DIFFICULTY_WEIGHTS,
  LEVEL_LABEL,
  LEVEL_ORDER,
  difficultyFromScores,
  normalizeScores,
  weightedScoreOf,
} from '../../packages/shared/src/level'
import { normalizeTags } from '../../packages/shared/src/tags'
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
const RE_AUDIO = new RegExp('^/api/audio/(' + ID_HEX + ')\\.mp3$')
const RE_SCHEDULE = new RegExp('^/api/articles/(' + ID_HEX + ')/schedule$')

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
      // ⭐ 难度对外只有一个档位（库列只是派生索引，真相在正文 JSON）
      difficulty: r.difficulty ?? null,
      /**
       * ⭐ 三个判据分 [词汇, 发音, 长度] + 加权总分 —— **只给运营看**。
       *    ⚠️ 它们只在正文 JSON 里（库里没有列）：读正文顺手带出来，
       *       列表上「高级 3.1」比只有一个「高级」更能看出这一档是怎么来的。
       */
      scores: normalizeScores(c?.scores),
      score: weightedScoreOf(c?.scores),
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
 * ⚠️⚠️ 这里**曾经有 validateWords**（校验手工改过的逐词播放区间：条数、≥300ms、
 *    不越过音频时长）—— 随「点词播放改走微信 TTS」一起删掉了（2026-09）：
 *    正文里不再有 startMs/endMs，也就没有"坏区间"可校验。
 *    现在词表是**只读的派生数据**（由流水线按正文算出），这个台子只展示它。
 */
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
 * ⭐ 校验**人工改过**的词表（详情页那个对话框）。
 *
 * ⚠️⚠️ 为什么必须严：词表是朗读页逐词渲染与点按的唯一依据 —— 条数错一位、
 *    或 `text` 与正文切出来的词不一致，就变成「点这个词、看那个词的信息」，
 *    而**没有任何报错**（界面看起来完全正常）。
 *    `content-files.test.ts` 在 CI 上查同一组不变量，存进去坏值下一次 pnpm test 就红。
 */
function validateWordTable(
  text: string,
  raw: unknown,
  rawLinks: unknown,
): { words?: ArticleWordItem[]; links?: string[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'words 必须是数组' }
  const tokens = plainWordsOf(text)
  if (raw.length !== tokens.length) {
    return { error: 'words 有 ' + raw.length + ' 条，正文是 ' + tokens.length + ' 个词 —— 对不上' }
  }
  const out: ArticleWordItem[] = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] as Partial<ArticleWordItem> | undefined
    const at = '第 ' + (i + 1) + ' 个词'
    if (!w || typeof w !== 'object') return { error: at + '不是对象' }
    if (String(w.text ?? '') !== tokens[i]) {
      return {
        error: at + '是「' + String(w.text ?? '') + '」，正文里是「' + tokens[i] + '」—— 顺序或内容对不上',
      }
    }
    const syllables = Array.isArray(w.syllables) ? w.syllables.map((s) => String(s)).filter(Boolean) : null
    if (!syllables || syllables.length === 0) return { error: at + '（' + tokens[i] + '）缺少 syllables' }
    // ⭐ 核心不变量：分拍拼回来必须一字不差（含标点）
    if (syllables.join('') !== tokens[i]) {
      return { error: at + '（' + tokens[i] + '）的音节拼回来是「' + syllables.join('') + '」—— 对不上' }
    }
    const stress = Number(w.stress)
    if (stress !== 1 && stress !== 0 && stress !== -1) {
      return { error: at + ' 的句重音必须是 -1（弱读）/ 0（普通）/ 1（重读）' }
    }
    out.push({
      text: tokens[i]!,
      stress: stress as ArticleWordStress,
      syllables,
      ipa: String(w.ipa ?? '').trim(),
      meaning: String(w.meaning ?? '').trim(),
      tip: String(w.tip ?? '').trim(),
    })
  }
  // ⚠️ links 与词界一一对应；调用方不传时会把正文里那份传进来（词数没变，边界还是那些）
  const links: string[] = []
  if (Array.isArray(rawLinks)) {
    if (rawLinks.length !== out.length - 1) {
      return { error: 'links 有 ' + rawLinks.length + ' 条，应当是 ' + (out.length - 1) + ' 条（词界数）' }
    }
    for (const l of rawLinks) links.push(String(l))
  }
  return { words: out, links }
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
  if (!Array.isArray(next.links)) next.links = []
  await writeFile(p, JSON.stringify(next, null, 2) + '\n')
}

async function upsertArticle(
  mode: Mode,
  input: {
    id: string
    text: string
    translation: string
    /**
     * ⭐ 三个判据分 [词汇, 发音, 长度]，各 1–5 —— **档位由它算出来**（见 shared/level.ts）。
     * ⚠️ 刻意**不接受**调用方直接给 difficulty：那样正文里 difficulty 与 scores
     *    就可能互相矛盾，而没有任何东西会发现（content-files.test.ts 会查）。
     */
    scores: DifficultyScores
    /** 给用户看的一句话（格式见 article-meta.ts 的 SYSTEM）；可手改 */
    reason: string
    tags: string[]
    /**
     * true = 发布，false = 下架，**undefined = 保持现状**。
     * ⚠️ 三态而不是布尔：详情页的「保存」只改译文/标签/难度，
     *    一条已发布的句子必须原样留在线上 —— 否则每次修个错别字都会把它悄悄下架。
     */
    publish: boolean | undefined
    /** 词表（由流水线产出；这个台子目前只展示、不改） */
    words?: ArticleWordItem[]
    /** 词间连读标注（长度 = words.length - 1） */
    links?: string[]
  },
): Promise<boolean> {
  // ⭐ 档位**由判据分算出来**，绝不写传进来的值 —— 正文里两者永远自洽
  const difficulty = difficultyFromScores(input.scores)
  if (difficulty === null) throw new Error('三个判据分必须是 1–5 的三个整数')
  // ⚠️ 不传 words：那是 pipeline 的产物，这里只负责译文/难度/判据分/标签这几个字段
  await writeContentFile(input.id, {
    id: input.id,
    text: input.text,
    translation: input.translation,
    difficulty,
    scores: input.scores,
    tags: input.tags,
    // ⚠️ 只在真的传了 words 时才写：不传就是「别动流水线产出的词表」
    ...(input.words ? { words: input.words, links: input.links ?? [] } : {}),
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
    // ⚠️ 派生索引（真相在正文 JSON）—— 这里写，reindex 也会重写
    difficulty,
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

/** 一条候选 + 它现在的处境（`exists` = 内容已在盘上 ⇒ 生成那一步直接跳过） */
interface SplitItem extends ArticleCandidate {
  id: string
  exists: boolean
}

/** 一条的结局 —— 界面上就是「入库列表」里那一行 */
interface IngestResult {
  id: string
  text: string
  translation: string
  /** 合成后的档位（0–3）；没有判据分时是 -1（界面据此标红） */
  difficulty: number
  /** 三个判据分 [词汇, 发音, 长度]；没给就是 null */
  scores: DifficultyScores | null
  reason: string
  tags: string[]
  status: 'done' | 'skipped' | 'failed'
  error?: string
}

/**
 * ⭐ 第一步：LLM 把多段输入拆成 1–N 条 + 纠错 + 给出四条元数据（**不落盘、不生成音频**）。
 *
 * ⚠️ 去重在这里就先算出来给界面看：`exists` 为真的条目在生成那一步会被跳过，
 *    省掉的正是**唯一按量花钱**的 TTS（顺序的理由见 spec.md 第九节）。
 */
async function runSplit(job: Job, text: string): Promise<void> {
  // ⚠️ 拆分是**代码按空行**做的（shared 的 splitParagraphs，确定性）——
  //    模型只负责纠错 + 四项元数据，见 spec.md 第九节
  job.step = 'LLM：纠错 + 难度 / 标签（分段由代码按空行做）'
  const list = await gradeArticles(text)
  const items: SplitItem[] = []
  const seen = new Set<string>()
  for (const c of list) {
    const id = articleIdOf(c.text)
    // ⚠️ 批内去重：输入里同一句出现两次时只留一条（否则同一份音频会生成两次）
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ ...c, id, exists: existsSync(contentAbsPathOf(id)) })
  }
  if (items.length === 0) throw new Error('模型没拆出任何句子 —— 输入是英文吗？')
  for (const it of items) {
    const lb = (v: typeof it.difficulty) => (v === null ? '—' : LEVEL_LABEL[v])
    const total = weightedScoreOf(it.scores)
    const sc = it.scores === null ? '判据分缺' : '词汇/发音/长度 ' + it.scores.join('/')
    job.log.push((it.exists ? '⏭ 已存在 ' : '· ') + it.id + '  ' + lb(it.difficulty) +
      (total === null ? '' : ' ' + total.toFixed(1)) + '（' + sc + '）  ' + it.text)
    job.log.push('    ' + it.reason)
  }
  job.step = '完成'
  job.status = 'done'
  job.result = { items, existsCount: items.filter((i) => i.exists).length }
}

/**
 * ⭐ 第二、三步：批量落正文 → 批量 TTS → 批量入库（草稿）。
 *
 * ⚠️⚠️ **顺序是刻意的，别改成「逐条一条龙」**（理由见 spec.md 第九节）：
 *    ① 正文先全部落盘 —— TTS 的词级时间戳要写回它，文件不存在就没有可写回的地方；
 *    ② 再批量跑 TTS —— 这是唯一按量花钱的一步，放在最后意味着前面任何一条不合格都不用花钱；
 *    ③ 最后才写库（草稿）。中途挂掉时库里不会留半成品行。
 * ⚠️ `exists` 的条目**直接跳过**：内容已经在了，不重复花那份钱。
 * ⚠️ 单条失败**不拖垮整批**：记下错误继续跑，结果里逐条给出 status。
 * ⚠️⚠️ **id 一律按 text 重算**，不信客户端传来的那个 —— 候选的正文是可以在界面上手改的，
 *    改了正文就是另一条内容（id = sha256(text)）；沿用旧 id 会把音频写到错误的文件上。
 */
async function runIngest(job: Job, mode: Mode, incoming: SplitItem[]): Promise<void> {
  const items = incoming
    .map((it) => ({ ...it, text: String(it.text ?? '').trim() }))
    .filter((it) => it.text !== '')
    .map((it) => ({ ...it, id: articleIdOf(it.text) }))
  const results: IngestResult[] = []
  const base = (it: SplitItem): Omit<IngestResult, 'status' | 'error'> => ({
    id: it.id, text: it.text, translation: it.translation,
    difficulty: it.difficulty ?? -1, scores: it.scores,
    reason: it.reason, tags: it.tags,
  })

  // ① 落正文
  job.step = '① 落正文（' + items.length + ' 条）'
  const prepared: Array<{ it: SplitItem; created: boolean }> = []
  for (const it of items) {
    if (existsSync(contentAbsPathOf(it.id))) {
      results.push({ ...base(it), status: 'skipped' })
      job.log.push('⏭ 已存在，跳过（省一次生成）：' + it.id + '  ' + it.text.slice(0, 40))
      continue
    }
    /**
     * ⚠️ 三个判据分必须在场：**档位是算出来的**，没有分就没有档位。
     *    界面会拦住（三个下拉里没有「未定」），这里再兜一道。
     */
    if (it.difficulty === null || it.scores === null) {
      results.push({ ...base(it), status: 'failed', error: '缺少判据分（词汇 / 发音 / 长度 各 1–5）' })
      job.log.push('❌ 缺少判据分：' + it.text.slice(0, 40))
      continue
    }
    const created = !existsSync(contentAbsPathOf(it.id))
    await writeContentFile(it.id, {
      id: it.id, text: it.text, translation: it.translation,
      difficulty: it.difficulty, scores: it.scores,
      reason: it.reason, tags: it.tags,
      // ⭐ 词表与连读标注来自这一次 LLM 调用（句中释义）—— 与正文一起落盘
      words: it.words, links: it.links,
    })
    prepared.push({ it, created })
  }

  // ② 批量 TTS
  job.step = '② fish：整句标准音（' + prepared.length + ' 条）'
  const ok: typeof prepared = []
  for (const p of prepared) {
    try {
      // ⚠️ 只合成整句：逐词音频与时间戳随「点词改走微信 TTS」一起删掉了
      const prod = await produceStandardAudio(p.it.id, p.it.text, { force: true })
      job.log.push('🔊 ' + p.it.id + '  ' + prod.alignment.audioDuration.toFixed(2) + 's / ' +
        prod.wordCount + ' 个词')
      ok.push(p)
    } catch (err) {
      /**
       * ⚠️ 失败时删掉**这次新建**的正文：留着它，下次部署 loadSeedArticles 会扫到，
       *    并按 DB 默认值（isActive 默认 true）插进库 —— 等于悄悄上线一句没音的句子。
       *    已有文件（重新生成同一句）不能删，那不是这次新建的。
       */
      if (p.created) await unlink(contentAbsPathOf(p.it.id)).catch(() => {})
      results.push({ ...base(p.it), status: 'failed', error: (err as Error).message })
      job.log.push('❌ 生成失败（已回滚正文）：' + p.it.id + '  ' + (err as Error).message)
    }
  }

  // ③ 入库（草稿）
  job.step = '③ 入库（草稿）'
  for (const p of ok) {
    try {
      await upsertArticle(mode, {
        id: p.it.id, text: p.it.text, translation: p.it.translation,
        scores: p.it.scores!,
        reason: p.it.reason, tags: p.it.tags, publish: false,
      })
      results.push({ ...base(p.it), status: 'done' })
      job.log.push('✓ 入库（草稿）：' + p.it.id)
    } catch (err) {
      results.push({ ...base(p.it), status: 'failed', error: (err as Error).message })
      job.log.push('❌ 入库失败：' + p.it.id + '  ' + (err as Error).message)
    }
  }

  job.step = '完成'
  job.status = 'done'
  job.result = {
    items: results,
    done: results.filter((r) => r.status === 'done').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  }
}

/**
 * ⭐ 第四步：批量发布（或下架）—— 只动库里的发布位，**不重写正文**。
 *
 * ⚠️ `publishedAt` 只在**草稿 → 已发布**那一刻写（与 upsertArticle 同一条规矩）：
 *    反复发布会把它刷成「最后一次编辑时间」，那就答非所问了。
 * ⚠️ 顺手刷一次派生索引：正文可能被手工改过（难度 / 标签）。
 */
async function setPublishedBatch(
  mode: Mode,
  ids: string[],
  publish: boolean,
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const d = await dbOf(mode)
  const out: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const id of ids) {
    try {
      const [cur] = await d
        .select({ isActive: articles.isActive })
        .from(articles)
        .where(eq(articles.id, id))
        .limit(1)
      if (!cur) { out.push({ id, ok: false, error: '句库没有这一条' }); continue }
      await d
        .update(articles)
        .set({ isActive: publish, ...(publish && !cur.isActive ? { publishedAt: new Date() } : {}) })
        .where(eq(articles.id, id))
      await syncArticleIndex(id, d)
      out.push({ id, ok: true })
    } catch (err) {
      out.push({ id, ok: false, error: (err as Error).message })
    }
  }
  return out
}

/**
 * ⚠️ 这里**曾经有 runRegenerateAudio**（「重做标准音」的异步任务）——
 *    用户 2026-09 要求去掉：那个动作当年是为了修**逐词切片的坏区间**才需要的，
 *    而逐词音频已经不存在（点词走微信 TTS）；整句音频坏了，重跑 `pnpm content:audio`
 *    或重新生成更干净，不必在管理台里再留一个入口。
 */

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
  // ⚠️ 现在**只有整句**：逐词切片随「点词播放改走微信 TTS」一起删了（2026-09），
  //    所以这里也只剩 /<id>.mp3 一种形状。
  const audio = RE_AUDIO.exec(path)
  if (audio) {
    const abs = resolve(ROOT, 'content/audio', audio[1]! + '.mp3')
    if (!existsSync(abs)) return send(res, 404, 'not found')
    return serveFile(req, res, abs)
  }

  // ---- 句库列表 ----
  if (path === '/api/articles' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500)
    const list = await listArticles(S.env, q, limit)
    // ⚠️ 标签映射与档位顺序只给一份（服务端是唯一来源，前端不自己抄）
    return ok(res, {
      env: S.env,
      list,
      levelLabels: LEVEL_LABEL,
      levelOrder: LEVEL_ORDER,
      /**
       * ⭐ 难度公式随 bootstrap 下发（权重 + 切分点）。
       * ⚠️ 前端要**实时**显示「三个分 → 哪一档」—— 只有这里一处是真相，
       *    前端自己再写一份阈值的话，调了公式页面就开始说谎。
       */
      difficultyWeights: DIFFICULTY_WEIGHTS,
      difficultyBands: DIFFICULTY_BANDS,
    })
  }

  /**
   * ---- 批量入库：三步各一个入口 ----
   *
   * ⚠️ 拆成三个入口而不是一条龙，是为了让**人在中间看一眼**：
   *    拆分（LLM）→ 人确认/改 → 生成（TTS）→ 人勾选 → 发布。
   *    TTS 是唯一按量花钱的一步，放在人确认之后（理由见 spec.md 第九节）。
   */
  if (path === '/api/split' && req.method === 'POST') {
    const b = await body(req)
    const text = String(b.text ?? '').trim()
    if (!text) return fail(res, '缺少 text')
    const jobId = startJob((job) => runSplit(job, text))
    return ok(res, { jobId })
  }

  if (path === '/api/ingest' && req.method === 'POST') {
    const b = await body(req)
    const items = Array.isArray(b.items) ? (b.items as SplitItem[]) : []
    if (items.length === 0) return fail(res, '没有要生成的条目')
    const mode = S.env
    const jobId = startJob((job) => runIngest(job, mode, items))
    return ok(res, { jobId })
  }

  if (path === '/api/publish' && req.method === 'POST') {
    const b = await body(req)
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : []
    if (ids.length === 0) return fail(res, '没有要处理的条目')
    // ⚠️ 不带 publish 字段 = 发布；显式传 false 才是下架
    const publish = b.publish !== false
    return ok(res, { results: await setPublishedBatch(S.env, ids, publish) })
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
      // ⭐ 难度：档位（库列，派生索引）+ 三个判据分与加权分（正文 JSON 才是真相）
      difficulty: row.difficulty ?? null,
      scores: normalizeScores(c?.scores),
      score: weightedScoreOf(c?.scores),
      /**
       * ⭐ 给用户看的那句话 —— **真相在正文 JSON**（它不进库，见 types/content.ts）。
       *    读出来给运营看：运营就是照它审的（"这句话难在哪"读者能不能看懂）。
       */
      reason: typeof c?.reason === 'string' ? c.reason : null,
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
      /** ⭐ 词间连读标注（与 words 一一对应；空串 = 不连）—— 详情页在两行之间显示它 */
      links: Array.isArray(c?.links) ? c.links : [],
      contentOnDisk: Boolean(c),
      scheduledDates: sched.map((s) => s.date).sort(),
      /**
       * ⚠️ 常量跟着详情一起下发：**直接打开 / 刷新详情页**时不会先经过列表接口，
       *    没有它们页面会把档位显示成「未定」（前端不硬编码映射与公式，见 app.js）。
       */
      levelLabels: LEVEL_LABEL,
      difficultyWeights: DIFFICULTY_WEIGHTS,
      difficultyBands: DIFFICULTY_BANDS,
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
    /**
     * ⭐ 判据分：**不传就沿用正文里的旧值** —— 保存译文 / 标签不该把难度弄丢。
     * ⚠️ 档位**不给直接改**，只给三个分：difficulty 一律由它们算出来（见 upsertArticle），
     *    这样正文里的 difficulty 与 scores 永远自洽（content-files.test.ts 会验算）。
     */
    const scores = normalizeScores(b.scores ?? c.scores)
    if (scores === null) return fail(res, 'scores（三个判据分）必须是 1–5 的三个整数')
    const difficulty = difficultyFromScores(scores)!
    /**
     * ⭐ 给用户看的那句话：**可以手改**（它要过运营的眼）。
     * ⚠️ 不传就沿用正文里的旧值 —— 保存译文不该把这句话弄丢。
     */
    const reason = typeof b.reason === 'string' ? b.reason.trim() : (typeof c.reason === 'string' ? c.reason : '')
    const tags = normalizeTags(b.tags ?? c.tags)

    /**
     * ⭐ 词表：**人工修正**用（对话框里改音标 / 句重音 / 音节 / 释义 / 技巧）。
     *
     * ⚠️ 必须校验：词表是朗读页逐词渲染与点按的依据，条数错一位就是
     *    「点这个词、看那个词的信息」，而**没有任何报错**。
     * ⚠️ `links` 不传就沿用正文里那份（词数没变，边界还是那些边界）。
     * ⚠️ 音节拼回来必须等于原词 —— 这是词表的核心不变量（CI 也查）。
     */
    let words: ArticleWordItem[] | undefined
    let links: string[] | undefined
    if (b.words !== undefined) {
      const check = validateWordTable(String(c.text ?? ''), b.words, b.links ?? c.links)
      if (check.error) return fail(res, check.error)
      words = check.words
      links = check.links
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
      scores,
      reason,
      tags,
      publish: b.publish === undefined ? undefined : b.publish === true,
      words: words,
      links: links,
    })
    return ok(res, {
      id,
      translation,
      difficulty,
      scores,
      reason,
      tags,
      /** ⭐ 保存后的发布状态 —— 唯一真相是 is_active（content_status 已删） */
      published: publish,
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

  /**
   * ⚠️ 这里**曾经有「重做标准音」接口**（POST /api/articles/:id/audio）——
   *    用户 2026-09 要求去掉。它当年是为修**逐词切片的坏区间**而生的，
   *    而逐词音频已经不存在了；整句音频坏了重跑 pnpm content:audio 更干净。
   */

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
