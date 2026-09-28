import { ensureAuthed } from './auth'

/**
 * ⭐⭐⭐ **全站唯一的跳页入口**（用户 2026-09 定）。
 *
 * 为什么要有这一层：每条 `wx.navigateTo({ url: ... })` 都是一次"我要用某个页面"的
 * 声明，而**有些页面离了账号根本用不了**（详见下面 PROTECTED）。把守卫写在各页面里，
 * 必然出现"这页拦了、那页忘了"，而忘了的表现不是报错 —— 是用户读了一分钟、
 * 提交时才发现成绩没有主人（uid=0 时那条 `users` 行压根还没建）。
 *
 * 所以这里把两件事收成一处：
 *   ① **所有**带页面的跳转都写成 `go('/pages/…')` / `replace('/pages/…')`；
 *   ② 受保护页由 `ensureAuthed()` 统一拦，三种结局（见 lib/auth）：
 *        已加入 → 放行；**未加入（服务端明确说认不出）→ 跳加入页**；
 *        没问到（断网 / 后端没起来）→ 不放行、**也不跳加入页**（提示重试）。
 *
 * ⚠️ 不受保护的页（**故意**列在这里，别顺手加进去）：
 *   · `/pages/join/join`      —— 它就是"没账号"时的去处，拦它 = 死循环；
 *   · `/pages/index/index`    —— 首页公开（服务端那侧也刻意不加鉴权，见 index.ts 的说明）；
 *   · `/pages/arena/arena`    —— 竞技场按句子寻址、对陌生人可见，匿名也能看榜；
 *   · `/pages/challenge/challenge` —— 挑战详情可分享，从分享链接进来的人没有账号也该看得到；
 *   · `/pages/profile/profile`     —— 别人（以及我自己）的成绩墙，公开。
 *   前三者里凡是**真的要写数据**的动作（收藏、提交、改资料），在动作那一处单独要身份 ——
 *   门禁画在"动作"上，而不是画在"页面"上，这样匿名浏览永远打得开。
 */

/** 受保护页的 route 前缀（带斜杠的 url 形式）—— 判据只有这一处 */
const PROTECTED = [
  '/pages/reading/reading',
  '/pages/me/',
  '/pages/me/edit-user/edit-user',
]

/**
 * ⭐ **路径常量与 route 名都在这里**（用户 2026-09 定：路由只该有一处）。
 *    url   = 带斜杠，给 wx.navigateTo 用；
 *    route = 不带斜杠，用来比对 getCurrentPages()（判"是不是已经在这一页"）。
 * ⚠️ 新增页面时**只改这一张表** —— 别在页面里另写一个字面量（改路径时必漏一个）。
 */
export const ROUTES = {
  home: { url: '/pages/index/index', route: 'pages/index/index' },
  join: { url: '/pages/join/join', route: 'pages/join/join' },
  profileEdit: { url: '/pages/me/edit-user/edit-user', route: 'pages/me/edit-user/edit-user' },
  profileHome: { url: '/pages/profile/profile', route: 'pages/profile/profile' },
  challenges: { url: '/pages/me/challenges/challenges', route: 'pages/me/challenges/challenges' },
  participations: {
    url: '/pages/me/participations/participations',
    route: 'pages/me/participations/participations',
  },
  collection: { url: '/pages/me/collection/collection', route: 'pages/me/collection/collection' },
  streak: { url: '/pages/me/streak/streak', route: 'pages/me/streak/streak' },
  energy: { url: '/pages/me/energy/energy', route: 'pages/me/energy/energy' },
  reading: { url: '/pages/reading/reading', route: 'pages/reading/reading' },
  arena: { url: '/pages/arena/arena', route: 'pages/arena/arena' },
  challenge: { url: '/pages/challenge/challenge', route: 'pages/challenge/challenge' },
} as const

/** 加入页 —— 认不出身份时统一落到这里（用户 2026-09 定的去处） */
export const JOIN_URL = ROUTES.join.url
/** 首页 */
export const HOME_URL = ROUTES.home.url

function isProtected(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  return PROTECTED.some((p) => path === p || path.startsWith(p))
}

/**
 * ⭐ 跳到一个页面（`wx.navigateTo` 的唯一替代）。
 *
 * @returns 真跳走了 → true；被 auth 拦下（已经改跳加入页）→ false
 *
 * ⚠️ 守卫失败时**不再跳原页面**：`ensureAuthed()` 已经把用户送到加入页了，
 *    这时候再跳一次原页会把他从加入页弹走（那正是我们最不想要的）。
 */
export async function go(url: string): Promise<boolean> {
  if (isProtected(url)) {
    const auth = await ensureAuthed()
    // ⚠️ 'not-joined'：auth 已经把人送到加入页了（别再跳原页，会把他从加入页弹走）； 
    //    'unknown'：没问到 —— 也**不跳**（否则等于放一个没有归属的录音进去读）
    if (auth !== 'joined') return false
  }
  wx.navigateTo({ url, fail: () => wx.reLaunch({ url }) })
  return true
}

/** ⭐ 替换当前页（`wx.redirectTo` 的唯一替代）—— 守卫口径与 go() 完全一致 */
export async function replace(url: string): Promise<boolean> {
  if (isProtected(url)) {
    const auth = await ensureAuthed()
    if (auth !== 'joined') return false
  }
  wx.redirectTo({ url, fail: () => wx.reLaunch({ url }) })
  return true
}

/**
 * ⭐ 去一个**公开**页（首页 / 加入页 / 竞技场 / 挑战详情 / 成绩墙）——
 * 名字不同是为了让"这一跳不需要身份"在代码里看得见（读的人不用去查表）。
 *
 * ⚠️ `once` 传 true 时**已经在那一页就不再压一层**（否则返回要按好几次）。
 *    加入页 / 修改资料页用得到它 —— 它们可能被反复触发（auth 每次拦下都会跳加入页）。
 */
export function goPublic(url: string, once = false): void {
  if (once && currentRoute() === url.split('?')[0]?.slice(1)) return
  wx.navigateTo({ url, fail: () => wx.reLaunch({ url }) })
}

/**
 * ⭐ 开某个**功能页**，并顺手做"别叠两层同样的页"这件事。
 * ⚠️ 页面栈里已经在那一页时**什么都不做**（否则返回要按好几次，见 join.ts 的历史注释）。
 */
export async function goOnce(url: string, route: string): Promise<boolean> {
  if (currentRoute() === route) return false
  return go(url)
}

/**
 * ⭐ 我此刻在哪一页（route 形式，无斜杠）—— 判"已经在那一页了"只走这一处。
 * ⚠️ 小程序里没有别的可靠来源：读页面栈是唯一办法。
 */
export function currentRoute(): string {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  return current?.route ?? ''
}

/** 回上一页；栈空了就回首页（别让用户卡在没有出口的页面上） */
export function back(): void {
  wx.navigateBack({ delta: 1, fail: () => wx.reLaunch({ url: HOME_URL }) })
}
