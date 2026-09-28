import { getUserId, fetchMe, login } from './api/client'
import { JOIN_URL, goPublic } from './route'
import * as me from './store'

/**
 * ⭐⭐⭐ **全站唯一的 auth**（用户 2026-09 定）。
 *
 * 所有跟"这个人是谁、他在不在我们库里"有关的事，都只走这个文件 ——
 * 页面里不许再各写一段 `if (uid) …` / `if (hasJoined()) …`（那正是上一版的毛病：
 * 同一件事散在首页、朗读页、加入页三处，口径一定会漂）。
 *
 * ────────────────────────────────────────────────────────────────
 * ⭐⭐ 两件事必须分清（这是这个产品最容易搞混的地方）：
 *
 *   ① **微信登录** = 我是谁（openid）。打开小程序就静默完成，**没有 UI、没有失败弹窗**。
 *      它只是 openid 的来源（云托管那条路由微信网关注入，连 token 都不需要）。
 *
 *   ② **在不在 users 里** = 服务端认不认识我。这是**另一回事**，而且它有真实后果：
 *      · 服务端那条 `users` 行只在**第一个成功的业务请求**上才建出来
 *        （middleware/auth.ts + services/user.ts 的 getOrCreateUserByOpenid —— 全站唯一注册点）；
 *      · 在那之前 **uid=0**：录音上传路径 `audio/{句子id}/{uid}/…` 没有合法 uid，
 *        分数 / 榜单 / 成长值**没有主人**。
 *      ⇒ 所以任何要花钱、要落库、要"我的"数据的动作，**先过这里**。
 *
 * ⭐⭐ 判据是 **uid**（`getUserId() > 0`），不是 `me.hasJoined()`：
 *    · uid 在**第一次成功登录的那一刻**就落到本机了（两条通道都会 setUserId）；
 *    · 而 `hasJoined()` 是 `userInfo !== null`，含义是"我**拉过资料**"——
 *      登录成功但紧接着那次 `/me` 断网时它是 false，于是"有账号的人"会被判成没账号、
 *      被推去加入页（他会以为账号没了）。这是最贵的一类错，所以判据不取它。
 *    ⚠️ **与有没有起昵称/头像无关**（那是"榜上显示成什么"，随时能补）。
 *    （导航栏那一格用的是 hasJoined() —— 它要的不是"有没有账号"，而是"能不能画出头像"，
 *      所以两处判据不同是**对的**，不是不一致。）
 *
 * ────────────────────────────────────────────────────────────────
 * 页面/库怎么用（只有这三种问法）：
 *
 *   · `isAuthed()`            纯查询、不发请求 —— 用来画界面（按钮画「加入」还是头像）
 *   · `ensureAuthed()`        要动手之前用：没身份就**静默登录一次**，仍不行跳加入页
 *   · `ensureAuthed({ needProfile: true })`  顺带把 `/me` 的资料拿回来（要权威余额时用）
 */

/** 当前是不是"服务端认识我" —— 只读，不发任何请求（判据见文件头：uid） */
export function isAuthed(): boolean {
  return getUserId() > 0
}

