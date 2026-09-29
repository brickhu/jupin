import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ArticleContent } from '@jushuo/shared'

import { db } from '../db'
import { articles } from '../db/schema'
import { eq } from 'drizzle-orm'

import { env } from '../env'

/**
 * 内容解析 —— 把**文章 id** 变成真正的正文。
 *
 * ⚠️⚠️ 路徑是**推导**出来的，不是存出来的：
 *    id = sha256(正文) 的前 16 位，正文文件名就是它 —— 所以
 *      `contentPathOf(id) === '/content/articles/<id>.json'`
 *    以前 `articles` 上有一列 `content_json` 存这个路径，那是**第二个真相**：
 *    它写的永远是同一个式子，却能跟 id 漂移（没有任何东西检查两者一致）。
 *    那一列已删除。
 * ⚠️ 「将来放 CDN」不需要每行存地址：CDN 会镜像同一套相对路径，
 *    变的只是**根**（STATIC_ROOT / 将来的 CDN base），不是每条记录的路径。
 *
 * ⚠️ 这是**几个消费方共用的唯一入口**：
 *      · routes/submissions.ts / scoring.ts —— 要 text 当评分参考文本
 *      · routes/articles.ts 的 /content —— 要整份数据给客户端渲染
 *      · services/article-index.ts —— 要从正文物化难度/标签索引
 *    几处必须走同一段解析，否则会出现「能评分、但页面读不出句子」这种漂移。
 */

/**
 * 静态资源**根目录** —— contentJson 相对它解析。
 *
 * ⚠️⚠️ 这里踩过一次：把「content 目录」当成了基准，
 *    于是 contentJson `/content/articles/1.json` 被解析成
 *    `/app/content/content/articles/1.json`，正文永远读不到。
 *    contentJson 是**完整的 URL 路径**（将来直接就是 CDN 上的地址），
 *    里面本来就含 content/ 这一段，所以基准必须是**根**，不是 content 目录。
 *
 * ⚠️ 候选之间靠「<root>/content 是否存在」来锚定，
 *    避免误选到某个碰巧存在的目录。
 */
export function resolveStaticRoot(): string | null {
  const candidates = [
    env.STATIC_ROOT,
    // 容器：WORKDIR=/app，content 在 /app/content
    process.cwd(),
    // 本机 pnpm dev：cwd 是 apps/server，仓库根在往上两级
    resolve(process.cwd(), '../..'),
  ].filter((d): d is string => Boolean(d))

  for (const dir of candidates) {
    const abs = resolve(dir)
    if (existsSync(resolve(abs, 'content'))) return abs
  }
  return null
}

/**
 * ⭐ **正文路径的唯一定义**：id 直接决定文件名。
 * ⚠️ 返回值是「相对静态根的 URL 路径」（含 content/ 这一段）——
 *    与将来 CDN 上的形状一致，换根不改路径。
 */
export function contentPathOf(articleId: string): string {
  return '/content/articles/' + articleId + '.json'
}

/** 读取正文；任何失败都返回 null（调用方决定是 404 还是空参考文本） */
export async function loadArticleContent(articleId: string): Promise<ArticleContent | null> {
  /**
   * ⭐⭐ **正文住在库里**（`articles.content`）—— 2026-09 用户定的方向：内容只走 admin。
   *
   * ⚠️ 这里以前是"按 id 推导出一个文件路径再读盘"（`content/articles/<id>.json`）。
   *    那套的病是**同一份内容两个住址**：正文在 git 里、`is_active` 在库里，
   *    于是"改不改得动"取决于本机仓库里那个文件在不在（admin 详情页会直接报
   *    「正文不在本机仓库里，改不了」），而部署包里还得永远带着 content/。
   *    ⇒ 现在库是唯一真相；`content/articles/*.json` 只剩"一次性导入"
   *      （`pnpm --filter @jushuo/server content:import`，见 scripts/import-content-files.ts）。
   *
   * ⚠️ `content` 为 NULL 与"文件不存在"同义：这份内容在这个环境里没有。
   *    调用方按 null 处理（列表接口跳过、详情接口 404、轮转池剔除）。
   */
  const [row] = await db
    .select({ content: articles.content })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  return row?.content ?? null
}

