/**
 * 展示用的格式化 —— 只做「给人看」的字符串，不参与任何判断。
 */

/**
 * ⭐ 音频时长 → `'00:05'` —— **固定 mm:ss、两段都两位**。
 *
 * ⚠️ 为什么不做「3 秒」「0:03」这种自然写法：
 *    同一屏里不止一处时长（卡片上的、结果页的），各写各的就会出现
 *    `0:03` 和 `3.0 秒` 并存 —— 用户会以为它们量的不是同一件事。
 *    固定宽度还有个副作用好处：播放 / 停止切换时数字不抖。
 *
 * ⚠️ 算不出来（null / 非有限 / ≤0 / 不足半秒）→ 返回**空串**，调用方据此
 *    **不渲染**时长，而不是显示 `00:00` —— 那会让人以为音频坏了
 *    （老提交记录里 duration 这一列是空的）。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  if (total <= 0) return ''
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
}
