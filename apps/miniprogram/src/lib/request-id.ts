/**
 * ⭐ **客户端生成的幂等键** —— 给「一次用户动作」配一个 id。
 *
 * ⚠️⚠️ 为什么必须有它：服务端的两个账本（`cookie_ledger` / `energy_ledger`）
 *    用 `unique(reason, ref_type, ref_id, user_id)` 挡重，而 `ref_id` 就是这个值。
 *    重试要幂等、**连点也要幂等** —— 所以 id 必须与"这一次动作"绑定。
 *
 * ⚠️⚠️ 反面写法：在请求里直接传 `Date.now()`。
 *    那样连点两下会产生**两个不同的 id** ⇒ 服务端认不出来 ⇒ 白扣一次。
 *    正确的用法是：按一次按钮生成一个 id，把**同一个** id 用在这次动作的所有重试上。
 *
 * ⚠️ 不追求全局唯一（不是数据库主键）—— 只要"同一个人、同一个动作"不撞就行，
 *    所以时间戳 + 随机后缀足够。前缀让人在流水里一眼看出这是哪来的。
 */
export function newRequestId(prefix: string, now: number = Date.now(), rand: number = Math.random()): string {
  // ⚠️ 随机部分用 36 进制、截 8 位 —— 够用，且不会把流水那一列（64）撑爆
  const tail = Math.floor(rand * 0xffffffff)
    .toString(36)
    .padStart(7, '0')
    .slice(0, 7)
  return prefix + '-' + now.toString(36) + '-' + tail
}
