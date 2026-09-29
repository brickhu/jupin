import { ApiError, fetchMe, setNotRegisteredHandler } from './api/client'
import { JOIN_URL, goPublic } from './route'
import * as me from './store'

/**
 * ⭐⭐⭐ **全站唯一的 auth** —— 判断的是「**这个人在 `users` 里有没有记录**」。
 *
 * 用户 2026-09 定的口径（三条，别再加概念）：
 *   ① 打开小程序只有**授权身份**（`wx.login` / 云托管网关注入的 openid）。
 *      它只解决"你是谁"，**不代表你在我们库里有记录** —— 那是另一回事。
 *   ② **注册是用户自己的动作**（"注册不能做成自动的"，用户 2026-09）：
 *      唯一建行的地方是「加入句拼」页按下「确认加入」
 *      （端侧 `register()` → 服务端 `POST /api/auth/register`）。
 *      除此之外，任何"顺手问一下"的路径**都不许建号**。
 *   ③ 需要"库里必须有我这一行"才能用的功能，动之前过 `ensureAuthed()`：
 *      有记录 → 放行；**没记录 → 跳加入页**；问不到 → 不跳，提示重试。
 *
 * ⚠️⚠️ **判据必须是"服务端那一行"，不是 `wx.login` 的结果，也不是本机缓存**：
 *    `wx.login` 成功只说明拿到了 openid；本机 `userInfo` 只是上一次问到的快照。
 *    真正权威的那一问是 `GET /api/user/me` —— 服务端按 openid **查**用户
 *    （**不再"没有就建"**：那条路已经删了，见 middleware/auth.ts）+ 回数据。
 *
 * ⚠️⚠️ 于是三种结局**必须分开**（这是本项目踩过的坑）：
 *    · /me 成功               → **已加入**；
 *    · /me 回 403 NOT_REGISTERED → **未加入**（服务端明确说的）⇒ 跳加入页；
 *    · /me 超时 / 5xx / 没网   → **什么都不知道** ⇒ **绝不跳加入页**
 *      （跳了等于把老用户推去加入页，他会以为账号没了）。
 *
 * ⚠️ 还有一条连带后果：**"问不到"时不能把 session 标记成 ready**，而是标成 'unknown' ——
 *    否则 header 会画出一个假的「加入」按钮（见 store 的 SessionState 与 nav-bar）。
 */

/** 一次鉴权检查的三种结局 —— 调用方按它决定说什么话（跳页由本模块负责） */
export type AuthResult =
  /** 服务端确认：users 里有我这一行 ⇒ 放行 */
  | 'joined'
  /** 服务端明确说认不出我 / 库里没有我（401·403）⇒ **已跳加入页** */
  | 'not-joined'
  /** 没问到（超时 / 没网 / 后端没起来）⇒ 什么都没做，调用方提示重试 */
  | 'unknown'

/**
 * ⭐ 问一次「我加入了没有」的三种结局 —— 与 AuthResult 的三种视觉状态一一对应，
 *    但语义更细：`unregistered` 是**服务端明确说的**，不是错误。
 */
export type MeFetchResult =
  /** 服务端认识我（库里那一行在） */
  | 'joined'
  /** 服务端明确说：库里没有我这一行 ⇒ 该画「加入」 */
  | 'unregistered'
  /** 没问到（超时 / 没网 / 后端没起来）⇒ 画「重新连接」，**不画「加入」** */
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
 * ⭐⭐ 服务端明确回答「你还没加入句拼」。
 *
 * ⚠️ 判据只有 `code === 'NOT_REGISTERED'`（403 + 正常信封）——
 *    服务端在 authMiddleware 里对"认得出凭据、库里没有行"给的就是它。
 *    **不能拿 HTTP 状态码猜**：`handleResponse` 已经把状态码归一成错误码了。
 */
export function isUnregistered(e: unknown): boolean {
  return (e as ApiError)?.code === 'NOT_REGISTERED'
}

/**
 * 401：服务端说"认不出你"（没凭据 / 凭据过期）。
 *
 * ⚠️ 服务端给两个 code，**对界面是同一件事**（都得重新登录一次），所以两个都算：
 *      · `AUTH_EXPIRED`  —— token 过期 / 老 token 里的账号已经不在了
 *      · `AUTH_REQUIRED` —— 压根没带凭据
 * ⚠️ 其余一切（超时、5xx、信封坏了）都是"没问到" —— **绝不能**跳到加入页，
 *    否则一次断网就会把有账号的人当成没账号（这条是 B31 定下的）。
 */
function isAuthError(e: ApiError): boolean {
  return e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_REQUIRED' || e.code === 'UNAUTHORIZED'
}

/**
 * ⭐⭐ **问一次服务端「我加入了没有」** —— 全站唯一判断注册状态的地方。
 *
 * ⚠️ 它同时就是「刷新我的资料」（昵称 / 能量 / streak / 战绩计数）——
 *    一次 `/me` 同时回答这两个问题，不要再拆成两个接口。
 *
 * ⚠️⚠️ 三态必须分开返回（见文件头）：把 `unregistered` 和 `unknown` 混成一个
 *    "没有资料"的返回值，就会在断网时把老用户推去加入页。
 *
 * @returns 'joined' / 'unregistered' / 'unknown'
 */
