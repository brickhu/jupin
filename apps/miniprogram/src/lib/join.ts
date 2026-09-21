import { fetchMe } from './api/client'
import * as me from './store'

/** 「加入句拼」页（wx.navigateTo 用的带斜杠形式） */
export const JOIN_PAGE = '/pages/join/join'
/** 「修改资料」页 —— 已经加入过的人换头像/改昵称走这一页 */
export const PROFILE_PAGE = '/pages/profile/profile'
/** 页面栈里那一页的 route 写法（无斜杠）—— 用来判断"是不是已经在这一页了" */
const JOIN_ROUTE = 'pages/join/join'
const PROFILE_ROUTE = 'pages/profile/profile'
/** 兜底回首页 —— 与 lib/nav.ts 里那份保持一致 */
export const HOME_PAGE = '/pages/index/index'

/**
 * ⭐ 问一次服务端「我是谁（这个 openid 认领过名字没有）」，并把结果写回全局 state。
 *
 * 整条链是：
 *   ① wx.login 拿 openid —— **不在这一层**：它由 lib/api/client 在发请求时
 *      按需完成（401 自动重登 + 并发合并），云托管那条路更是网关注入的。
 *      这里只负责"拿着身份去问我是谁"。
 *   ② GET /api/user/me —— 服务端按 openid 取用户（没有就建一行），
 *      返回昵称 / 头像 / 已征服数 / streak。
 *   ③ 写回全局 state。
 *
 * @returns true = 服务端认识我（有昵称）；false = 还没认领；null = **没问到**
 *          ⚠️ 三者必须分开：把"没问到"当成"没加入"，就会在网络抖动时
 *             把老用户推去加入页，让他以为自己的账号没了。
 */
export async function refreshMe(): Promise<boolean | null> {
  try {
    const profile = await fetchMe()
    me.applyProfile(profile)
    return (profile.nickname ?? '').trim().length > 0
  } catch (err) {
    console.warn('[join] 取用户资料失败：' + (err as Error).message)
    return null
  }
}

/**
 * ⭐ 「加入句拼」这件事的**唯一入口** —— 所有需要"榜上有名"的地方都调它。
 *
 * ══════════════════════════════════════════════════════════════════
 * ① 本地就知道自己加入过 → 直接放行（**一次请求都不发**）。
 * ② 本地不知道 → 拿 openid 问一次服务端：
 *      · 认识我 → 写回 state，放行，**不跳加入页**
 *      · 不认识我 → 跳加入页（确认加入后返回，全局 state 已经是加入态）
 *      · 没问到 → 也放行（见下）
 *
 * ⚠️⚠️ 为什么"没问到"也放行：
 *    没有昵称**不影响提交**（服务端只认 openid，成绩照样入库），
 *    但把老用户推去加入页的代价是"他以为账号没了"。
 *    两害相权，宁可让他先读，也不要为了一个名字把人挡在门外。
 *    真没加入的人，等网络好了自然会看到导航栏那个「加入」按钮。
 * ══════════════════════════════════════════════════════════════════
 *
 * 「加入过了」的判据只有一条：**昵称非空**（见 store 的 hasJoined）——
 * 那正好就是服务端「这个 openid 认领过名字没有」的答案。
 *
 * @returns true = 现在可以继续；false = 已经跳去加入页，等他弄完回来
 */
export async function ensureJoined(): Promise<boolean> {
  if (me.hasJoined()) return true

  const joined = await refreshMe()
  // false 才是"确实还没认领"；true / null 都放行
  if (joined !== false) return true

  openJoinPage()
  return false
}

/**
 * 跳到「加入句拼」页。
 *
 * ⚠️ 这一页是 navigateTo 压上去的，所以「确认加入」能 navigateBack 回原页。
 * ⚠️ 已经在那一页上就不要再压一层（导航栏、用户面板、挑战入口都可能调它）——
 *    否则会叠出两三个一样的页面，返回要按好几次。
 */
export function openJoinPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === JOIN_ROUTE) return
  wx.navigateTo({ url: JOIN_PAGE, fail: () => wx.reLaunch({ url: JOIN_PAGE }) })
}

/**
 * 跳到「修改资料」页 —— 用户面板里那个「修改」。
 *
 * ⚠️⚠️ 它**不能**复用 openJoinPage：已经加入的人再去"加入"一次，
 *    看到的是「加入句拼 / 确认加入」—— 那一瞬间他会以为自己的账号没了。
 *    两个页面的表单是同一个组件，但**说法**必须不同（见 pages/profile/profile.wxml）。
 */
export function openProfilePage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === PROFILE_ROUTE) return
  wx.navigateTo({ url: PROFILE_PAGE, fail: () => wx.reLaunch({ url: PROFILE_PAGE }) })
}
