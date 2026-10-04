import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ **「我的战绩」必须只查我的行** —— 这条纪律由机器守（2026-09 定的）。
 *
 * 出事的样子（真实发生过一次，见 routes/favorites.ts 里那段注释）：
 *   参与记录是「一人一句一行」。某个接口只按 `articleId` 查，再把结果装进
 *   `new Map([[articleId, row]])` —— 同句所有用户的行互相覆盖，最后 `map.get(id)`
 *   拿到的是**别人**的最高分与次数，而界面上它是「已读 N 次 · 最高 X」。
 *   **功能不会报错、类型不会报错、测试也不会红** —— 它只是把别人的数据当成你的。
 *
 * ⇒ 判据：凡是从 `participations` 取数的地方，要么在 where 里出现 `participations.userId`，
 *   要么走"我"的辅助函数（它内部已经按 userId 限过），要么进白名单**并写明理由**
 *   （全场榜 / 参与人数 / 从全站算名次 —— 那些本来就要看所有人的行）。
 *
 * ⚠️ 白名单是"绕过检查的开关"，所以每条都必须给出为什么**不会**被当成"我的"。
 * ⚠️ 这是**静态**检查（读源码文本），不连库：它守的是"写法"，不是某一次查询结果。
 */

const SRV = new URL('../', import.meta.url).pathname

/** 已经按 userId 限过、但不写成 `participations.userId` 的辅助函数 */
const SCOPED_HELPERS = ['highestInSentence(userId', 'highestInUser(userId']

/**
 * 故意查全场的地方 —— 键是 `文件:行号所在文件` + 出现序，值是**理由**。
 * ⚠️ 新增条目必须能回答："它为什么不会被当成我的成绩？"
 * ⚠️ 行号会漂，所以用「文件名 + 该文件里第 n 处」定位。
 */
const ARENA_WIDE_ALLOWED: Array<{ file: string; nth: number; why: string }> = [
  { file: 'services/leaderboard.ts', nth: 1, why: 'getRank：数"比我强的人"来算我的名次，本来就要看所有人的行（其中一例在 where 里已带 userId 的辅助函数）' },
  { file: 'services/leaderboard.ts', nth: 2, why: 'participantCount：参与人数=行数，按定义要数所有人' },
  { file: 'services/leaderboard.ts', nth: 3, why: 'getTopLeaderboard：全场榜，按定义要所有人的行' },
  { file: 'services/leaderboard.ts', nth: 4, why: 'aboveOfMe/belowOfMe：榜心上下文，where 里走 aheadOfMe/behindMe（都基于我的 userId）' },
  { file: 'services/leaderboard.ts', nth: 5, why: 'arenaSnapshot：这一句的全场最高/人数，用于成长值判定' },
  { file: 'services/leaderboard.ts', nth: 6, why: '同上，另一处换算（名次→击败比例）' },
  { file: 'services/leaderboard.ts', nth: 7, why: 'getArenaStatsBatch 的 mine 分支：where 里已带 inIds + userId' },
  {
    file: 'services/participations.ts',
    nth: 1,
    why: 'rebuildParticipations：把派生索引从 submissions 重建，必须读全表的行再按 userId:articleId 归位 —— ' +
      '它没有任何"我的"语义，也不对外返回单个用户的画像',
  },
  {
    file: 'services/participations.ts',
    nth: 2,
    why:
      'participationRecordById：按**地址**取一行（公开的参与详情 `GET /api/participation/{id}`）。' +
      '⚠️ 它刻意只按 id 查 —— 那个地址本身就是 (user_id, article_id) 的派生值（见 db/schema.ts 与迁移 0057），' +
      '所以"查哪一行"已经由调用方明确指定；它**不会**把别人的行当成"我的"：' +
      '返回的就是指定那一条，而且调用方是公开接口、本来就要看别人的记录（与 /api/profile/{id} 同类）。',
  },
  {
    file: 'services/article-delete.ts',
    nth: 1,
    why:
      '删句子时清掉**这一句所有人**的参与记录（外键要求）。' +
      '它按 articleId 而不是 userId 过滤，但**不读、不返回**任何用户数据 ——' +
      '是「删除这一句的引用」，不是「看谁的记录」。',
  },
  {
    file: 'services/article-participations.ts',
    nth: 2,
    why:
      'participantCount：这一句的**总人数**（响应里的 total），按定义要数所有人的行；' +
      '它只返回计数，不返回任何人的成绩或画像。',
  },
  {
    file: 'services/article-participations.ts',
    nth: 3,
    why:
      'listArticleStats：公开的**聚合统计**（人数 / 最高 / 最低），按定义要看所有人的行；' +
      '出去的是三个聚合值，不含任何单个用户的成绩。',
  },
]

function files(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
    }
  }
  for (const sub of ['routes', 'services']) walk(path.join(SRV, sub))
  return out
}

/** 取 `from(participations)` 之后的 where 片段（够长就能覆盖链式写法） */
function snippets(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  const re = /\.from\(participations\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length
    out.push({ line, text: src.slice(m.index, m.index + 700) })
  }
  return out
}

describe('参与记录的作用域 —— 查 participations 时必须限到"我"', () => {
  const all = files().map((f) => ({ file: path.relative(SRV, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8') }))

  it('每个 from(participations) 要么带 participations.userId，要么在带理由的白名单里', () => {
    const offenders: string[] = []
    for (const { file, src } of all) {
      snippets(src).forEach((s, i) => {
        const scoped =
          s.text.includes('participations.userId') ||
          SCOPED_HELPERS.some((h) => s.text.includes(h))
        if (scoped) return
        const allowed = ARENA_WIDE_ALLOWED.find((a) => a.file === file && a.nth === i + 1)
        if (allowed) {
          // ⚠️ 白名单条目必须带理由，空理由 = 绕过检查
          expect(allowed.why.length, `${file} 第 ${i + 1} 处的白名单缺理由`).toBeGreaterThan(10)
          return
        }
        offenders.push(`${file}:${s.line}（第 ${i + 1} 处）`)
      })
    }
    expect(
      offenders,
      '这些地方从 participations 取数却没限到"我" —— 会把别人的成绩当我的显示：\n' + offenders.join('\n'),
    ).toEqual([])
  })

  it('白名单条目必须仍然存在（写法变了就删条目，别让白名单烂在那里）', () => {
    const counts = new Map(all.map((f) => [f.file, snippets(f.src).length]))
    const stale = ARENA_WIDE_ALLOWED.filter((a) => (counts.get(a.file) ?? 0) < a.nth)
    expect(stale.map((s) => `${s.file} 第 ${s.nth} 处`), '白名单指向的查询已经不存在了').toEqual([])
  })
})
