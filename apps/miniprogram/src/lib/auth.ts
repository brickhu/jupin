import { ApiError, fetchMe, login } from './api/client'
import { JOIN_URL, goPublic } from './route'
import * as me from './store'

/**
 * ⭐⭐⭐ **全站唯一的 auth** —— 判断的是「**这个人在 `users` 里有没有记录**」。
 *
 * 用户 2026-09 定的口径（三条，别再加概念）：
 *   ① 启动静默登录（`wx.login` / 云托管网关注入）。它只解决"我是谁"，
 *      **不代表我在我们库里有记录** —— 那是另一回事。
 *   ② 需要"库里必须有我这一行"才能用的功能，动之前过 `ensureAuthed()`：
 *      有记录 → 放行；**没记录 → 跳加入页**；问不到 → 不跳，提示重试。
 *   ③ header 那一格：checking → spinner；没记录 → 「加入」；有记录 → 头像。
 *
 * ⚠️⚠️ **判据必须是"服务端那一行"，不是 `wx.login` 的结果，也不是本机缓存**：
 *    `wx.login` 成功只说明拿到了 openid；本机 `userInfo` 只是上一次问到的快照。
 *    真正权威的那一问是 `GET /api/user/me` —— 服务端在 `authMiddleware` 里按 openid
 *    取用户（**没有就当场建一行**：middleware/auth.ts + services/user.ts 的
 *    `getOrCreateUserByOpenid` 是全站唯一注册点），然后才回数据。
 *
 * ⚠️⚠️ 于是「问不到」和「没记录」**必须分开**（这是本项目踩过的坑）：
 *    · /me 成功            → **有记录**（放行）；
 *    · /me 回 401「未登录」 → 服务端明确说"认不出你" ⇒ 才跳加入页；
 *    · /me 超时 / 5xx / 没网 → **什么都不知道** ⇒ **绝不跳加入页**
 *      （跳了等于把老用户推去加入页，他会以为账号没了；而且加入页保存也要连服务端）。
 *
 * ⚠️ 还有一条连带后果：**"问不到"时不能把 session 标记成 ready**，而是标成 'unknown' ——
 *    否则 header 会画出一个假的「加入」按钮（见 store 的 SessionState 与 nav-bar）。
 */

/** 一次鉴权检查的三种结局 —— 调用方按它决定说什么话（跳页由本模块负责） */
export type AuthResult =
  /** 服务端确认：users 里有我这一行 ⇒ 放行 */
  | 'joined'
  /** 服务端明确说认不出我（401）⇒ **已跳加入页** */
  | 'not-joined'
  /** 没问到（超时 / 没网 / 后端没起来）⇒ 什么都没做，调用方提示重试 */
  | 'unknown'

/**
 * ⭐ 「没问到」时给用户的那一句（全站同一句，别各写各的）。
 * ⚠️ 它说的是**能做什么**（检查网络、再点一次），不是"失败"两个字。
 */
export const AUTH_RETRY_HINT = '没连上服务器，检查网络后再点一次'

/**
 * ⭐ 本机此刻"有没有记录" —— **只读、不发请求**，给界面用（header 那一格）。
 * ⚠️ 它读的是最近一次问到的快照（`userInfo !== null` = 有记录），
 *    权威判断永远在服务端（见文件头）。
 */
export function isAuthed(): boolean {
  return me.hasJoined()
}

/**
 * ⭐⭐ **通用的 auth 中间函数** —— 需要"库里必须有我这一行"的功能，动之前调它。
 *
 * @param opts.needProfile 要不要顺带把 `/me` 的资料（含**权威余额**）拿回来
 *
 * ⚠️ 已有记录时**一次网络都不发**（老用户零成本）；`needProfile` 时才补一次 `/me`。
 * ⚠️ 本函数自己只做决定 + 跳页，**不弹提示**：提示归调用方的界面（toast / 页面红字），
 *    因为只有调用方知道此刻用户在看哪里。
 */