/**
 * 静态资源路径解析（根目录 + 越界防护）—— readStaticFile / staticFileStamp 共用。
 * ⚠️ 复用 resolveStaticRoot()，不要另起一套 —— 本项目已经因为"两个地方各自解析路径"
 *    踩过一次（contentJson 被解析成 /app/content/content/...）。
 */
function resolveStaticPath(relPath: string): string | null {
  const base = resolveStaticRoot()
  if (!base) return null
  const abs = resolve(base, relPath.replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + '/')) {
    console.warn(`[content] 拒绝越界路径：${relPath}`)
    return null
  }
  return abs
}

/**
 * 这个部署读得到这条句子的正文吗？
 *
 * ⚠️⚠️ 它现在是**库查询**（正文在 `articles.content`），不再 stat 文件 ——
 *    所以「内容刚发布、镜像还没重新部署」这一类不一致**从根上没有了**：
 *    发布进库的那一刻，所有副本立刻都读得到。
 *
 * ⚠️ 优先用调用方**手上已有的那一行**（`row.content !== null`）判断：
 *    轮转池那里本来就把 articles 全查出来了，再为每条查一次库是白花往返。
 *    这个函数留给"只有 id、没有行"的调用方。
 */
export function hasContent(row: { content: unknown }): boolean {
  return row.content !== null && row.content !== undefined
}

/** 读一个静态资源文件；拿不到就是 null */
export async function readStaticFile(relPath: string): Promise<Uint8Array | null> {
  const abs = resolveStaticPath(relPath)
  if (!abs) return null
  try {
    return new Uint8Array(await readFile(abs))
  } catch {
    return null
  }
}

/**
 * 静态资源的**版本戳**（size + mtime）—— 给「按文件内容做进程内缓存」的调用方。
 *
 * ⚠️⚠️ 为什么需要它：标准音的时长是解析 mp3 现算的、结果缓存在进程内。
 *    只按**路径**缓存的话，音频被重新生成（跑一次流水线 ④）之后，
 *    卡片上的时长会一直停留在旧值 —— 不报错，只是数字在骗人。
 *    带上这个戳，内容一变缓存自然失效；文件不在了返回 null（调用方按「没有」缓存）。
 */
