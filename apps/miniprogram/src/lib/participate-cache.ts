/**
 * ⭐⭐ **一次"参与"的端侧缓存**（prd §7.2，用户 2026-10 定）。
 *
 * ## 为什么必须落盘，而不是只放内存
 *
 * 五态里有两态**只能从端侧恢复**：
 *
 * | 态 | 为什么在端侧 |
 * |---|---|
 * | `recoded`（有未提交的录音） | 那段录音还没提交，**服务端根本不知道它存在** |
 * | `checking` / `scored` | 判据是"**我这一把**的 submissionId" —— 服务端接口是按 id 寻址的，不给"我最近一把是哪个" |
 *
 * ⚠️⚠️ 而"出分那一刻用户可能**不在这个页面上**"（甚至关掉小程序）——
 *    那时 `scored` 必须还在（prd：**永不确认 ⇒ 永远停在 scored**）。
 *    所以 submissionId 与录音一样，**必须跟着句子存在本地**。
 *
 * ⚠️ 一个句子一份（键里带 articleId）：同一句可以反复挑战，
 *    而"我在这句上还没结清的那一把"永远只有一把。
 */
const KEY_PREFIX = 'jushuo.participate.v1.'

export interface ParticipateCache {
  /** 未提交的录音（本地临时文件路径）—— `recoded` 态靠它 */
  audioPath: string
  /** 那段录音的时长 */
  durationMs: number
  /**
   * ⭐ 这一把的**幂等键**（32 hex）。
   * ⚠️ 重试必须复用同一个值（见 lib/api/upload.ts 的 newAttemptId）：
   *    它同时是存储路径的一段与服务端的幂等键，换了就等于"又提交了一次"。
   */
  attemptId: string
  /** 已经提交出去的那一把（`checking` / `scored` 靠它去轮询） */
  submissionId: string
  /** 服务端说的"这一把确认了吗" —— ⚠️ 缓存一份只为**离线时**别把界面画错，**不作判据** */
  confirmed: boolean
}

function keyOf(articleId: string): string {
  return KEY_PREFIX + articleId
}

/**
 * 读出来。
 * ⚠️ **绝不对着坏数据猜**：解析失败当作"没有缓存"（返回 null），
 *    而不是回一个半截对象 —— 那会让界面出现"有录音但没有路径"这种自相矛盾的状态。
 */
export function loadParticipate(articleId: string): ParticipateCache | null {
  try {
    const raw = wx.getStorageSync(keyOf(articleId)) as Partial<ParticipateCache> | string | undefined
    if (!raw) return null
    const v = typeof raw === 'string' ? (JSON.parse(raw) as Partial<ParticipateCache>) : raw
    if (typeof v.audioPath !== 'string' || v.audioPath === '') return null
    return {
      audioPath: v.audioPath,
      durationMs: typeof v.durationMs === 'number' ? v.durationMs : 0,
      attemptId: typeof v.attemptId === 'string' ? v.attemptId : '',
      submissionId: typeof v.submissionId === 'string' ? v.submissionId : '',
      confirmed: v.confirmed === true,
    }
  } catch {
    return null
  }
}

export function saveParticipate(articleId: string, v: ParticipateCache): void {
  try {
    wx.setStorageSync(keyOf(articleId), v)
  } catch {
    /** ⚠️ 存不下也不抛：缓存只是"下次进来还能捡回来"，不是这一步能不能成功的前提 */
  }
}

/**
 * 清掉这一句的缓存。
 *
 * ⚠️⚠️ **只在"确认"之后调**（prd §7.2：确认才是唯一真正的结算）——
 *    提前清掉的话，用户下次进来会以为那一把从没发生过，
 *    而服务端那边它其实还在（未确认 ⇒ 永不清理）。
 */
export function clearParticipate(articleId: string): void {
  try {
    wx.removeStorageSync(keyOf(articleId))
  } catch {
    /* 同上：清不掉不影响功能 */
  }
}
