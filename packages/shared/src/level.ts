/**
 * 句子档位（0–3）—— ⭐ **两条轴共用这一套刻度与标签**。
 *
 *   · **词汇难度** `vocabLevel`：小学 / 初中 / 高中 / 大学四级 / 六级 / 考研 / GRE 那套口径
 *     （含句式复杂度 —— 长句、从句也会拉高它）。
 *   · **发音难度** `pronLevel`：中文母语者读出来有多难念 —— 易错音（/θ/ /ð/ /v/、r–l）、
 *     词尾辅音丛、音素反复切换、必须连读才自然的地方。
 *
 * ⚠️⚠️ 两条轴**刻意分开，不许合成一个加权分**（2026-09 决定）。反例各占一边：
 *    · "The only thing we have to fear is fear itself, nameless, unreasoning, unjustified terror…"
 *      → 词汇**中级**、发音**专家**（unreasoning / unjustified / paralyzes 重音难猜、efforts 的 -rts）
 *    · "She sells seashells by the seashore…"
 *      → 词汇**初级**（全是小学词）、发音**专家**（/s/ 与 /ʃ/ 反复切换）
 *    任何单轴公式都必然牺牲其中一个 —— 分开记，两个反例都保住。
 *
 * ⚠️ 值是**档位数字 0–3**，不是字符串：
 *    · 它要落库（articles.vocab_level / articles.pron_level）并按档位排序 / 筛选 —— 数字才单调可比；
 *    · 中文只在 UI 上出现（LEVEL_LABEL），别写进数据里。
 */

import type { ArticleLevel } from './types/content'

/**
 * 四档的中文标签 —— 两条轴共用。
 * ⚠️ 要显示档位时一律从这里取，别另写一份映射。
 */
export const LEVEL_LABEL: Record<ArticleLevel, string> = {
  0: '初级',
  1: '中级',
  2: '高级',
  3: '专家',
}

/** 由易到难 —— 排序 / 筛选 UI 一律用它，别各写一份顺序 */
export const LEVEL_ORDER: ArticleLevel[] = [0, 1, 2, 3]

/**
 * 旧正文里的三档 ASCII（2026-09 之前）—— **只为兼容，不要再往数据里写**。
 *
 * ⚠️ 为什么留着：正文是静态资源（将来在 CDN / 对象存储上），
 *    可能比代码旧 —— 老 JSON 里就是 easy / medium / hard。
 *    这是**显式映射**，不是「补默认档位」；
 *    等所有环境的正文都重灌过一遍，这一段就可以删。
 * ⚠️ hard → 2（高级）而不是 3（专家）：专家是新开的档，不替老内容升格。
 */
const LEGACY_LEVEL: Record<string, ArticleLevel> = { easy: 0, medium: 1, hard: 2 }

/**
 * 把任意来源的值收成一个档位；认不出就是 null。**两条轴都用它**。
 *
 * ⚠️ 认不出时**返回 null，绝不默认成某一档**：
 *    编出来的档位比没有档位更糟 —— 用户会以为这一句真的被评过级。
 * ⚠️ 数字字符串（'"2"'）也认：JSON 被人手改过一轮之后很容易变成字符串。
 */
export function normalizeLevel(v: unknown): ArticleLevel | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 3 ? (v as ArticleLevel) : null
  }
  if (typeof v === 'string') {
    if (/^[0-3]$/.test(v)) return Number(v) as ArticleLevel
    const legacy = LEGACY_LEVEL[v]
    if (legacy !== undefined) return legacy
  }
  return null
}
