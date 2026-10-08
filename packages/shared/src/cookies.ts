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
  return Math.max(0, Math.ceil(passLine + 1 - score))
}

/**
 * ⭐⭐ **这一把的结果属于哪一种形态**（2026-10 定的四个结果弹窗：alert1–alert4）。
 *
 * ## 两把尺子，四种组合
 *
 * 攻克线是 `max(85, 个人最好)`（见 computeCookies）—— 于是"这一把怎么样"其实由
 * **两个布尔**决定，而不是分数本身：
 *
 *   · `conquered`  = 这一把攻下了（`earned > 0`）
 *   · `hadConquered` = **之前**就攻下过（个人最好 ≥ 85）
 *
 * | conquered | hadConquered | 形态 | 口径 |
 * |---|---|---|---|
 * | ✅ | ❌ | **a** | 第一次攻下 ⇒「攻克本句，+N 🍪」 |
 * | ✅ | ✅ | **d** | 又攻下一次 ⇒「再次攻克，+N 🍪」 |
 * | ❌ | ❌ | **b** | 还没攻下 ⇒「差X分，攻克本句」 |
 * | ❌ | ✅ | **c** | 已经攻下过 ⇒ 目标换成**刷新记录** ⇒「差X分刷新记录」 |
 *
 * ⚠️⚠️ **a/d 与 b/c 的差别不在分数高低，在"要不要继续追"**：
 *    一个已经攻克过的句子，"离 85 分还差多少"对他**没有意义**（他早就过了）——
 *    那时唯一还值得追的是**自己的记录**。这就是 c 存在的理由。
 *
 * ⚠️ 为什么是纯函数而不是写在 wxml 里：这四种形态的判据（尤其 c 那条
 *    "换成追记录"）是有前提条件的，写在模板里就变成没人测得到的散装逻辑。
 */
export type ResultForm = 'a' | 'b' | 'c' | 'd'

export interface ResultLine {
  form: ResultForm
  /** 底部那颗**状态胶囊**的文案（它同时是唯一的出口，所以必须说清"然后呢"） */
  text: string
}

export function resultFormOf(input: {
  score: number
  /**
   * ⭐ **这一把攻没攻克** —— 用服务端那个权威判断（`result.isConquered`）。
   *
   * ⚠️ 刻意**不**从 `earned > 0` 推：饼干那一段（`CookieAwardView`）在有些回包里是 null
   *    （没配奖励规则 / 老成绩），推的话会把"攻克了"显示成"没攻克" ——
   *    而那是**两个不同的字段**，各说各的，不该从一个推另一个。
   */
  conquered: boolean
  /** 这一把拿到的饼干（没攻克时是 0；拿不到奖励数据时也传 0） */
  earned: number
  /** 攻克线（服务端给的 passLine，= max(85, 个人最好)） */
  passLine: number
  /**
   * **这一把之前**的个人最好；null = 这条句子没读过（或查不到）。
   * ⚠️ 是"之前"不是"含这一把"—— 传进来之前服务端已经把它取成历史最好。
   */
  previousBest: number | null
}): ResultLine {
  const conquered = input.conquered
  const hadConquered = input.previousBest !== null && input.previousBest >= COOKIE_PASS_LINE

  if (conquered) {
    return {
      form: hadConquered ? 'd' : 'a',
      text: (hadConquered ? '再次攻克' : '攻克本句') + '，+' + input.earned + ' 🍪',
    }
  }

  /**
   * ⚠️ 两条"还差多少"用的是**不同的基准**：
   *    · 还没攻克过 ⇒ 基准是**攻克线**（差多少能攻下）
   *    · 已经攻克过 ⇒ 基准是**自己的记录**（差多少能刷新）
   *   混用会出现"差 3 分攻克本句"而用户早就在 90 分上 —— 一句话就把整套规则说穿了。
   */
  if (hadConquered) {
    // previousBest 在这一支里一定不是 null（hadConquered 已经保证了）
    const best = input.previousBest as number
    // ⚠️ 与 pointsToConquer 同一条规矩：**向上取整**，说少了就成了假承诺
    return { form: 'c', text: '差' + Math.max(1, Math.ceil(best + 1 - input.score)) + '分刷新记录' }
  }
  return { form: 'b', text: '差' + pointsToConquer(input.score, input.passLine) + '分，攻克本句' }
}
