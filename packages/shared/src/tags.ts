/** 标签的领域常量与规范化。 */

/** 一句最多带几个标签（防止一句写 50 个标签把卡片撑爆） */
export const MAX_ARTICLE_TAGS = 8

/** 单个标签最长几个字 —— 由内容校验用例守着（见 content-files.test.ts） */
export const MAX_ARTICLE_TAG_CHARS = 12

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
