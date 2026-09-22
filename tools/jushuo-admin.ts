#!/usr/bin/env node
/**
 * 句库管理 CLI —— 「加一条句子」「安排到某日推荐」这些**运营动作**的唯一入口。
 *
 *   tsx tools/jushuo-admin.ts add-sentence --text "..." --translation "..."
 *   tsx tools/jushuo-admin.ts schedule-set --date tomorrow --id 6
 *   tsx tools/jushuo-admin.ts list
 *
 * ⭐ 为什么要有它，而不是让人（或 agent）直接写 SQL：
 *    「加一条句子」在库里是**三处**协同改动，少一处就是坏数据：
 *      ① content/articles/{id}.json  正文（⚠️ 正文不入库，见 db/schema.ts 顶部）
 *      ② content/audio/{id}.mp3 + {id}/w{i}.mp3  标准音与逐词切片
 *      ③ articles 行                 索引 + 发布状态
 *    再叠加「排期」就是第 ④ 处：schedules 行（source='scheduled'）。
 *    少了 ②，句子能显示但点词没声、没标准音；少了 ③，页面根本读不到。
 *    把这些绑成一个命令，agent 就不可能只做对一半。
 *
 * ⭐ 复用 server 自己的服务，不重写一套：
 *    standard-audio.ts 的 audioKeyOf / seedStandardAudio、db/schema.ts 的表定义
 *    都是**直接 import** 进来的。这样可以保证 CLI 写进去的东西
 *    和服务端读出来的东西永远是同一套约定（key 格式、目录结构、字段名）。
 *
 * ⚠️ 所有子命令都支持 `--json`：DSH 插件靠它拿结构化结果，
 *    **不要**把 --json 的输出改成人类可读的多行文本。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { env, envError } from '../apps/server/src/env'
import { db } from '../apps/server/src/db'
import { articles, schedules } from '../apps/server/src/db/schema'
import { audioKeyOf, seedStandardAudio } from '../apps/server/src/services/standard-audio'
import { ROOT } from './env.mjs'
import {
  listArticleIdsOnDisk,
  produceStandardAudio,
  readArticleText,
} from './pipeline/src/lib/audio-assets'

import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { addDays, isValidDay, today } from '../packages/shared/src/day'

// ─────────────────────────────── 参数解析 ───────────────────────────────

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out.flags[key] = true
    } else {
      out.flags[key] = next
      i++
    }
  }
  return out
}

function str(args: Args, key: string): string | undefined {
  const v = args.flags[key]
  return typeof v === 'string' ? v : undefined
}

function fail(message: string): never {
  // ⚠️ 失败也要是 JSON —— 插件按 JSON 解析，纯文本会让它只能靠猜
  const wantsJson = process.argv.includes('--json')
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  } else {
    console.error(`✗ ${message}`)
  }
  process.exit(1)
}

function ok(payload: Record<string, unknown>, human: string): void {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: true, ...payload }, null, 2))
  } else {
    console.log(human)
  }
}

// ─────────────────────────────── 公共工具 ───────────────────────────────

function articleJsonPath(id: number): string {
  return resolve(ROOT, 'content/articles', `${id}.json`)
}

/** 下一个可用 id —— 盘上和库里都算，取最大 + 1 */
async function nextArticleId(): Promise<number> {
  const diskIds = await listArticleIdsOnDisk()
  const rows = await db.select({ id: articles.id }).from(articles)
  const all = [...diskIds, ...rows.map((r) => r.id)]
  return (all.length === 0 ? 0 : Math.max(...all)) + 1
}

/** 'today' / 'tomorrow' / '+3' / 'YYYY-MM-DD' → 'YYYY-MM-DD'（北京时间） */
function resolveDate(input: string): string {
  if (input === 'today') return today()
  if (input === 'tomorrow') return addDays(today(), 1)
  const rel = /^\+(\d+)$/.exec(input)
  if (rel) return addDays(today(), Number(rel[1]))
  if (!isValidDay(input)) {
    fail(`日期格式不对："${input}"。要 YYYY-MM-DD，或 today / tomorrow / +N`)
  }
  return input
}

async function requireArticle(id: number): Promise<typeof articles.$inferSelect> {
  const rows = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  const row = rows[0]
  if (!row) fail(`句库里没有 id=${id} 的句子。先 add-sentence，或 list 看一眼`)
  return row
}

// ─────────────────────────────── 子命令 ───────────────────────────────

/**
 * add-sentence —— 加一条新句子（含标准音与逐词切片）。
 *
 * ⚠️ id 必须**先定**再合成音频：音频的落盘路径 content/audio/{id}.mp3
 *    和切片目录都带 id，事后改 id 就要把文件全部改名。
 */
