import { AD_REWARD_ENERGY, type AdEnergyResponse } from '@jushuo/shared'

/**
 * ⭐ 「看激励视频补能量」的**纯逻辑** —— 文案与错误码映射（规格 prd §7.7）。
 *
 * ⚠️ 为什么这些要单独拎出来：页面里的 `Page({…})` 在这套测试环境里跑不起来
 *    （没有 `Page` 全局），所以凡是**能被判断对错**的东西都放在这里 ——
 *    尤其是错误码映射，它决定用户看到的是"没有广告"还是"小程序坏了"。
 *
 * ⚠️⚠️ 端侧**承诺**的点数只能来自 `AD_REWARD_ENERGY`：
 *    《小程序流量主行为规范》把「激励视频广告播放后未下发所承诺的奖励」列为二级违规
 *    ⇒ 承诺与实发必须同源，不许在这里另写一个 1。
 */

/** 发几点 —— 按钮上的承诺文案用它（见文件头：承诺与实发必须同源） */
export function adRewardPromiseText(): string {
  return '观看完整视频可得 ' + AD_REWARD_ENERGY + ' 点能量'
}

/**
 * 激励视频错误码 → 给用户的一句话。
 *
 * 口径（官方错误码表）：1004 = **无适合的广告**（最常见，不是故障）、
 * 1005/1006/1007/1008 = 广告位本身的审核 / 驳回 / 封禁 / 关闭、
 * 其余（1000 后端失败 / 1001 参数错 / 1002 单元无效 / 1003 内部错）= 通用失败。
 *
 * ⚠️ 一律说「稍后再试」而不是「失败」：这几种**都不是用户能修的问题**，
 *    说成失败只会让他反复点。
 * ⚠️ 1007（封禁）也不说重话：用户看不懂，而它确实是我们要去后台处理的事。
 */
export function adErrorText(errCode?: number): string {
  switch (errCode) {
    case 1004:
      return '暂时没有合适的广告，稍后再试'
    case 1005:
      return '广告正在审核中，稍后再试'
    case 1006:
    case 1007:
    case 1008:
      return '广告位暂时不可用，稍后再试'
    default:
      return '广告加载失败，稍后再试'
  }
}

/**
 * 发奖结果 → toast 文案。
 *
 * ⚠️ 三种结果分得很清楚（见 `AdEnergyResponse` 的说明）：
 *    · 真发了         → `+1 点能量`
 *    · **重放**       → `null`（**不弹**）：点数早在账上了，再说一次 "+1" 是假的
 *    · 太近 / 失败    → 各自一句话
 *
 * ⚠️ `ok === false` 走 toast 而不是静默：用户刚看完一条广告，
 *    让他毫无反馈地回到页面是最糟的处理（他只会以为功能坏了）。
 */
export function adRewardToast(res: AdEnergyResponse): string | null {
  if (res.ok && res.energyGained > 0) return '+' + res.energyGained + ' 点能量'
  if (res.ok) return null
  if (res.reason === 'too-soon') return '慢一点，稍后再试'
  return '暂时没拿到能量，稍后再试'
}

/**
 * 「看完了但没发到账」—— 兜底文案。
 *
 * ⚠️⚠️ 这句是为**官方红线**准备的：播放后不下发承诺的奖励是二级违规。
 *    所以这条路必须**既诚实又给出路**：告诉用户我们记着这笔、稍后会补，
 *    而不是让他以为自己白看了 —— 而这句话下面那三个函数**真的把它记下来并补发**，
 *    文案与机制必须成对存在（只写文案不写机制就是骗人）。
 */
export function adClaimFailedText(): string {
  return '看完广告了，但能量还没到账 —— 我们记下了，稍后会自动补给你'
}

/* ------------------------------------------------------------------ */
/* 待补发的请求 —— 「承诺了必须发」的执行机制                            */
/* ------------------------------------------------------------------ */

/** 存在本地的那串 requestId —— ⚠️ 用数组：极端情况下可能积压不止一笔 */
const PENDING_KEY = 'ad_energy_pending'

/**
 * 最多记几笔。
 * ⚠️ 有上限是**为了让坏数据不会永久占着存储**：真积压到 5 笔，
 *    说明网络或服务端出了大事，那时更该让人看见（而不是无限往本地塞）。
 */
const PENDING_MAX = 5

/**
 * 读出待补发的 requestId。
 *
 * ⚠️ **绝不抛**：这是本地存储，可能是老版本写的、可能被手工改坏
 *    （同一个键在开发者工具里是被测试账号共享的）。
 *    读坏了就当"没有待补"，绝不能让它把能量页整个拦下。
 */
export function readPendingClaims(): string[] {
  try {
    const raw: unknown = wx.getStorageSync(PENDING_KEY)
    if (!raw) return []
    const arr: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    if (!Array.isArray(arr)) return []
    return arr.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, PENDING_MAX)
  } catch {
    return []
  }
}

/** 记下一笔"看完了但没发到账"的 requestId（重复记不会变成两条） */
export function rememberPendingClaim(requestId: string): void {
  if (!requestId) return
  const next = readPendingClaims().filter((id) => id !== requestId)
  next.push(requestId)
  try {
    wx.setStorageSync(PENDING_KEY, next.slice(-PENDING_MAX))
  } catch {
    /* 存储满了 / 被禁用：记不下就算了 —— 发奖这条主路不该被它拖垮 */
  }
}

/** 补发成功后抹掉这一笔 */
export function forgetPendingClaim(requestId: string): void {
  try {
    wx.setStorageSync(
      PENDING_KEY,
      readPendingClaims().filter((id) => id !== requestId),
    )
  } catch {
    /* 同上：抹不掉最多下次再补一次，而补发是幂等的（同一个 requestId） */
  }
}
