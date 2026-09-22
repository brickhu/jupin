/**
 * 句子难度 / 标签 —— 领域常量与规范化。
 *
 * ⚠️⚠️ 这里说的是**朗读难度**，不是阅读难度。两者刻意分开，依据在
 *    docs/research/content-production-research.md 第三节：
 *    「She sells seashells by the seashore」用的全是高考词汇（阅读难度最低），
 *    但 /s/ 与 /ʃ/ 在 8 个词里反复切换，是公认最难的绕口令（朗读难度最高）。
 *    ⇒ 难度**不能**靠词汇表算，判定发生在内容流水线（步骤 ③）。
 *
 * ⚠️ 值用 ASCII（easy / medium / hard），中文只出现在**运营 CLI 的输出**里：
 *    值要进 JSON、query 参数、以及将来的筛选条件，
 *    中文值迟早会在某一层被转义、或被比较错。
 */

import type { ArticleDifficulty } from './types/content'

/**
 * 三档的中文标签 —— **运营 CLI 的输出**用它。
 * ⚠️ UI 目前**不展示**难度（字段先预留），将来要显示时也从这里取，别另写一份映射。
 */
export const DIFFICULTY_LABEL: Record<ArticleDifficulty, string> = {
  easy: '初',
  medium: '中',
  hard: '高',
}

/** 由易到难 —— 排序 / 筛选 UI 一律用它，别各写一份顺序 */
export const DIFFICULTY_ORDER: ArticleDifficulty[] = ['easy', 'medium', 'hard']

/** 一句最多带几个标签（防止一句写 50 个标签把卡片撑爆） */
export const MAX_ARTICLE_TAGS = 8

/** 单个标签最长几个字 —— 由内容校验用例守着（见 content-files.test.ts） */
export const MAX_ARTICLE_TAG_CHARS = 12

/**
 * 把任意来源的值收成一个难度；认不出就是 null。
 *
 * ⚠️ 认不出时**返回 null，绝不默认成 medium**：
 *    编出来的难度比没有难度更糟 —— 用户会以为这一句真的被评过级。
 */
export function normalizeDifficulty(v: unknown): ArticleDifficulty | null {
  return typeof v === 'string' && DIFFICULTY_ORDER.includes(v as ArticleDifficulty)
    ? (v as ArticleDifficulty)
    : null
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