export async function refreshMe(): Promise<MeFetchResult> {
  try {
    const profile = await fetchMe()
    me.applyProfile(profile)
    return 'joined'
  } catch (err) {
    if (isUnregistered(err)) {
      /**
       * ⭐ 服务端**明确**回答：库里没有我这一行。
       *    ⇒ 这是一个正常状态（未注册），不是失败：
       *       · session 标 ready（界面该画「加入」，不再转圈）；
       *       · **不动 userInfo**（本机可能还有上一次的快照，但那已经过期 ——
       *         保留它会画出"已加入"的假象，所以这里一并清掉）。
       */
      me.clearIdentity()
      return 'unregistered'
    }
    console.warn('[auth] 取用户资料失败（按"没问到"处理）：' + (err as Error).message)
    // ⚠️ 问不到 ≠ 未注册：标 unknown ⇒ 导航栏画「重新连接」，绝不能画「加入」
    me.markSessionUnknown()
    return 'unknown'
  }
}

/* ------------------------------------------------------------------ */
/* 服务端说"库里没有我"时，把本机那份过期快照清掉                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️⚠️ 为什么要有这一手：本机 `userInfo` 是**上一次问到的快照**，它会落 storage。
 *    服务端那边的行可能已经没了（清库 / 换环境 / 账号被删）—— 那时本机还自信地
 *    认为"我加入过"，于是 `ensureAuthed()` 直接放行，用户点下去才发现每个
 *    鉴权接口都回 403，界面表现成"什么都打不开"。
 *    ⇒ 任何一次鉴权请求收到 NOT_REGISTERED，都立刻把本机身份清成"未注册"，
 *      界面当场翻成「加入」，下一次动手就会被送去加入页。
 */
setNotRegisteredHandler(() => {
  me.clearIdentity()
})

/* ------------------------------------------------------------------ */
/* 门禁                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **通用的 auth 中间函数** —— 需要"库里必须有我这一行"的功能，动之前调它。
 *
 * @param opts.needProfile 要不要顺带把 `/me` 的资料（含**权威余额**）拿回来
 *
 * ⚠️ 已有记录时**一次网络都不发**（老用户零成本）；`needProfile` 时才补一次 `/me`。
 * ⚠️ **本函数绝不注册**：没记录就只是把人送去加入页 —— 建行只发生在用户
 *    在加入页按下「确认加入」的那一下（见文件头口径②）。
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
   * ② 本机已经知道自己是"未注册"（上一次 /me 明确回的）⇒ **一次网络都不发**，
   *    直接去加入页。反复问同一个已经知道答案的问题只是白等一次往返。
   *    ⚠️ 判据必须是 `session === 'ready'`（= 服务端给过答复）——
   *       'unknown'（问不到）时**不许**当成"未注册"。
   */
  if (me.getState().session === 'ready') {
    goJoin()
    return 'not-joined'
  }

  // ③ 还没问过 ⇒ 去问那权威的一句
  const r = await refreshMe()
  if (r === 'joined') return 'joined'
  if (r === 'unregistered') {
    goJoin()
    return 'not-joined'
  }
  // 问不到：不跳页，也不标 ready（界面画「重新连接」）
  return 'unknown'
}

/**
 * ⭐ 用户**明确想加入**时用（header 那一格的「加入」、提示里的「重试」）：
 *    问不到也**直接带他去加入页** —— 那时候跳是对的，因为他自己就是要去做这件事。
 */
export async function retryAuth(): Promise<void> {
  if (isAuthed()) return
  const r = await ensureAuthed()
  // ⚠️ 'joined' 说明刚问到了（可能只是启动那次没问到），什么都不用做；
  //    'not-joined' 说明 ensureAuthed 已经把人送去加入页了 —— 别跳第二次
  if (r === 'joined' || r === 'not-joined') return
  // 'unknown'（问不到）—— 但用户是自己按的「加入」⇒ 仍然带他去加入页
  goJoin()
}

/**
 * ⭐ 表单保存这类"我已经确定要写数据"的入口：要一个身份，失败**抛一句人话**。
 *
 * ⚠️ 与 `ensureAuthed()` 的分工：那个负责"没记录就跳加入页"（导航决策），
 *    这个负责"我要继续往下做" —— 而**加入页自己也会用它**，
 *    所以它绝不能跳页（会死循环），只能把失败说出来。
 *
 * ⚠️⚠️ 它**不注册**（注册只能由加入页那一次显式动作触发）。所以：
 *    · 已加入 → 直接过；
 *    · 没加入 → 抛一句"检查网络后再点一次"（调用方是加入页时它自己会去注册）。
 */
export async function requireIdentity(): Promise<void> {
  if (isAuthed()) return
  // 本机可能是冷启动还没问过 —— 问一次，问到了就过（例如缓存被清但账号还在）
  const r = await refreshMe()
  if (r === 'joined') return
  throw new Error(AUTH_RETRY_HINT)
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
