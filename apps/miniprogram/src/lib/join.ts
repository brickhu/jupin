import { fetchMe } from './api/client'
import { HOME_URL, JOIN_URL, ROUTES, goOnce, goPublic } from './route'
import * as me from './store'

/** 「加入句拼」页（带斜杠）—— 常量住在 lib/route 的 ROUTES 表里 */
export const JOIN_PAGE = JOIN_URL
/** 「修改资料」页 —— 已经加入过的人改资料走这一页（昵称/头像/性别/年龄/简介） */
export const PROFILE_PAGE = ROUTES.profileEdit.url
/** 兜底回首页 */
export const HOME_PAGE = HOME_URL

/**
 * ⭐ 身份检查的**唯一实现**现在住在 `lib/auth.ts`，跳页的唯一入口住在 `lib/route.ts`。
 *    这里保留 `refreshMe`（启动时问一次"我是谁"）并把两个入口转出去 ——
 *    老调用点（user-sheet / join 页 / profile-form）不用改 import 路径，
 *    但**实现只有一份**（用户 2026-09 定的：不许再叠重复的函数）。
 */
export { isAuthed, ensureAuthed, requireIdentity } from './auth'
export { go, replace, goPublic, goOnce, back, JOIN_URL, HOME_URL } from './route'

/**
 * ⭐ 跳到「加入句拼」页 —— **补头像和昵称**的地方。
 *
 * ⚠️ 它**不是登录**，也不是任何功能的前置条件：账号（openid）是静默拿到的，
 *    成绩照样入库。这一页补的只是「榜上显示成什么」，**略过完全不影响使用**。
 * ⚠️ 它是**公开页**：auth 拦下之后统一落到这里，所以这里绝不能走带守卫的 go()。
 */
export function openJoinPage(): void {
  // ⚠️ once=true：已经是那一页就不再压一层
  goPublic(JOIN_URL, true)
}

/**
 * ⭐ 跳到「修改资料」页 —— 用户面板里那个「修改」。
 *
 * ⚠️⚠️ 它**不能**复用 openJoinPage：已经加入的人再去"加入"一次，
 *    看到的是「加入句拼 / 确认加入」—— 那一瞬间他会以为自己的账号没了。
 *    两个页面的表单是同一个组件，但**说法**必须不同（见 pages/me/edit-user/edit-user.wxml）。
 */
export function openProfilePage(): void {
  void goOnce(PROFILE_PAGE, ROUTES.profileEdit.route)
}

/**
 * ⭐ 问一次服务端「我是谁」，并把结果写回全局 state。
 *
 * ⚠️⚠️ 这一步**同时就是注册**，别只把它当成「顺手取个头像」：
 *    服务端在 /api/user/me 上按 openid 取用户，**没有就当场建一行**
 *    （见 middleware/auth.ts —— 那是全站唯一的注册点）。
 *    所以只要它**能返回**，就说明 users 里已经有我这一行了。
 *
 * ⚠️ 它和 `ensureAuthed()` 的分工：这个是**启动时预热**（不阻塞任何导航，
 *    失败只警告），那个是**动手前的门禁**（失败就把人送去加入页）。
 *    两者都调 `/me`，但语义不同，所以没有合并成一件事。
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
     *       而正确表现是「加入 / 点我重试」（见 nav-bar）。
     */
    me.markSessionReady()
  }
}