async function cmdAddSentence(args: Args): Promise<void> {
  const text = str(args, 'text')?.trim()
  if (!text) fail('缺少 --text')
  const translation = str(args, 'translation')?.trim() ?? ''
  const publish = args.flags.publish === true
  const noAudio = args.flags['no-audio'] === true
  const force = args.flags.force === true

  const id = str(args, 'id') ? Number(str(args, 'id')) : await nextArticleId()
  if (!Number.isInteger(id) || id <= 0) fail(`--id 必须是正整数`)

  const jsonPath = articleJsonPath(id)
  if (existsSync(jsonPath) && !force) {
    fail(`content/articles/${id}.json 已存在。要覆盖请加 --force`)
  }

  const words = text.split(/\s+/).filter(Boolean)

  // ① 正文：先落盘。seedStandardAudio 要靠它算切片个数
  await writeFile(
    jsonPath,
    `${JSON.stringify({ id, text, translation, words: [] }, null, 2)}\n`,
    'utf8',
  )

  // ② 标准音 + 逐词切片
  let wordCount = words.length
  let audioNote = '已跳过（--no-audio）'
  if (!noAudio) {
    const r = await produceStandardAudio(id, text, { force: true })
    wordCount = r.wordCount
    audioNote = r.skipped ? '已存在，跳过' : `已生成 ${r.wordCount} 个切片`
  }

  // ③ articles 行 —— 索引 + 发布状态 + standard_audio 这一列
  const contentStatus = publish ? 'published' : 'draft'
  const set = {
    contentJson: `/content/articles/${id}.json`,
    contentStatus,
    isActive: publish,
    ...(noAudio ? {} : { standardAudio: audioKeyOf(id) }),
  }
  await db
    .insert(articles)
    .values({ id, ...set })
    .onDuplicateKeyUpdate({ set })

  ok(
    {
      articleId: id,
      contentStatus,
      wordCount,
      contentJson: `/content/articles/${id}.json`,
      audioPath: noAudio ? null : `content/audio/${id}.mp3`,
      standardAudio: noAudio ? null : audioKeyOf(id),
      text,
      translation,
    },
    [
      `✓ 已加句子 #${id}（${contentStatus}）`,
      `  正文：content/articles/${id}.json`,
      `  标准音：${audioNote}`,
      `  词数：${wordCount}`,
      publish ? '  ⚠️ 已标记 published —— 但没有排期就不会出现在任何一天' : '  当前是 draft',
    ].join('\n'),
  )
}

/** audio —— 只为已有句子补/重做标准音 */
async function cmdAudio(args: Args): Promise<void> {
  const id = Number(str(args, 'id') ?? '')
  if (!Number.isInteger(id) || id <= 0) fail('缺少 --id')
  const text = await readArticleText(id)
  if (!text) fail(`content/articles/${id}.json 不存在或没有 text`)

  const r = await produceStandardAudio(id, text, { force: args.flags.force === true })
  await db
    .update(articles)
    .set({ standardAudio: audioKeyOf(id) })
    .where(eq(articles.id, id))

  ok(
    {
      articleId: id,
      wordCount: r.wordCount,
      audioPath: `content/audio/${id}.mp3`,
      audioDuration: r.alignment.audioDuration,
      skipped: r.skipped,
    },
    `✓ #${id} 标准音就绪：${r.wordCount} 个切片（${r.skipped ? '已存在' : '新生成'}）`,
  )
}

/**
 * schedule-set —— 把某句排到某天。
 *
 * ⚠️ 默认**不覆盖**已有排期：覆盖是运营事故（用户读的句子会变），
 *    必须显式加 --force。这条约束是自动化的前提 —— 让 agent
 *    不可能"顺手"改掉别人排好的档期。
 */
async function cmdScheduleSet(args: Args): Promise<void> {
  const rawDate = str(args, 'date')
  if (!rawDate) fail('缺少 --date（YYYY-MM-DD 或 today / tomorrow / +N）')
  const date = resolveDate(rawDate)

  const articleId = Number(str(args, 'id') ?? '')
  if (!Number.isInteger(articleId) || articleId <= 0) fail('缺少 --id')

  const article = await requireArticle(articleId)
  if (!existsSync(articleJsonPath(articleId))) {
    fail(`#${articleId} 在库里但没有 content/articles/${articleId}.json —— 正文缺失，先补内容`)
  }
  if (article.contentStatus !== 'published') {
    fail(
      `#${articleId} 的 contentStatus 是 ${article.contentStatus}，不能排期。` +
        `先 publish（add-sentence 加 --publish，或跑 publish --id ${articleId}）`,
    )
  }

  const existing = (
    await db.select().from(schedules).where(eq(schedules.date, date)).limit(1)
  )[0]

  if (existing && existing.articleId !== articleId && args.flags.force !== true) {
    fail(
      `${date} 已经排了 #${existing.articleId}（source=${existing.source}）。` +
        `要改成 #${articleId} 请加 --force`,
    )
  }

  await db
    .insert(schedules)
    .values({ date, articleId, source: 'scheduled' })
    .onDuplicateKeyUpdate({ set: { articleId, source: 'scheduled' } })

  ok(
    {
      date,
      articleId,
      source: 'scheduled',
      replaced: existing && existing.articleId !== articleId ? existing.articleId : null,
      text: await readArticleText(articleId),
    },
    `✓ ${date} → #${articleId}「${(await readArticleText(articleId))?.slice(0, 40)}…」` +
      (existing && existing.articleId !== articleId ? `（原为 #${existing.articleId}）` : ''),
  )
}

