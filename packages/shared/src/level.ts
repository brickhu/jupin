/**
 * 句子难度 —— ⭐ **一个对外档位 + 三个内部判据**。
 *
 * 对外只有**一个**档位（`difficulty`，0 初级 / 1 中级 / 2 高级 / 3 专家）：
 * 用户看到的是一枚徽章 + 一句「难在哪」，不是三个数（2026-09 用户纠正）。
 *
 * 定级时**分三个判据**想，加权合成那一个档位（权重写在下面，公式也在这里，
 * 因为「算分」是规则、不该塞给模型做算术）：
 *
 *   | 判据 | 权重 | L1 → L5 |
 *   |------|------|---------|
 *   | ① 词汇及句式 | 5 | 小学 / 初高中 / 大学四级 / 六级·考研·雅思6.5 / GRE·托福·学术 |
 *   | ② 发音       | 4 | 全常见词 → 绕口令式（/s/ /ʃ/ /θ/ 反复切换） |
 *   | ③ 句子长度   | 1 | <10 / 10–20 / 20–30 / 30–40 / >40 词 |
 *
 *   score = (5×① + 4×② + 1×③) / 10
 *   score < 2 → 0 初级 │ [2,3) → 1 中级 │ [3,4) → 2 高级 │ [4,5] → 3 专家
 *
 * ⚠️⚠️ **三个分要记进正文 JSON（`scores`）**：不是为了给谁看，
 *    是为了让 difficulty **可以被代码验算** —— 档位对不上就说明有一次算错了，
 *    而「静默算错的档位」是这类功能最难发现的一种坏法（见 difficultyFromScores）。
 *
 * ⚠️ 为什么权重是 5/4/1 而不是平分：用户 2026-09 直接给的数。
 *    它的效果是「一个超纲词就能顶一档，而句子长一点几乎不改变结论」——
 *    这与朗读产品的直觉一致：卡住用户的是不认识的词和念不出的音，不是词数。
 *
 * ⚠️ 反例（两条判据各自把对方救回来，也是加权重而不是单指标的理由）：
 *    · "She sells seashells by the seashore…"
 *      → ① 初级（全是小学词）但 ② 专家（/s/ 与 /ʃ/ 反复切换）⇒ 不能被词简单骗成初级
 *    · "The only thing we have to fear … paralyzes needed efforts."
 *      → ① 中级（没有超纲词）而 ② 高（-zes / -rts 结尾、重音难猜）⇒ 不能判成专家
 *
 * ⚠️ ⭐ **为什么不用可读性公式**（Flesch / Flesch-Kincaid / Fog / SMOG / Coleman-Liau /
 *    ARI / Dale-Chall 都试过，结论是**不能用**）：
 *    它们是给**整篇文章**、**母语者阅读**设计的 —— 对 10–20 词的单句，
 *    音节数 / 句长的方差极小，算出来几乎全挤在中段，区分不出我们要的四档。
 *    而且「易读」量的是阅读，不是「中文母语者念出来有多难」。
 *    真正站得住的替代是 **词表分档**（Nation 的 word family + 95%/98% 覆盖率那套），
 *    ECDICT 的 tag（zk/gk/cet4/cet6/ky/toefl/ielts/gre）几乎 1:1 对上我们的 L1–L5
 *    —— 这就是 ① 的数据来源（作为 LLM 的 dict_lookup 工具，见 tools/pipeline 的 ecdict.ts）。
 *
 * ⚠️ 值是**档位数字 0–3**，不是字符串：
 *    · 它要落库（articles.difficulty）并按档位排序 / 筛选 —— 数字才单调可比；
 *    · 中文只在 UI 上出现（LEVEL_LABEL），别写进数据里。
 */

import type { ArticleLevel, DifficultyScores } from './types/content'

/**
 * 四档的中文标签。
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
 * ⭐ 三个判据的权重，顺序与 DifficultyScores 一致：**[词汇, 发音, 长度]**。
 * ⚠️ 改这里就等于改全部内容的档位 —— 改了必须整库重跑（pnpm content:regrade --apply）。
 * ⚠️ 名字与 scoring.ts 的 SCORE_WEIGHTS 必须分得开：那个是**用户朗读的评分权重**，
 *    这个是**内容难度的判据权重**，两者毫无关系（shared 是同一个导出面，撞名会编译不过）。
 */
export const DIFFICULTY_WEIGHTS: readonly [number, number, number] = [5, 4, 1]

/**
 * ⭐ 加权分 → 档位的切分点：`<2` 初级、`[2,3)` 中级、`[3,4)` 高级、`[4,5]` 专家。
 * ⚠️ 只写**下界**（2/3/4）：0 档没有下界，正好是「比第一个还小」。
 * ⚠️ 管理台的「改分数 → 实时看档位」也读它（服务端随 bootstrap 下发）——
 *    前端不许自己再写一份阈值，否则调了公式页面就开始说谎。
 */
export const DIFFICULTY_BANDS: readonly [number, number, number] = [2, 3, 4]

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
 * 把任意来源的值收成一个档位；认不出就是 null。
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

/**
 * 三个判据的评分（顺序 **词汇 / 发音 / 长度**）—— 各是 1–5 的整数；认不出 ⇒ null。
 *
 * ⚠️ 认不出就整组丢掉，**不许只补其中缺的那个** —— 一个补出来的分会让
 *    difficultyFromScores 算出一个「看着合理但没人给过」的档位。
 */
export function normalizeScores(v: unknown): DifficultyScores | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const out: number[] = []
  for (const item of v) {
    const n = typeof item === 'number' ? item : Number(item)
    if (!Number.isInteger(n) || n < 1 || n > 5) return null
    out.push(n)
  }
  return out as DifficultyScores
}

/**
 * ⭐ 三个判据分 → **一个**档位：score = (5a + 4b + c) / 10，再按档位切分。
 *
 * ⚠️ 这是**规则**：模型只负责给三个分，算术在这里做 —— 让 LLM 自己算加权和，
 *    它总有几个算错，而错了以后正文里存的档位就**和它自己给的分对不上**了。
 * ⚠️ 边界是**左闭右开**：[2,3) 中级、[3,4) 高级、[4,5] 专家 —— 恰好的整数向上归：
 *    2.0 → 中级、3.0 → 高级、4.0 → 专家（用户给的锚点就是这么落位的）。
 */
export function difficultyFromScores(v: unknown): ArticleLevel | null {
  const s = normalizeScores(v)
  if (!s) return null
  const score = weightedScoreOf(s)!
  let level = 0
  for (const band of DIFFICULTY_BANDS) if (score >= band) level++
  return level as ArticleLevel
}

/**
 * 三个判据分 → 加权总分（0.1–5.0）—— **只给管理台与日志看**，不进正文 JSON。
 * ⚠️ 与 difficultyFromScores 用同一个公式与权重，别在两处各写一遍。
 */
export function weightedScoreOf(v: unknown): number | null {
  const s = normalizeScores(v)
  if (!s) return null
  return (DIFFICULTY_WEIGHTS[0] * s[0] + DIFFICULTY_WEIGHTS[1] * s[1] + DIFFICULTY_WEIGHTS[2] * s[2]) / 10
}