/**
 * 确保"服务端认识我"。
 *
 * @param opts.needProfile 要不要顺带把 `/me` 的资料拿回来（提交前要权威余额时传 true）
 * @returns 认得我 → true；不认得 → **已经跳了加入页**，返回 false
 *
 * ⚠️⚠️ 顺序是刻意的，别调换：
 *    1. 已经有身份 → **一次网络都不发**（老用户走这条路，零成本）；
 *    2. 还没有 → 一次 `login()` + 一次 `/me`。**这两步分别在做什么**：
 *         · `login()` —— 公网通道 = `wx.login` 换 code → `POST /api/auth/login`；
 *           云托管通道 = `GET /api/user/me`（身份由微信网关注入）。
 *           ⚠️ 两条路服务端都会走 `getOrCreateUserByOpenid`：**没有那一行就当场建**
 *           （middleware/auth.ts 是全站唯一注册点）⇒ **注册是它的副作用，不是另一步**。
 *           客户端在这一步拿到 uid（setUserId）。
 *         · 那次 `/me` —— 只是为了把资料与**权威余额**拿回来（画界面、确认能量用）。
 *           ⚠️ 它失败**不代表没账号**（uid 已经有了）：已经有 uid 的人走的是上面第 1 条，
 *              根本不会重来一遍，更不会被推去加入页。
 *    3. 还是不行（后端没起来 / 网关不通）→ 跳加入页**并返回 false**。
 *
 * ⚠️ 为什么失败跳加入页：加入页是"补资料"的地方，也是**唯一一个不带业务门禁的写入口** ——
 *    它的保存会再走一次本函数（见 profile-form），所以人在那一页还有一次机会；
 *    而停在朗读页只会让他白读一遍。（用户 2026-09 定的去处。）
 */
export async function ensureAuthed(opts: { needProfile?: boolean } = {}): Promise<boolean> {
  // ① 已经有身份：直接过（needProfile 时补一次 /me，因为它要给权威余额）
  if (isAuthed()) {
    if (!opts.needProfile) return true
    return refetchProfile()
  }

  // ② 还没有：补一次微信登录 + 一次 /me（后者顺带完成注册）
  try {
    await login()
  } catch (err) {
    // ⚠️ 登录失败**不抛错**：调用方要的是"能不能继续"，不是异常处理。
    //    但不假装成功 —— 走下面统一跳加入页。
    console.warn('[auth] 静默登录失败：' + (err as Error).message)
    goJoin()
    return false
  }

  if (await refetchProfile()) return true

  goJoin()
  return false
}

/**
 * 去加入页 —— **只有这一处**（auth 拦下之后的统一去处）。
 *
 * ⚠️⚠️ 必须走 `goPublic()` 而不是 `go()`：加入页是**公开页**（正是"没账号"时的去处）。
 *    走带守卫的 `go()` 会再触发一次 auth → 再跳一次加入页 → 死循环。
 * ⚠️ 已经在加入页上就不要再压一层（返回要按好几次）。
 */
function goJoin(): void {
  // ⚠️ once=true：已经在加入页就不再压一层（见 goPublic 的说明）
  goPublic(JOIN_URL, true)
}

/**
 * 拉一次 `/me` 并写回 store —— 这一步**就是注册**（服务端没有那一行就当场建）。
 *
 * ⚠️ `markSessionReady()` 成功失败都要调（见 store 与 join.refreshMe 的说明）：
 *    不调的话导航栏会永远停在转圈 —— 那比画一个「加入」按钮更糟。
 */
async function refetchProfile(): Promise<boolean> {
  try {
    me.applyProfile(await fetchMe())
    return true
  } catch (err) {
    console.warn('[auth] 取用户资料失败（后端未连接？）：' + (err as Error).message)
    me.markSessionReady()
    return false
  }
}

/**
 * ⭐ 要一个身份，并把它当成"必须成功"来做 —— 失败时**抛一句人话**。
 *
 * 与 `ensureAuthed()` 的分工：那个负责"不认得就跳加入页"（导航决策），
 * 这个负责"我要继续往下做，没有身份就不行"（表单保存、提交评测）。
 * ⚠️ 两个都留着是有必要的：加入页在**没有身份时也可能被打开**（它正是目的地），
 *    那时不能把自己再跳一次（死循环），只能把失败说给用户。
 */
export async function requireIdentity(): Promise<void> {
  if (getUserId() > 0) return
  try {
    await login()
  } catch (err) {
    throw new Error('没连上服务器，暂时取不到你的身份。检查网络后再试一次。')
  }
  if (getUserId() <= 0) throw new Error('没能确认你的身份，稍后再试一次。')
}
