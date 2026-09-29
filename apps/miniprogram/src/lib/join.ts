import { HOME_URL, JOIN_URL, ROUTES, goOnce, goPublic } from './route'

/** 「加入句拼」页（带斜杠）—— 常量住在 lib/route 的 ROUTES 表里 */
export const JOIN_PAGE = JOIN_URL
/** 「修改资料」页 —— 已经加入过的人改资料走这一页（昵称/头像/性别/年龄/简介） */
export const PROFILE_PAGE = ROUTES.profileEdit.url
/** 兜底回首页 */
export const HOME_PAGE = HOME_URL

/**
 * ⭐ 身份检查的**唯一实现**现在住在 `lib/auth.ts`，跳页的唯一入口住在 `lib/route.ts`。
 *    这里把几个入口转出去 —— 老调用点（user-sheet / join 页 / profile-form）不用改
 *    import 路径，但**实现只有一份**（用户 2026-09 定的：不许再叠重复的函数）。
 *
 * ⚠️ `refreshMe` 也一并转出去：它现在回答的是「我加入了没有」（三态），
 *    实现就在 auth.ts（见那里的 `MeFetchResult`）。
 */
export { isAuthed, ensureAuthed, requireIdentity, refreshMe } from './auth'
export { go, replace, goPublic, goOnce, back, JOIN_URL, HOME_URL } from './route'

/**
 * ⭐ 跳到「加入句拼」页 —— **注册的发生地**。
 *
 * ⚠️⚠️ 它才是这个产品里"注册"的入口（用户 2026-09 定：注册不能自动）。
 *    账号（openid）是静默拿到的，但 `users` 那一行**只有用户在这一页按下
 *    「确认加入」才会建出来**（见 components/profile-form 的 register 模式）。
 *    ⇒ 不加入 = 只能只读浏览：挑战、能量、参与记录、收藏都用不了。
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