/** publish —— draft → published */
async function cmdPublish(args: Args): Promise<void> {
  const id = Number(str(args, 'id') ?? '')
  if (!Number.isInteger(id) || id <= 0) fail('缺少 --id')
  await requireArticle(id)
  await db
    .update(articles)
    .set({ contentStatus: 'published', isActive: true })
    .where(eq(articles.id, id))
  ok({ articleId: id, contentStatus: 'published' }, `✓ #${id} 已发布（isActive=true）`)
}

/** upload —— 把 content/audio 灌进对象存储（云端才需要） */
async function cmdUpload(_args: Args): Promise<void> {
  const r = await seedStandardAudio((m) => console.error(m))
  ok(
    { uploaded: r.uploaded, skipped: r.skipped, missing: r.missing, storage: env.STORAGE },
    `✓ 对象存储：新灌 ${r.uploaded}，跳过 ${r.skipped}` +
      (r.missing.length ? `\n  ⚠️ 盘上缺标准音：#${r.missing.join(', ')}` : ''),
  )
}

/** list —— 句库 + 未来排期总览 */
async function cmdList(args: Args): Promise<void> {
  const limit = Number(str(args, 'limit') ?? '50')
  const rows = await db.select().from(articles).orderBy(asc(articles.id)).limit(limit)
  const sched = await db
    .select()
    .from(schedules)
    .where(gte(schedules.date, today()))
    .orderBy(asc(schedules.date))
    .limit(limit)

  const items = []
  for (const r of rows) {
    const text = await readArticleText(r.id)
    items.push({
      id: r.id,
      contentStatus: r.contentStatus,
      isActive: r.isActive,
      hasAudio: r.standardAudio !== null,
      audioOnDisk: existsSync(resolve(ROOT, 'content/audio', `${r.id}.mp3`)),
      text,
    })
  }

  ok(
    { articles: items, upcomingSchedules: sched.map((s) => ({ date: s.date, articleId: s.articleId, source: s.source })), today: today() },
    [
      `句库（${items.length} 条）：`,
      ...items.map(
        (a) =>
          `  #${a.id} [${a.contentStatus}]${a.isActive ? ' 竞技开' : ''}` +
          ` 音:${a.audioOnDisk ? '✓' : '✗'}  ${(a.text ?? '(正文缺失)').slice(0, 56)}`,
      ),
      '',
      `未来排期（${sched.length} 条，今天 ${today()}）：`,
      ...sched.map((s) => `  ${s.date} → #${s.articleId} (${s.source})`),
    ].join('\n'),
  )
}

/** get —— 单日排期 */
async function cmdScheduleGet(args: Args): Promise<void> {
  const rawDate = str(args, 'date')
  if (!rawDate) fail('缺少 --date')
  const date = resolveDate(rawDate)
  const row = (await db.select().from(schedules).where(eq(schedules.date, date)).limit(1))[0]
  if (!row) {
    ok({ date, articleId: null, source: null }, `${date} 没有落库的排期（访问时会按天号轮转自动补一行）`)
    return
  }
  const text = await readArticleText(row.articleId)
  ok({ date, articleId: row.articleId, source: row.source, text }, `${date} → #${row.articleId} (${row.source})\n  ${text ?? ''}`)
}

// ─────────────────────────────── 入口 ───────────────────────────────

const HELP = `句库管理 CLI

  add-sentence --text "..." [--translation "..."] [--id N] [--publish] [--no-audio] [--force]
  audio         --id N [--force]          只为已有句子补/重做标准音
  schedule-set  --date <Y|today|tomorrow|+N> --id N [--force]
  schedule-get  --date <Y|today|tomorrow|+N>
  publish       --id N
  upload                                  把 content/audio 灌进对象存储
  list          [--limit N]

⚠️ 排期要求句子已 published；覆盖已有排期必须显式 --force
⚠️ 全局加 --json 拿结构化输出`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP)
    return
  }

  // ⚠️ 配置坏掉时必须立刻说清楚，不能让「连不上库」掩盖成「命令没反应」
  if (envError) fail(`环境配置有问题：${envError}`)

  const args = parseArgs(rest)
  const handlers: Record<string, (a: Args) => Promise<void>> = {
    'add-sentence': cmdAddSentence,
    audio: cmdAudio,
    'schedule-set': cmdScheduleSet,
    'schedule-get': cmdScheduleGet,
    publish: cmdPublish,
    upload: cmdUpload,
    list: cmdList,
  }

  const handler = handlers[cmd]
  if (!handler) fail(`未知命令 "${cmd}"\n\n${HELP}`)

  await handler(args)
  process.exit(0)
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
