/**
 * ⭐ 用**当前提示词**重判存量正文的难度、判据分与那句「朗读建议及收益」。
 *
 * 什么时候必须跑它：改了 tools/pipeline/src/lib/article-meta.ts 的 SYSTEM
 * （判据 / 锚点）或 shared/level.ts 的权重 / 切分点之后 ——
 * 那种改动会让**存量内容的档位与新口径不一致**，而没有任何东西会发现
 * （除非有人一条条点开看），只能靠整库重跑把正文拉齐。
 *
 * 用法：
 *   pnpm content:regrade                 只看（默认，不改任何文件）
 *   pnpm content:regrade --apply         写回正文 JSON，并刷新 articles 的派生索引
 *   pnpm content:regrade --only <子串>   只处理文件名含这个子串的（先拿一条试口径）
 *
 * ⚠️ 只改 difficulty / scores / challenge / advice / tags —— **text 一个字都不动**，
 *    所以 id 不变（内容寻址：id = sha256(text)），老提交与老排期仍然对得上这条句子。
 *    ⚠️ 顺手丢掉旧字段（两条轴的 `pronLevel` / `vocabLevel`，以及改名前那句的 `reason`）。
 * ⚠️ 写完必须刷索引：articles.difficulty 是**派生索引**（真相在正文 JSON，
 *    见 apps/server/src/services/article-index.ts）。只改文件不刷索引，
 *    「按档位筛」出来的结果就是旧档位。
 * ⚠️ **档位不在这个脚本里算**：gradeArticles 已经把 scores 合成成 difficulty
 *    （算术在 shared/level.ts，一处定义）。这里只负责读写文件 + 刷索引。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadEnv, ROOT } from './env.mjs'
import { gradeArticles } from './pipeline/src/lib/article-meta'
import { LEVEL_LABEL, normalizeLevel, weightedScoreOf } from '../packages/shared/src/level'
import type { ArticleLevel, DifficultyScores } from '../packages/shared/src/types/content'

loadEnv('local')

/**
 * ⚠️ 两句的字数上限 —— 与 `content-files.test.ts` 的断言**同一根线**。
 *    两处不一致的话，模型永远按宽的那个来（踩过：提示词写 45、测试放到 80，结果写出 88 字）。
 *
 * ⚠️ challenge 的 18 字**不是排版偏好，是分享卡标题的硬约束**：客户端会拼成
 *    「朗读挑战:」+ challenge，卡片标题两行约 25 字 —— 18 是给前缀留的余量。
 */
const CHALLENGE_MAX_CHARS = 18
/** advice：把挑战框小（边界 + 2–3 个坑 + 口语落点）；收紧到 90 是因为它只承担"建议"这一件事 */
const ADVICE_MAX_CHARS = 90

const apply = process.argv.includes('--apply')
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? (process.argv[onlyIdx + 1] ?? null) : null
const DIR = join(ROOT, 'content/articles')

const label = (v: ArticleLevel | null): string => (v === null ? '—' : LEVEL_LABEL[v])

/** "（词汇/发音/长度 4/2/3 = 3.1）" —— 判据分与加权分一起进日志，方便人核对档位 */
function scoreText(scores: DifficultyScores | null): string {
  const w = weightedScoreOf(scores)
  return w === null ? '（判据分缺）' : '（词汇/发音/长度 ' + scores!.join('/') + ' = ' + w.toFixed(1) + '）'
}

/** 只在 --apply 时才连库 —— 只看的时候不该需要数据库（动态 import 推迟连接） */
let sync: ((id: string) => Promise<unknown>) | null = null
if (apply) {
  const mod = await import('../apps/server/src/services/article-index')
  sync = (id: string) => mod.syncArticleIndex(id)
}

const files = (await readdir(DIR))
  .filter((f) => f.endsWith('.json') && (!only || f.includes(only)))
  .sort()
console.log(apply ? '⚠️ APPLY：会写回正文 JSON 并刷新索引' : '（只看不改；加 --apply 才写回）')
if (only) console.log('（--only ' + only + '：只处理 ' + files.length + ' 条）')
console.log('')

