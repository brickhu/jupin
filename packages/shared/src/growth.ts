import {
  DILIGENCE_MILESTONES,
  DILIGENCE_YEAR,
  GROWTH_STEP_MAX,
  STANDOUT_EMPTY_BASELINE,
  STANDOUT_WEIGHT_BANDS,
} from './constants/index'

/**
 * ⭐ 成长体系（自我超越 / 坚持不懈 / 人中翘楚）—— **纯函数，零 IO**。
 *
 * 规格：docs/design/growth-and-energy.md。**本文与它必须一致**，
 * 改了那边就改这里，反之亦然。
 *
 * ⚠️⚠️ 为什么整段必须是纯函数：
 *    这三个数会**落进 submissions 的快照**（与 streakDelta 同一类东西，永久冻结），
 *    写错一次就是永久的数据损坏；而且它们依赖「提交那一刻的历史」，
 *    事后**无法重算**（榜单快照会随时间变）。纯函数才能把边界逐个单测掉。
 */

/**
 * ⭐ 规格里的 `f(x)` —— 三个指标共用：f(x) = clamp(round(x), 0, 10)。
 *
 * ⚠️ 非有限值（NaN / Infinity）一律给 0，不要让它漏进快照 ——
 *    NaN 存进 JSON 会变成 null，而回来的时候没人知道它是"算错了"还是"真的是 0"。
 */
export function growthStep(x: number): number {
  if (!Number.isFinite(x)) return 0
  const rounded = Math.round(x)
  if (rounded < 0) return 0
  return rounded > GROWTH_STEP_MAX ? GROWTH_STEP_MAX : rounded
}

/** 只有**正数**才算「有基准」——0 / 负数 / null 都表示"没有历史" */
function baselineOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/* ------------------------------------------------------------------ */
/* ① 自我超越                                                          */
/* ------------------------------------------------------------------ */

export interface SelfSurpassOutcome {
  /** 场内：跟「我在这句上的历史最高分」比 */
  n1: number
  /** 全局：跟「我的个人历史最高分」比 */
  n2: number
  /** 本次成长值（**只在最后四舍五入一次**） */
  total: number
}

/**
 * ⭐ 自我超越 = 两个维度各算一个分，最后取**平均**。
 *
 * ~~~
 * n1 = highestInSentence > 0 ? f(score − highestInSentence) : 0
 * n2 = highestInUser     > 0 ? f(score − highestInUser)     : 0
 * total = round((n1 + n2) / 2)
 * ~~~
 *
 * ⚠️ **没有 75 下限**（这条改过两次，最终定为「没有」）：
 *    基准就是历史最高分本身；**没有历史（= 0）时该维度直接不成立、给 0**。
 *    所以新人第一次读任何句子，两个维度都没有历史 ⇒ 自我超越 = 0。
 *
 * ⚠️⚠️ 为什么是**平均**而不是 max：
 *    因为「我在这句的最高分」永远 ≤「我的全局最高分」⇒ baseA ≤ baseB
 *    ⇒ **n1 >= n2 恒成立** ⇒ 取 max 的话 n2 永远取不到（那一维是空的）。
 *    取平均之后 n2 虽然也永远不会超过 n1，但它会**把分数往下拉** ——
 *    两边都破纪录才拿得满。这一维因此不是摆设。
 *
 * ⚠️ 两个基准都**只增不减** ⇒ 同一个分数只能被超越一次 ⇒ 天然不可刷，
 *    不需要任何反刷分规则。（曾经用过中位数做基准，那会出现
 *    「90/60 交替读、每两次白拿一次分」的路径，所以退回了最高分。）
 */
export function selfSurpassOf(input: {
  score: number
  /** 我在这句上的历史最高分（本次提交之前、status='scored'）；没有给 null */
  highestInSentence: number | null
  /** 我的个人全站历史最高分（同上）；没有给 null */
  highestInUser: number | null
}): SelfSurpassOutcome {
  const baseA = baselineOrNull(input.highestInSentence)
  const baseB = baselineOrNull(input.highestInUser)

  const n1 = baseA === null ? 0 : growthStep(input.score - baseA)
  const n2 = baseB === null ? 0 : growthStep(input.score - baseB)

  return { n1, n2, total: Math.round((n1 + n2) / 2) }
}

/* ------------------------------------------------------------------ */
/* ② 坚持不懈                                                          */
/* ------------------------------------------------------------------ */

export interface DiligenceOutcome {
  /** 本次拿到的成长值 */
  points: number
  /** 本次跨过的阈值（升序）—— 快照与结果页文案都用它 */
  crossed: number[]
}

