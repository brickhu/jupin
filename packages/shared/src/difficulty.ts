/**
 * 句子难度 / 标签 —— 领域常量与规范化。
 *
 * ⚠️⚠️ 这里说的是**朗读难度**，不是阅读难度。两者刻意分开，依据在
 *    docs/research/content-production-research.md 第三节：
 *    「She sells seashells by the seashore」用的全是高考词汇（阅读难度最低），
 *    但 /s/ 与 /ʃ/ 在 8 个词里反复切换，是公认最难的绕口令（朗读难度最高）。
 *    ⇒ 难度**不能**靠词汇表算，判定发生在内容流水线（步骤 ③）。
 *
 * ⚠️ 值是**档位数字 0–3**，不是字符串：
 *    · 它要落库（articles.difficulty）并按档位排序 / 筛选 —— 数字才单调可比；
 *    · 中文只在 UI 与运营 CLI 上出现（DIFFICULTY_LABEL），别写进数据里。
 */

import type { ArticleDifficulty } from './types/content'

/**
 * 四档的中文标签 —— **运营 CLI 与将来的筛选 UI**用它。
 * ⚠️ UI 目前**不展示**难度（字段先预留），将来要显示时也从这里取，别另写一份映射。
 */
export const DIFFICULTY_LABEL: Record<ArticleDifficulty, string> = {
  0: '初级',
  1: '中级',
  2: '高级',
  3: '专家',
}

/** 由易到难 —— 排序 / 筛选 UI 一律用它，别各写一份顺序 */
export const DIFFICULTY_ORDER: ArticleDifficulty[] = [0, 1, 2, 3]

/**
 * 旧正文里的三档 ASCII（2026-09 之前）—— **只为兼容，不要再往数据里写**。
 *
 * ⚠️ 为什么留着：正文是静态资源（将来在 CDN / 对象存储上），
 *    可能比代码旧 —— 老 JSON 里就是 easy / medium / hard。
 *    这是**显式映射**，不是「补默认档位」；
 *    等所有环境的正文都重灌过一遍，这一段就可以删。
 * ⚠️ hard → 2（高级）而不是 3（专家）：专家是新开的档，不替老内容升格。
 */
const LEGACY_DIFFICULTY: Record<string, ArticleDifficulty> = { easy: 0, medium: 1, hard: 2 }

/** 一句最多带几个标签（防止一句写 50 个标签把卡片撑爆） */
export const MAX_ARTICLE_TAGS = 8

/** 单个标签最长几个字 —— 由内容校验用例守着（见 content-files.test.ts） */
export const MAX_ARTICLE_TAG_CHARS = 12

/**
 * 把任意来源的值收成一个难度；认不出就是 null。
 *
 * ⚠️ 认不出时**返回 null，绝不默认成某一档**：
 *    编出来的难度比没有难度更糟 —— 用户会以为这一句真的被评过级。
 * ⚠️ 数字字符串（'"2"'）也认：JSON 被人手改过一轮之后很容易变成字符串。
 */
export function normalizeDifficulty(v: unknown): ArticleDifficulty | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 3 ? (v as ArticleDifficulty) : null
  }
  if (typeof v === 'string') {
    if (/^[0-3]$/.test(v)) return Number(v) as ArticleDifficulty
    const legacy = LEGACY_DIFFICULTY[v]
    if (legacy !== undefined) return legacy
  }
  return null
}

/**
 * 标签规范化：丢掉非字符串与空串、按原顺序去重、超过 MAX_ARTICLE_TAGS 截断。
 *
 * ⚠️ **保留原顺序**：作者写的第一个标签是最重要的那个，排序 UI 不该把它挪走。
 * ⚠️ 只 trim，不改写内容 —— 标签是人写的，程序别替它措辞。
 */
export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_ARTICLE_TAGS) break
  }
  return out
}