export async function ensureAuthed(opts: { needProfile?: boolean } = {}): Promise<AuthResult> {
  // ① 最近一次已经问到"有记录"：直接放行
  if (isAuthed()) {
    if (!opts.needProfile) return 'joined'
    return (await refetchProfile()) ? 'joined' : 'unknown'
  }

  /**
   * ② 还不知道 ⇒ 去问服务端。顺序：先确保登录（拿到 openid 的身份），再问 /me。
   *    ⚠️ 云托管通道下 `login()` 内部就是一次 `/me`（网关注入身份），
   *      这一步顺带就把 users 那一行建出来了 —— 见 client.ts 的 doLogin。
   */
  try {
    await login()
  } catch (err) {
    // ⚠️ 登录失败 = **没问到**（不是"没记录"）⇒ 不跳页，也不标 ready（界面画「重新连接」）
    console.warn('[auth] 静默登录失败（按"没问到"处理）：' + (err as Error).message)
    me.markSessionUnknown()
    return 'unknown'
  }

  // ③ 问权威的那一句：users 里到底有没有我
  try {
    me.applyProfile(await fetchMe())
    return 'joined'
  } catch (err) {
    const e = err as ApiError
    if (isAuthError(e)) {
      // 服务端明确说"认不出你"（401）⇒ 这才是**库里没记录**，跳加入页
      me.markSessionReady()
      goJoin()
      return 'not-joined'
    }
    // ⚠️ 超时 / 5xx / 没网：什么都不知道 ⇒ 什么都不做，只把状态标成"没问到"
    console.warn('[auth] 问不到用户记录（不跳加入页）：' + (err as Error).message)
    me.markSessionUnknown()
    return 'unknown'
  }
}

/**
 * ⭐ 用户**明确想加入**时用（header 那一格的「加入」、提示里的「重试」）：
 *    问不到就**直接带他去加入页** —— 那时候跳是对的，因为他自己就是要去做这件事。
 */
export async function retryAuth(): Promise<void> {
  if (isAuthed()) return
  const r = await ensureAuthed()
  // ⚠️ 'joined' 说明刚问到了（可能只是启动那次没问到），什么都不用做
  if (r === 'joined') return
  goJoin()
}

/**
 * ⭐ 表单保存这类"我已经确定要写数据"的入口：要一个身份，失败**抛一句人话**。
 *
 * ⚠️ 与 `ensureAuthed()` 的分工：那个负责"没记录就跳加入页"（导航决策），
 *    这个负责"我要继续往下做" —— 而**加入页自己也会用它**，
 *    所以它绝不能跳页（会死循环），只能把失败说出来。
 */
export async function requireIdentity(): Promise<void> {
  if (isAuthed()) return
  try {
    await login()
    me.applyProfile(await fetchMe())
  } catch (err) {
    throw new Error(AUTH_RETRY_HINT)
  }
}

/**
 * ⚠️ 怎么判"服务端明确说认不出我"：只有 401（`handleResponse` 会把它转成
 *    `AuthExpiredError`，`code` 是 AUTH_EXPIRED —— 见 client.ts）。
 *    其余一切（超时、5xx、信封坏了）都是"没问到"。
 */
function isAuthError(e: ApiError): boolean {
  return e.code === 'AUTH_EXPIRED' || e.code === 'UNAUTHORIZED'
}

/** 去加入页 —— **只有这一处**（auth 判成"未加入"之后的统一去处） */
function goJoin(): void {
  // ⚠️ 加入页是**公开页**（正是"没记录"时的去处）：走 goPublic，不要再过 guard（会死循环）
  // ⚠️ once=true：已经在加入页就不再压一层（auth 每次拦下都会跳这里）
  goPublic(JOIN_URL, true)
}

/**
 * 补一次 `/me` 并写回 store（已有记录、但要权威余额时）。
 * ⚠️ 失败**不算没记录**：返回 false 让调用方提示重试，绝不动导航。
 */
async function refetchProfile(): Promise<boolean> {
  try {
    me.applyProfile(await fetchMe())
    return true
  } catch (err) {
    console.warn('[auth] 取用户资料失败（按"没问到"处理）：' + (err as Error).message)
    return false
  }
}