/**
 * ⭐ 坚持不懈：**里程碑式，跨过即给一次**；中断后重新攒，档位从头开始。
 *
 * ~~~
 * 7 天 +1 ／ 30 天 +5 ／ 180 天 +40 ／ 第 k 个 360 天 + 100 × 2^(k−1)
 * ~~~
 *
 * ⚠️⚠️ 必须用 **before / after 两个 streakDays 判「跨过」**，
 *    不能写成「现在 streakDays > 7 就给」—— 那样每次读都会给一次。
 *    这样写才能做到「每个连续周期只触发一次」。
 *
 * ⚠️ 为什么 k 随中断重置：与 7/30/180 档保持同一条规则
 *    （「中断了但有 3 次 streak>7 → 1+1+1」）。推论：连续 800 天断了、
 *    再连续 800 天 = 346 + 346 = 692，仍低于一口气 1500 天的 746 ——
 *    中断有代价，但不会一笔抹掉。
 *
 * @param before 这次读**之前**的 streakDays
 * @param after  这次读**之后**的 streakDays（一次读最多 +1）
 */
export function diligenceOf(before: number, after: number): DiligenceOutcome {
  const crossed: number[] = []
  let points = 0

  // 固定档位：按阈值升序（不是按奖励大小）
  for (const m of DILIGENCE_MILESTONES) {
    if (before <= m.days && after > m.days) {
      crossed.push(m.days)
      points += m.points
    }
  }

  // 长期档：第 k 个 360 天。一次读最多 +1 天，所以最多跨过一个，写成循环是防御性的
  const years = Math.floor(after / DILIGENCE_YEAR.days)
  for (let k = 1; k <= years; k++) {
    const threshold = DILIGENCE_YEAR.days * k
    if (before <= threshold && after > threshold) {
      crossed.push(threshold)
      points += DILIGENCE_YEAR.basePoints * Math.pow(DILIGENCE_YEAR.factor, k - 1)
    }
  }

  return { points, crossed }
}

/* ------------------------------------------------------------------ */
/* ③ 人中翘楚                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ 中位数 —— 偶数个取中间两个的平均。
 * ⚠️ 不过滤会返回 null（调用方据此走兜底），**不返回 NaN**。
 * ⚠️ 先复制再排序：入参可能是调用方还在用的数组（原地排序会改到它）。
 */
export function medianOf(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = xs.length >> 1
  if (xs.length % 2 === 1) return xs[mid] as number
  return ((xs[mid - 1] as number) + (xs[mid] as number)) / 2
}

/** ⭐ 样本量 → 权重（左闭右开；0 和 1–9 是同一档） */
export function standoutWeight(sampleSize: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize < 0) {
    return (STANDOUT_WEIGHT_BANDS[0] as { weight: number }).weight
  }
  for (const band of STANDOUT_WEIGHT_BANDS) {
    if (sampleSize >= band.min && sampleSize < band.max) return band.weight
  }
  // 只有 sampleSize = Infinity 会走到这里
  return (STANDOUT_WEIGHT_BANDS[STANDOUT_WEIGHT_BANDS.length - 1] as { weight: number }).weight
}

export interface StandoutOutcome {
  /** 榜单样本量（**每人一条**，不是提交次数） */
  sampleSize: number
  /** 基准：榜单中位数；空样本时是 STANDOUT_EMPTY_BASELINE */
  baseline: number
  /** 样本量权重 */
  weight: number
  /** 本次成长值 */
  total: number
}

/**
 * ⭐ 人中翘楚 = 我这次的分 与 **榜单中位数** 的差距，按样本量加权。
 *
 * ~~~
 * m = median(snapshot) || 75
 * w = 由 snapshot.length 决定
 * total = round(f(score − m) × w)
 * ~~~
 *
 * ⚠️ **snapshot 取「榜单分数」**：每个参与者取历史最高分、**一人一条**。
 *    用户可能在同一句挑战 100 轮，但只有最高分那一次上榜。
 *    两个好处：与榜单同口径（用户能自己核对）；也不会被一个人反复读
 *    把 w 顶到 1.2、把中位数拉低（那等于替别人刷分）。
 *
 * ⚠️ 空样本（还没有别人）时权重是 **0.5 而不是 0**，基准是 **75** ——
 *    刻意鼓励用户做新竞技场里的第一个人。
 *
 * ⚠️ snapshot 必须**排除本次提交**（打分结算时本行的 score 已经写进去了），
 *    照抄 services/leaderboard.ts 里 getBestExcluding 的写法。
 */
export function standoutOf(score: number, snapshot: readonly number[]): StandoutOutcome {
  const xs = snapshot.filter((v) => Number.isFinite(v))
  const sampleSize = xs.length
  const weight = standoutWeight(sampleSize)
  const median = medianOf(xs)
  const baseline = median === null ? STANDOUT_EMPTY_BASELINE : median
  const total = Math.max(Math.round(growthStep(score - baseline) * weight), 0)

  return { sampleSize, baseline, weight, total }
}