export async function staticFileStamp(relPath: string): Promise<string | null> {
  const abs = resolveStaticPath(relPath)
  if (!abs) return null
  try {
    const s = await stat(abs)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

/** 只要参考文本（评分用）—— 拿不到就返回空串，让链路继续跑 */
export async function loadArticleRefText(articleId: string): Promise<string> {
  return (await loadArticleContent(articleId))?.text ?? ''
}

/**
 * 深度自检：正文这条链路**到底通没通**。
 *
 * ⭐ 为什么值得单独探一次：云托管 **CLI 没有看容器日志的命令**，
 *    而正文不在这个部署的镜像里时，客户端只看到一句「正文加载失败」——
 *    从这里倒推是哪一层断的几乎不可能。所以三层一次列清楚：
 *      ① 盘上：有几份正文、每一份是不是合法 JSON、文件名与 id 是否一致
 *      ② 库里：有几行「可读」（isActive）的句子
 *      ③ ⭐ **差集**：库里有行、盘上没有正文的 ——
 *         这一条才是「后台发布到云环境但还没部署」的检出器：
 *         库里立刻可见（能被选中排期），镜像里却要等下次部署才有正文。
 *
 * ⚠️⚠️ 这里曾经**采样写死** `content/articles/1.json`。
 *    内容寻址（id = sha256(text) 前 16 位）之后这个文件名永远不会存在，
 *    于是这个探针一直报「读不到」，而它恰恰是排查「正文加载失败」的唯一通道 ——
 *    一个永远红的自检比没有自检更糟：人会学会无视它。
 *    ⇒ 不再采样固定文件名，改成扫目录 + 全量核对不变量。
 *
 * ⚠️ db 用**动态 import**：本文件被 db/seed-articles.ts 引用，
 *    静态引 db 会把「内容解析」和「连接池」绑成一个环（见 seed-articles.ts 文件头）。
 *    探针失败也绝不能抛 —— /health 不该因为一次自检 500。
 */
export async function probeContent(): Promise<Record<string, unknown>> {
  const root = resolveStaticRoot()
  if (!root) {
    return { ok: false, error: '找不到静态资源根目录（可用 STATIC_ROOT 指定）' }
  }

  const files = await probeContentFiles(root)

  // ── ③ 库里有行、盘上没有正文的 ──
  const missing: string[] = []
  let activeRows: number | null = null
  let dbError: string | undefined
  try {
    const { db } = await import('../db')
    const { articles } = await import('../db/schema')
    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.isActive, true))
    activeRows = rows.length
    for (const row of rows) {
      const rel = contentPathOf(row.id)
      if (!existsSync(resolve(root, rel.replace(/^\/+/, '')))) missing.push(rel)
    }
  } catch (err) {
    // 探针不抛：库连不上时至少要把盘上那一层说清楚
    dbError = (err as Error).message.slice(0, 160)
  }

  return {
    ...files,
    ok: files.ok === true && missing.length === 0,
    /** 库里 isActive 的行数（null = 没查到） */
    activeRows,
    /**
     * ⭐ 库里说「有」、这个部署里读不到的正文个数。
     *    非 0 几乎只有一个原因：内容刚发布进库，但镜像还没重新部署。
     */
    missingCount: missing.length || undefined,
    missingContent: missing.length ? missing.slice(0, 5) : undefined,
    dbError,
  }
}

/**
 * 盘上那一层（纯文件，不碰库）。
 *
 * ⚠️ 单独导出是为了**可测**：给一个目录就能验，不需要数据库、不需要启动服务。
 *    DIAG_ENABLED 关着的时候 /health 不跑探针，测试是它唯一的守门人。
 */
export async function probeContentFiles(root: string): Promise<Record<string, unknown>> {
  if (!root) return { ok: false, error: '缺少根目录' }

  const dir = resolve(root, 'content/articles')
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  } catch (err) {
    return { ok: false, root, error: '读不到 content/articles：' + (err as Error).message }
  }

  /**
   * 逐份解析。坏 JSON / id 与文件名不一致 / text 为空 ——
   * 这三种都是「客户端读不出来」，而且构建和 tsc 都不会吭声。
   */
  const broken: string[] = []
  let sample: Record<string, unknown> | null = null
  for (const name of names) {
    const abs = resolve(dir, name)
    try {
      const txt = await readFile(abs, 'utf8')
      const parsed = JSON.parse(txt) as { id?: unknown; text?: unknown }
      const idOk = String(parsed.id ?? '') === name.replace(/\.json$/, '')
      const text = String(parsed.text ?? '')
      if (!idOk) broken.push(name + '（id 与文件名不一致）')
      else if (!text) broken.push(name + '（text 为空）')
      // 采样取第一份**读得通**的：用来给人看一眼「确实读到了正文」
      if (!sample && idOk && text) sample = { file: name, bytes: txt.length, head: text.slice(0, 48) }
    } catch (err) {
      broken.push(name + '（' + (err as Error).message.slice(0, 60) + '）')
    }
  }

  return {
    ok: broken.length === 0 && names.length > 0,
    root,
    /** 盘上正文份数 */
    files: names.length,
    brokenCount: broken.length || undefined,
    broken: broken.length ? broken.slice(0, 5) : undefined,
    sample,
    error: names.length === 0 ? 'content/articles 是空的（镜像里漏了 content 目录？）' : undefined,
  }
}
