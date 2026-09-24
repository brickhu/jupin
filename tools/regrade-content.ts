/**
 * ⭐ 用**当前提示词**重判存量正文的两个档位与那句「难在哪」。
 *
 * 什么时候必须跑它：改了 tools/pipeline/src/lib/article-meta.ts 的 SYSTEM（判据 / 锚点）之后。
 * 档位是**模型判的**，不是算出来的 —— 提示词一变，存量内容的档位就与新口径不一致了，
 * 而没有任何东西会发现（除非有人一条条点开看）。
 *
 * 用法：
 *   pnpm content:regrade           只看（默认，不改任何文件）
 *   pnpm content:regrade --apply   写回正文 JSON，并刷新 articles 的派生索引
 *
 * ⚠️ 只改 pronLevel / vocabLevel / reason 三个字段 + 删掉旧的 difficulty；
 *    **text 一个字都不动** —— 所以 id 不变（内容寻址：id = sha256(text)），
 *    老提交与老排期仍然对得上这条句子。
 * ⚠️ 写完必须刷索引：articles.pron_level / vocab_level 是**派生索引**
 *    （真相在正文 JSON，见 apps/server/src/services/article-index.ts）。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'
import { generateArticleMeta } from './pipeline/src/lib/article-meta'
import { LEVEL_LABEL, normalizeLevel } from '../packages/shared/src/level'
import type { ArticleLevel } from '../packages/shared/src/types/content'

loadEnv('local')

const apply = process.argv.includes('--apply')
const DIR = join(ROOT, 'content/articles')

const label = (v: ArticleLevel | null): string => (v === null ? '—' : LEVEL_LABEL[v])

/** 只在 --apply 时才连库 —— 只看的时候不该需要数据库（动态 import 推迟连接） */
let sync: ((id: string) => Promise<unknown>) | null = null
if (apply) {
  const mod = await import('../apps/server/src/services/article-index')
  sync = (id: string) => mod.syncArticleIndex(id)
}

const files = (await readdir(DIR)).filter((f) => f.endsWith('.json')).sort()
console.log(apply ? '⚠️ APPLY：会写回正文 JSON 并刷新索引' : '（只看不改；加 --apply 才写回）')
console.log('')

let changed = 0
for (const f of files) {
  const p = join(DIR, f)
  const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  const meta = await generateArticleMeta(String(raw.text))

  if (meta.pronLevel === null || meta.vocabLevel === null) {
    console.log('⚠️ 跳过（模型没给全两个档位）：' + f)
    continue
  }

  const legacy = raw.difficulty !== undefined
  const before = legacy
    ? 'difficulty ' + label(normalizeLevel(raw.difficulty))
    : '发音 ' + label(normalizeLevel(raw.pronLevel)) + ' / 词汇 ' + label(normalizeLevel(raw.vocabLevel))
  const after = '发音 ' + label(meta.pronLevel) + ' / 词汇 ' + label(meta.vocabLevel)
  const noop =
    !legacy &&
    raw.pronLevel === meta.pronLevel &&
    raw.vocabLevel === meta.vocabLevel &&
    raw.reason === meta.reason

  console.log('【' + f + '】 ' + before + ' → ' + after + (noop ? '  （无变化）' : ''))
  console.log('    ' + String(raw.text))
  console.log('    ' + meta.reason)
  console.log('')

  if (noop || !apply) continue

  /** ⚠️ 固定字段顺序（与 admin 的 writeContentFile 一致），并**保住将来新增的字段** */
  const next: Record<string, unknown> = {
    id: raw.id,
    text: raw.text,
    translation: String(raw.translation ?? ''),
    pronLevel: meta.pronLevel,
    vocabLevel: meta.vocabLevel,
    reason: meta.reason,
    tags: meta.tags,
    words: raw.words ?? [],
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'difficulty' && !(k in next)) next[k] = raw[k]
  }
  await writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await sync!(String(raw.id))
  changed++
}

console.log(apply ? '✅ 已更新 ' + changed + ' 条（索引已刷新）' : '（只看不改）要写回就加 --apply')

/**
 * ⚠️ 必须显式退出：--apply 时 syncArticleIndex 会开一个 mysql 连接池，
 *    池里的连接让事件循环一直活着 —— 不退出的话脚本跑完也不结束
 *    （表现是「文件都写好了，命令却一直挂着」）。
 *    与 src/db/seed.ts 同一个做法。
 */
process.exit(0)
