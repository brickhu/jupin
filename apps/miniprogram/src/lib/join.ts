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
 * ⭐ 问一次服务端「我是谁」，并把结果写回全局 state。
 *
 * ⚠️⚠️ 这一步**同时就是注册**，别只把它当成「顺手取个头像」：
 *    服务端在 /api/user/me 上按 openid 取用户，**没有就当场建一行**
 *    （见 middleware/auth.ts —— 那是全站唯一的注册点）。
 *    所以只要它**能返回**，就说明 users 里已经有我这一行了。
 *
 * 整条链是：
 *   ① 授权层：wx.login 拿 openid —— **不在这一层**。它由 lib/api/client
 *      在发请求时按需完成（401 自动重登 + 并发合并），云托管那条路更是
 *      微信网关注入的；对用户完全不可见，也不等于他进了我们的库。
 *   ② 账号层：GET /api/user/me —— 服务端按 openid 取用户（没有就建一行）。
 *      ⭐ 业务数据的前置条件就是这一层（判据见 store 的 hasJoined）。
 *   ③ 资料层：昵称 / 头像 / 已征服数 —— 顺便带回来，写回全局 state。
 *
 * @returns true  = 服务端认识我，而且我起了名字
 *          false = 服务端认识我，但我还没认领名字
 *          null  = **没问到**（没进到服务端，注册状态未知）
 *          ⚠️ 三者必须分开：把「没问到」当成「没加入」，就会在网络抖动时
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
 * 跳到「加入句拼」页 —— **补头像和昵称**的地方。
 *
 * ⚠️ 它**不是登录**，也不是任何功能的前置条件：账号（openid）是静默拿到的，
 *    成绩照样入库。这一页补的只是「榜上显示成什么」，**略过完全不影响使用**。
 * ⚠️ 已经起过名字的人不该看到这一页（见 openProfilePage）。
 * ⚠️ 这一页是 navigateTo 压上去的，所以保存完能 navigateBack 回原页。
 * ⚠️ 已经在那一页上就不要再压一层 —— 否则会叠出两三个一样的页面，返回要按好几次。
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
