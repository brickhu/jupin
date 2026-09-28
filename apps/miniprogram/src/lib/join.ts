import { ApiError, fetchMe } from './api/client'
import { ensureIdentity } from './session'
import * as me from './store'

/** 「加入句拼」页（wx.navigateTo 用的带斜杠形式） */
export const JOIN_PAGE = '/pages/join/join'
/** 「修改资料」页 —— 已经加入过的人改资料走这一页（昵称/头像/性别/年龄/简介） */
export const PROFILE_PAGE = '/pages/me/edit-user/edit-user'
/** 页面栈里那一页的 route 写法（无斜杠）—— 用来判断"是不是已经在这一页了" */
const JOIN_ROUTE = 'pages/join/join'
const PROFILE_ROUTE = 'pages/me/edit-user/edit-user'
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
  } finally {
    /**
     * ⭐ 无论成功失败，这次「我是谁」的解析都结束了 —— 通知 store。
     *    ⚠️ 失败也要调：否则后端连不上时导航栏会永远停在 spinner，
     *       而正确表现是「加入 / 点我重试」。
     */
    me.markSessionReady()
  }
}

/**
 * ⭐⭐ 「提交评测之前三份检查」里的**身份那一份**（用户 2026-09 定）。
 *
 * 判据/重登都走 `lib/session.ts`（只有一处实现：**服务端应答过我吗**）——
 * 见那个文件头的说明，尤其**它与昵称 / 头像无关**这一点。
 *
 * 这里多做的一件事是**顺手拿权威余额**：`GET /api/user/me` 会先把当天该补的能量
 * 补上（惰性 + 幂等，见 services/energy.ts），所以提交前那一次确认用的是它。
 *
 * ⚠️ 不跳加入页：加入页只是**补昵称头像**的地方，而"连身份都没有"这件事它同样解决不了 ——
 *    唯一解法是重登一次（`ensureIdentity()` 就是干这个的）。所以这里失败时抛一句人话，
 *    调用方把它显示出来让用户"检查网络、再点一次"。
 *
 * ⚠️ 顺手 `applyProfile`：/me 那个 energy 是权威值，写回 store 之后导航栏 / 面板 /
 *    朗读页底部那行小字当场就一致了，不必各自再拉一次。
 *
 * @returns 权威能量余额（提交前的能量确认要用它）
 * @throws Error  带一句**可以直接展示给用户**的人话
 */
export async function ensureSessionForSubmit(): Promise<number> {
  // ⚠️ 第一次调用可能只是"要个身份"（uid=0 → 静默登录一次）
  await ensureIdentity()

  try {
    const profile = await fetchMe()
    me.applyProfile(profile)
    return profile.energy
  } catch (err) {
    const e = err as ApiError
    if (e.code === 'AUTH_EXPIRED' || e.code === 'UNAUTHORIZED') {
      // ⚠️ 不在这里自动重登：request() 见到 401 会**自己**静默重登一次并重发，
      //    所以让用户再点一次就够（重登逻辑只该有一处，见 client.ts 的 request）。
      throw new Error('身份过期了，再点一次就能继续。')
    }
    throw new Error(e.message || '连不上服务器，暂时确认不了能量余额')
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
 *    两个页面的表单是同一个组件，但**说法**必须不同（见 pages/me/edit-user/edit-user.wxml）。
 */
export function openProfilePage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === PROFILE_ROUTE) return
  wx.navigateTo({ url: PROFILE_PAGE, fail: () => wx.reLaunch({ url: PROFILE_PAGE }) })
}
