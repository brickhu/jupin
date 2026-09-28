import { ApiError, fetchMe, getUserId, login } from './api/client'
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
 * 判据只有一条，和**导航栏那一格完全相同**（见 components/nav-bar）：
 *   **服务端应答过我吗** —— 即 GET /api/user/me 能不能返回。
 *
 * ⚠️⚠️ 与**昵称 / 头像毫无关系**（这一点我被绕进去过一次，写在这里免得再错）：
 *    · 导航栏那个「加入」按钮 = `hasJoined()` = `state.userInfo !== null`
 *      —— 意思是"服务端应答过我"，不是"我起过名字"；
 *    · "加入页"只是**补资料**的地方（昵称/头像），它**不是登录、也不是前置条件**；
 *    · 用户面板里那一格（`named ? 修改资料 : 加入页`）是**补资料的措辞分流**，
 *      跟"能不能提交"没关系，别把它当成本函数的模型。
 *
 * 真正会出事的是另一种情形：**本机从没拿到过身份**（uid = 0）——
 *    全新安装、或启动那次登录时服务端不可达。那时录音的上传路径
 *    （audio/{句子id}/{uid}/…）里没有合法的 uid，提交**必然**失败，
 *    而失败发生在用户等完上传之后。
 *
 * ⇒ 所以这里做的是：**要一次权威的 /me**
 *    · 拿到了 —— 服务端认识我，顺带得到**权威余额**（能量确认要用它）；
 *    · 拿不到 —— 先把「谁的问题」翻成人话，并**拦下这次提交**。
 *      ⚠️ 不跳加入页：加入页要 POST /api/user/profile 才存得下，而那个接口
 *        同样需要身份 —— 没账号时跳过去是个走不通的房间（导航栏碰到这种情况
 *        也是原地重确认，不跳页）。
 *
 * ⚠️ 顺手 `applyProfile`：/me 里那个 energy 是**惰性补足后**的权威值，写回 store
 *    之后导航栏/面板/朗读页底部那行小字当场就一致了，不必各自再拉一次。
 *
 * @returns 权威能量余额（能量确认要用它）
 * @throws Error  带一句**可以直接展示给用户**的人话（连不上 / 身份过期）
 */
export async function ensureSessionForSubmit(): Promise<number> {
  // ⚠️ 本机连身份都没有 —— 先补一次登录（不然后面那个请求连 header 都凑不出）
  if (getUserId() === 0) {
    try {
      await login()
    } catch (err) {
      // ⚠️ 这里**不抛底层那句机器话**（"request:fail" 之类）：此刻用户能做的
      //    只有一件事 —— 确认网络、再点一次。
      throw new Error('没连上服务器，暂时取不到你的身份。检查网络后再点一次。')
    }
  }

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
