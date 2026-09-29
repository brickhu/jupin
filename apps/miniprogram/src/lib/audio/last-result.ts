/**
 * ⭐ 「上一次出了分、但用户还没点『重新挑战』」的那条结果 —— 本地一小条记录。
 *
 * ⚠️⚠️ 为什么需要它：出分后（s5）用户可能直接退出 / 切后台 / 去点别的。
 *    再进来时如果回到 s1，他会以为「我白读了，分也没了」。
 *    所以 s5 必须能**恢复** —— 判据就是这里记的 submissionId：
 *    再进来拿它问一次服务端状态，scored 就照旧停在 s5（用户 2026-09 的要求）。
 *
 * ⚠️⚠️ **两个时机都会写它**（2026-09 补齐，用户问的"提交后中途退出怎么办"）：
 *    ① **受理成功那一刻**（还在检测中）—— 再进来要能**接着等**；
 *    ② **出分那一刻** —— 再进来要能停在 s5 看分。
 *    不写 ① 的后果（真实事故形状）：用户"检测中"退出再进来，页面回到 s3 请他再确认一次，
 *    而一点 ✓ 就是**第二次提交**（新 attemptId、再扣一次能量、历史里多一条）——
 *    一次朗读被算成两次挑战。
 *
 * ⚠️ 但**判了失败的不记**（s6）：那段录音已经废了，恢复了也没意义。
 *    ⚠️ 与"没触达"的区别：没触达时服务端**把那一行删了** ⇒ 再进来查状态会 404，
 *      这里按"过期缓存"清掉即可（见 reading.ts 的恢复分支）。
 * ⚠️ 键是**句子 + 用户**（与录音缓存同一个 key）⇒ 一句话最多一条，
 *    不会随提交次数增长（这也是不学录音那样做「槽位上限」的原因）。
 * ⚠️ 「重录 / 重新挑战」必须清掉它（见 reading.ts 的 onRestart）：
 *    不清就会「点了等于没点」—— 下次进来又被恢复成 s5。
 */
export interface LastResult {
  submissionId: string
  articleId: string
  /** 出分时刻 —— 只用于排查；判断顺序/过期都不靠它 */
  at: number
}

const PREFIX = 'jushuo:lastResult:'

function storageKeyOf(key: string): string {
  return PREFIX + key
}

export function saveLastResult(key: string, r: LastResult): void {
  try {
    wx.setStorageSync(storageKeyOf(key), r)
  } catch (err) {
    // ⚠️ 存不下不该让出分这一屏失败：最多下次进来回到 s1（那是旧行为）
    console.warn('[last-result] 存失败：' + (err as Error).message)
  }
}

export function loadLastResult(key: string): LastResult | null {
  try {
    // ⚠️ getStorageSync 没有时返回空串（不是 null）—— 两种都要当「没有」
    const v = wx.getStorageSync(storageKeyOf(key)) as LastResult | '' | undefined
    if (!v || typeof v !== 'object' || !v.submissionId) return null
    return v
  } catch {
    return null
  }
}

export function clearLastResult(key: string): void {
  try {
    wx.removeStorageSync(storageKeyOf(key))
  } catch {
    // 清不掉不致命：最坏是下次进来还停在 s5
  }
}