let changed = 0
for (const f of files) {
  const p = join(DIR, f)
  const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  // ⚠️ 一段一条（正文里不会有空行）—— 段数不为 1 就是内容本身有问题，跳过别乱写
  const list = await gradeArticles(String(raw.text))
  if (list.length !== 1) {
    console.log('⚠️ 跳过（拆出了 ' + list.length + ' 段，预期 1 段）：' + f)
    continue
  }
  const meta = list[0]!
  if (meta.difficulty === null || meta.scores === null) {
    console.log('⚠️ 跳过（模型没给全三个判据分）：' + f)
    continue
  }

  /**
   * 旧正文的样子：两条轴时代（`pronLevel` + `vocabLevel`）或干脆没有 scores。
   * ⚠️ 那时发音轴叫 `pronLevel`（**不是** `difficulty`）—— 日志要按旧口径标出来，
   *    否则人会以为档位忽然变了。
   */
  const legacy = raw.pronLevel !== undefined || raw.vocabLevel !== undefined || raw.scores === undefined
  const before = legacy
    ? '旧：发音 ' + label(normalizeLevel(raw.pronLevel ?? raw.difficulty)) +
      ' / 词汇 ' + label(normalizeLevel(raw.vocabLevel))
    : label(normalizeLevel(raw.difficulty)) + ' ' + scoreText(raw.scores as DifficultyScores | null)
  const after = label(meta.difficulty) + ' ' + scoreText(meta.scores)
  const noop =
    !legacy &&
    raw.difficulty === meta.difficulty &&
    JSON.stringify(raw.scores) === JSON.stringify(meta.scores) &&
    raw.challenge === meta.challenge &&
    raw.advice === meta.advice

  console.log('【' + f + '】 ' + before + ' → ' + after + (noop ? '  （无变化）' : ''))
  console.log('    ' + String(raw.text))
  console.log('    ' + meta.challenge)
  console.log('    ' + meta.advice)
  /**
   * ⚠️ 超长就喊一声：challenge 上不了分享卡标题、advice 没人读完，
   *    content-files.test.ts 也会红。模型对这两条都不稳定（实测同一条句子两次
   *    跑出的长度能差 10 字以上）⇒ 这里提示人改短（详情页这两行都能直接编辑）。
   */
  if (meta.challenge.length > CHALLENGE_MAX_CHARS) {
    console.log(
      '    ⚠️ challenge 太长（' + meta.challenge.length + ' 字 > ' + CHALLENGE_MAX_CHARS +
        '）—— 分享卡标题装不下，请改短',
    )
  }
  if (meta.advice.length > ADVICE_MAX_CHARS) {
    console.log('    ⚠️ advice 太长（' + meta.advice.length + ' 字 > ' + ADVICE_MAX_CHARS + '）—— 请在管理台改短')
  }
  console.log('')

  if (noop || !apply) continue

  /** ⚠️ 固定字段顺序（与 admin 的 writeContentFile 一致），并**保住将来新增的字段** */
  const next: Record<string, unknown> = {
    id: raw.id,
    text: raw.text,
    translation: String(raw.translation ?? ''),
    difficulty: meta.difficulty,
    scores: meta.scores,
    challenge: meta.challenge,
    advice: meta.advice,
    tags: meta.tags,
    // ⭐ 词表与连读标注也一起重算 —— 它们同样出自这次 LLM 调用（句中释义）
    //    ⚠️ 老正文的 words 是「音频切片表」那套结构，**不能原样带过去**
    words: meta.words,
    links: meta.links,
  }
  for (const k of Object.keys(raw)) {
    // ⚠️ 旧字段一个都不带过去：两条轴（pronLevel / vocabLevel）与改名前的 reason 都已废弃，
    //    difficulty / scores / challenge / advice 一律用新算出来的值
    if (k === 'pronLevel' || k === 'vocabLevel' || k === 'reason' || k === 'difficulty' || k === 'scores') continue
    if (!(k in next)) next[k] = raw[k]
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
