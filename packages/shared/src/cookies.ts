import { WORD_GREEN_LINE } from './constants/index'
import type { ArticleLevel } from './types/content'

/**
 * ⭐ 饼干（🍪）—— 全站**唯一**的累计值。规格：prd §7.6。
 *
 * ⚠️⚠️ 整段必须是**纯函数**（与它取代的 `growth.ts` 同理）：
 *    结果会**落进 submissions 的快照**，而它依赖「提交那一刻的历史」
 *    （我在这句的历史最好分、当时的榜单分位）—— **事后无法重算**。
 *    写错一次就是永久的数据损坏，所以边界要逐个单测掉。
 *
 * ⭐ 它取代了原来的三个成长值（自我超越 / 坚持不懈 / 人中翘楚）：
 *    其中「坚持不懈」与连战是同一个数、「人中翘楚」与名次是同一个数，
 *    而「自我超越」相对自己的最好成绩 ⇒ **平台期永远返回 0**，本来就不能当累计值。
 */

/**
 * ⭐ **攻克线** —— 得分必须**严格大于**它才算攻克。
 *
 * ⚠️ 复用结果页的 `WORD_GREEN_LINE`（85），**不新增第二根线**：
 *    整句分数是词级分数的加权 ⇒「词都绿了，这句自然就攻克了」，
 *    用户**不需要学一个新数字**。改这里等于同时改"词读准了没有"那条线。
 */
export const COOKIE_PASS_LINE = WORD_GREEN_LINE

/**
 * ⭐ 难度基准，按 `ArticleLevel` 下标取： **初级 10 / 中级 20 / 高级 30 / 专家 40**。
 */
export const COOKIE_BASE: readonly number[] = [10, 20, 30, 40]

/**
 * ⭐ **样本不足这个数时一律按满额**（= 名次前 10%）。
 *
 * ⚠️⚠️ 这是**刻意**的，不是漏洞：它奖励"**去填补没人读过的句子**"。
 *    场上没人比你强，那按定义你就是前 10%。
 *    池子有限（现在 16 句）⇒ 最多薅 16 次，之后要有新句才有新机会 ——
 *    而"新句"正是产品想要的那件事。
 *
 * ⚠️ 注意它与 `STANDOUT_WEIGHT_BANDS`（已随成长值删除）**方向相反**：
 *    那个是"样本少就给低权重"（防刷），这个是"样本少就给满额"（奖早鸟）。
 *    两者的目的不同，别把参数照搬过来。
 */
export const COOKIE_RANK_MIN_SAMPLE = 10

/**
 * ⭐⭐ **多少饼干换 1 点能量** —— 40。
 *
 * ⚠️⚠️ 这个数不是随便定的，它让**一个专家句 = 1 点能量**：
 *    专家句基准 40 块 × 满分位 100% = 40 块 = 1 点能量。
 *    ⇒ 一句话就能讲给用户听：「攻克一个专家句，就能换 1 点能量」。
 *
 * ⚠️ 为什么不做成"更便宜"（比如 20）：那会让饼干能换到**读不完的能量**，
 *    直接侵蚀付费。而现在这套是自限的 —— 一次攻克最多换回**半次提交**，
 *    想靠饼干无限读，得先不停地攻克新句子，而新句子受内容更新速度限制
 *    （见 prd §7.6 的核算）。
 */
/** ⭐ 分数的最小步长（一位小数）—— 所有"还差多少分"的计算都以它为粒度 */
export const SCORE_STEP = 0.1

export const COOKIES_PER_ENERGY = 40

/**
 * ⭐ 这些饼干能换几点能量（向下取整）。
 * ⚠️ 余额不足 40 时是 0 —— 调用方据此把按钮置灰，而不是让用户点了才发现。
 */
export function energyFromCookies(cookies: number): number {
  if (!Number.isFinite(cookies) || cookies <= 0) return 0
  return Math.floor(cookies / COOKIES_PER_ENERGY)
}

