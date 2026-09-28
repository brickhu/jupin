import { getUserId, login } from './api/client'

/**
 * ⭐⭐ 身份那一份检查 —— **全站只有这一处实现**（用户 2026-09 定）。
 *
 * 判据只有一条，和**导航栏那一格完全相同**（见 components/nav-bar）：
 *   **服务端应答过我吗** —— 即本机有没有拿到过 uid（`GET /api/user/me` / 提交接口
 *   回来时服务端会把 uid 写下来）。
 *
 * ⚠️⚠️ 与**昵称 / 头像毫无关系**（我被绕进去过一次，写在这里免得再错）：
 *    · 导航栏那个「加入」= `hasJoined()` = `state.userInfo !== null` —— 意思是
 *      "服务端应答过我"，不是"我起过名字"；
 *    · 「加入页」只是**补资料**的地方（昵称/头像），它**不是登录、也不是前置条件**；
 *    · 用户面板里那一格（`named ? 修改资料 : 加入页`）是**补资料的措辞分流**。
 *
 * ⚠️⚠️ 为什么每条要花钱/要落库的路都要先过这一关：**uid=0 时那条 `users` 行还没建**
 *    （中间件 `getOrCreateUserByOpenid` 是全站唯一的注册点，它在**第一个成功的请求**上
 *    才建行）。那时：
 *      · 录音上传路径 `audio/{句子id}/{uid}/…` 里的 uid 非法 → 上传必失败；
 *      · 更根本的是**成绩没有归属** —— 分数、榜单、成长值全挂在 user_id 上。
 */

/** 本机有没有身份（服务端应答过我）—— 判据见文件头 */
export function hasIdentity(): boolean {
  return getUserId() > 0
}

/**
 * ⭐ 要一个身份：本机没有就**静默登录一次**（这一步顺带完成注册）。
 *
 * ⚠️ 只在 uid=0 时才发请求：已经有身份的人**一次网络都不等**
 *    （这是它和 `ensureSessionForSubmit()` 的分工 —— 那个还要顺带拿权威余额）。
 * ⚠️ 失败**抛人话**，不抛底层那句 "request:fail"：调用方要把它直接显示给用户。
 */
export async function ensureIdentity(): Promise<void> {
  if (hasIdentity()) return
  try {
    await login()
  } catch (err) {
    throw new Error('没连上服务器，暂时取不到你的身份。检查网络后再试一次。')
  }
  // ⚠️ 登录"成功"却仍然没有 uid = 服务端没给 —— 当失败处理，别让调用方以为万事大吉
  if (!hasIdentity()) throw new Error('没能确认你的身份，稍后再试一次。')
}