/** 难度 → 基准；难度未知（老内容 / null）按初级兜底，不报错也不给 0 */
export function cookieBaseOf(level: ArticleLevel | null | undefined): number {
  if (level === null || level === undefined) return COOKIE_BASE[0] as number
  return COOKIE_BASE[level] ?? (COOKIE_BASE[0] as number)
}

/**
 * ⭐ **名次分位 → 系数**：前 10% ⇒ 100%，每退一档 −10%，最后 10% ⇒ 10%。
 *
 * @param percentile 名次分位，**0 = 最好、1 = 最差**（左闭右开，逐档递减）
 * @param sampleSize 榜单样本量（一人一条，不是提交次数）
 */
export function cookieRankFactor(percentile: number | null, sampleSize: number): number {
  // 样本不足 ⇒ 满额（早鸟优势，见 COOKIE_RANK_MIN_SAMPLE）
  if (sampleSize < COOKIE_RANK_MIN_SAMPLE) return 1

  /**
   * ⚠️ 样本够、但分位拿不到 ⇒ **也给满额**。
   *    方向是刻意的：宁可多发一块，也不要**凭空扣**一个人的奖励 ——
   *    「少发」是少赚一次，「冤枉人」是让他觉得这套东西在骗他。
   */
  if (percentile === null || !Number.isFinite(percentile)) return 1

  // ⚠️ 上界取 0.999… 而不是 1：percentile === 1（最后一名且只有一人分母）会算到第 10 档
  const p = Math.min(Math.max(percentile, 0), 0.999999)
  const band = Math.floor(p * 10) // 0..9
  // ⚠️ round 一下：1 - 3 * 0.1 在浮点下是 0.7000000000000001
  return Math.round((1 - band * 0.1) * 100) / 100
}

export interface CookieAwardInput {
  /** 本次得分 */
  score: number
  /** 我在这句上的历史最好分（**本次之前**）；null / 0 = 还没读过这句 */
  bestInSentence: number | null | undefined
  /** 这一句的难度档位 */
  difficulty: ArticleLevel | null | undefined
  /** 名次分位（0 = 最好）；拿不到给 null */
  percentile: number | null
  /** 榜单样本量 */
  sampleSize: number
}

export interface CookieAward {
  /** ⭐ 这一把赚到的饼干。**0 = 没攻克**（端侧据此决定显示 +N 还是"还差 X 分"） */
  earned: number
  /**
   * ⭐ **攻克线** = `max(85, 我在这句的历史最好分)`。
   * 端侧拿它和 `score` 就能算「还差多少」，不必自己知道 85 这个数。
   */
  passLine: number
  /** 难度基准（明细里要能解释"为什么是这个数"） */
  base: number
  /** 生效的名次系数（0.1–1.0） */
  rankFactor: number
}

/**
 * ⭐⭐ **一次结算能拿多少饼干**。
 *
 * ~~~
 * passLine  = max(85, 我在这句的历史最好)
 * 攻克      = score > passLine            ← 严格大于
 * rankFactor= 样本 < 10 ? 1 : 由分位决定
 * earned    = 攻克 ? round(base × rankFactor) : 0
 * ~~~
 *
 * ⚠️ **可以反复攻克**：每刷新一次个人最好、且仍在 85 以上，就再算一次。
 *    所以你**不能**把它理解成"一句只发一次"。它自限的方式是经济上的：
 *    想从一句上榨多次，你得**花能量提交**（一次 2 点），而从一句上最多赚回约一半
 *    ⇒ 刷是**净亏**的，只有"你本来就要练"才划算。
 *
 * ⚠️ **严格大于**：`score === passLine` 不算攻克 —— 否则"每次都恰好 85"的人
 *    可以无限重复拿。
 */
export function cookieAwardOf(input: CookieAwardInput): CookieAward {
  const base = cookieBaseOf(input.difficulty)
  const best = Number.isFinite(input.bestInSentence ?? NaN)
    ? Math.max(0, Number(input.bestInSentence))
    : 0
  const passLine = Math.max(COOKIE_PASS_LINE, best)
  const rankFactor = cookieRankFactor(input.percentile, input.sampleSize)

  const earned = input.score > passLine ? Math.round(base * rankFactor) : 0
  return { earned, passLine, base, rankFactor }
}

/**
 * ⭐ **距离攻克还差多少分** —— 给「没拿到时不显示 0，改显示还差多少」用（prd §7.6）。
 *
 * ⚠️⚠️ 它存在理由是一条产品口径：屏幕上**永远不出现「0 🍪」**。
 *    "0 🍪"是把"你什么都没得到"说出来；"还差 3 分"说的是同一件事，
 *    但它是**邀请**，不是判决（目标梯度效应）。
 *
 * ⚠️⚠️ **返回值一定是整数，而且是向上取整**（2026-10 修）。
 *
 *    讯飞的分数带**一位小数** ⇒ 不取整时屏幕上是「再高 51.2 分就能攻克」✗
 *    （用户报的正是这种半截数字）。而**必须向上**，不能四舍五入也不能截断：
 *    34.8 分距 85 线实际需要 51.2 分（`85 + 1 - 34.8`，目标是**安全跨过** 85），
 *    说 51 分就**做不到**（34.8 + 51 = 85.8，仍在线下 ✗）—— 那句邀请就成了假的。
 *
 * @returns 整数，>0 = 还差这么多分；0 = 已经攻克（或本来就过了线）
 */
export function pointsToConquer(score: number, passLine: number): number {
  /**
   * ⚠️⚠️ 是 **+0.1**，不是 +1（2026-10 按设计稿标定）。
   *
   * 判据是 `score > passLine`（computeCookies），而**分数带一位小数** ——
   * 所以"刚好跨过 85"的那一分是 **85.1**，不是 86。
   * 用 +1 会**多报一分**：34.8 分的实际缺口是 `85.1 - 34.8 = 50.3` ⇒ 51 分，
   *   而 34.8 + 51 = 85.8 > 85 ⇒ 确实攻下了 ✓
   *   原来写 +1 得 52，多算的那一分会让用户白练一轮 ✗
   */
  return Math.max(0, Math.ceil(passLine + SCORE_STEP - score))
}

/**
 * ⭐⭐ **这一把的结果属于哪一种形态** —— 底部那颗状态胶囊的文案（用户 2026-10 定的六条）。
 *
 * ## 六条口径（原话）
 *
 * | # | 条件 | 文案 |
 * |---|---|---|
 * | 1 | 首次 · 攻克 | 攻克本句，+N 🍪 |
 * | 2 | 首次 · 没攻克 | 还差N分攻克本句 |
 * | 3 | 非首次 · 超越前高且过线 | 超越前高，+N 🍪 |
 * | 4 | 非首次 · 超越前高但没过线 | 超越前高，还差N分攻克本句 |
 * | 6 | 非首次 · 没超前高但过线 | 还差N分突破前高 |
 * | 7 | 非首次 · 没超前高也没过线 | 差N分突破前高，继续加油 |
 *
 * （原话里就没有第 5 条 —— 不是漏抄，是那格不可能存在。）
 *
 * ## ⚠️ 判据为什么要用服务端那个 `conquered`
 *
 * 攻克线是 `max(85, 个人最好)` ⇒ **"攻没攻克"本身就已经同时回答了"过没过线"和"超没超前高"**：
 *
 *   · 非首次 · `conquered` ⇒ `score > 85` **且** `score > best` ⇒ 就是第 3 条 ✓
 *   · 非首次 · 没攻克 ⇒ 再用 `score > passLine` 一分：
 *       过线 ⇒ 那一定是**没超前高**（否则就攻克了）⇒ 第 6 条 ✓
 *       没过线 ⇒ 第 7 条（此时超没超前高都可能，文案都是"突破前高" ✓）
 *
 * ⇒ 不要自己再算一遍 `> max(best, 85)`：那是**第二份真相**，
 *    和发饼干那条规则（computeCookies）迟早会不一致。
 *
 * ⚠️ 首次那两条只看 `conquered`（没有前高可比）✓
 */
export type ResultForm =
  | 'first-pass'
  | 'first-short'
  | 'beat-record'
  | 'beat-record-short'
  | 'short-of-record-pass'
  | 'short-of-record-short'

export interface ResultLine {
  form: ResultForm
  /** 底部那颗**状态胶囊**的文案（它同时是唯一的出口，所以必须说清"然后呢"） */
  text: string
}

export function resultFormOf(input: {
  score: number
  /**
   * ⭐ **这一把攻没攻克** —— 用服务端那个权威判断（`result.isConquered`）。
   * ⚠️ 刻意不从饼干那段（`earned > 0`）推：它在有些回包里是 null ✗
   */
  conquered: boolean
  /** 这一把拿到的饼干（没攻克时是 0；拿不到奖励数据时也传 0） */
  earned: number
  /**
   * **这一把之前**的个人最好；null = 这条句子**第一次读**。
   * ⚠️ 是"之前"不是"含这一把"—— 服务端传进来的就是历史最好。
   */
  previousBest: number | null
}): ResultLine {
  const best = input.previousBest
  const first = best === null

  /**
   * ⚠️⚠️ "过没过线"的基准是**固定的 85**（COOKIE_PASS_LINE），**不是**服务端那个 passLine ✗
   *
   * 服务端的 `passLine = max(85, 个人最好)` —— 它是**发饼干**用的门槛。拿它判"过线"必错：
   *     前高 92、这次 91 ⇒ passLine 也是 92 ⇒ "91 > 92" 假
   *     ⇒ 会被误判成"没超前高也没过线"（第 7 条），而用户口径里它明明是第 6 条（高于 85）✗
   * ⇒ 这个函数**不收 passLine 参数**，就是为了让那个错写不出来。
   */
  const LINE = COOKIE_PASS_LINE

  if (first) {
    if (input.conquered) {
      return { form: 'first-pass', text: '攻克本句，+' + input.earned + ' 🍪' }
    }
    return { form: 'first-short', text: '还差' + pointsToConquer(input.score, LINE) + '分攻克本句' }
  }

  const record = best as number
  if (input.conquered) {
    return { form: 'beat-record', text: '超越前高，+' + input.earned + ' 🍪' }
  }

  /**
   * ⚠️ 没攻克时，"超越前高"与"过线"是**两个独立**的判断，要说清是哪一种：
   *    · 超前高但没过线 ⇒ 两件事一起说（第 4 条）
   *    · 过线但没超前高 ⇒ 目标只剩突破前高（第 6 条）
   *    · 都没 ⇒ 同样只能说"突破前高"（第 7 条，加一句鼓励）
   */
  const beatRecord = input.score > record
  /** ⚠️ 与上面 LINE 同一个基准：**固定的 85** */
  const passedLine = input.score > LINE
  /** 距**攻克线（85）**还差多少（跨过去要 0.1，分是一位小数） */
  const toLine = pointsToConquer(input.score, LINE)
  /** 距**自己的前高**还差多少（同一条规矩） */
  const toRecord = Math.max(1, Math.ceil(record + SCORE_STEP - input.score))

  if (beatRecord) {
    return { form: 'beat-record-short', text: '超越前高，还差' + toLine + '分攻克本句' }
  }
  if (passedLine) {
    return { form: 'short-of-record-pass', text: '还差' + toRecord + '分突破前高' }
  }
  return { form: 'short-of-record-short', text: '差' + toRecord + '分突破前高，继续加油' }
}
