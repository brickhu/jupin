/**
 * ⭐ 「我」这一块的路由入口 —— 我的挑战 / 参与场次 / 挑战结果。
 *
 * ⚠️ 为什么单独一个模块：**路由常量**只该有一处 ——
 *    用户面板、列表页、朗读页好几处都要用，各写一个字面量，改路径时必漏一个。
 * ⚠️ 路由分层：属于「我」的页面放在 pages/me/ 下（我的挑战 / 参与场次）；
 *    而**挑战结果页**（pages/challenge）刻意留在 me 之外 ——
 *    它要能被分享、被陌生人打开，不属于任何一个人的私有地盘。
 */

/** 「我的挑战」列表页 */
const CHALLENGES_PAGE = '/pages/me/challenges/challenges'
/** 「挑战结果」页 —— 录音打完分要 redirect 过去的那一页（可分享，故不在 me 下） */
export const CHALLENGE_PAGE = '/pages/challenge/challenge'
/**
 * ⭐ 「用户主页」—— 只读的成绩墙。
 *
 * ⚠️⚠️ 它**刻意不在 pages/me/ 下**，和挑战结果页是同一个理由：
 *    这一页是**对外展示**的（以后要能被别人打开、能分享），
 *    不属于任何一个人的私有地盘。放在 me/ 下面会让人以为"只有我自己能看"。
 * ⚠️ 相应地，「修改资料」（表单、私有）让出了 profile 这个名字，
 *    改叫 pages/profile-edit —— 免得两个 profile 页面靠猜。
 */
const PROFILE_HOME_PAGE = '/pages/profile/profile'
/** 页面栈里那一页的 route 写法（无斜杠） */
const PROFILE_HOME_ROUTE = 'pages/profile/profile'

/** 打开「用户主页」—— 同一套去重逻辑（别压两层同样的页） */
export function openProfileHomePage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === PROFILE_HOME_ROUTE) return
  wx.navigateTo({ url: PROFILE_HOME_PAGE, fail: () => wx.reLaunch({ url: PROFILE_HOME_PAGE }) })
}

/** 「连战记录」页（一个月一张日历） */
const STREAK_PAGE = '/pages/me/streak/streak'
const STREAK_ROUTE = 'pages/me/streak/streak'

/** 打开「连战记录」—— 同一套去重逻辑 */
export function openStreakPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === STREAK_ROUTE) return
  wx.navigateTo({ url: STREAK_PAGE, fail: () => wx.reLaunch({ url: STREAK_PAGE }) })
}

/** 「能量」页（余额 + 充值 + 流水） */
const ENERGY_PAGE = '/pages/me/energy/energy'
const ENERGY_ROUTE = 'pages/me/energy/energy'

/**
 * 打开「能量」—— 同一套去重逻辑。
 *
 * ⚠️ 入口有三个，都指向这一页：用户面板名字下面那行「⚡ 能量 N 点」、
 *    朗读页能量不够时的引导、以及「我的主页」。
 */
export function openEnergyPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === ENERGY_ROUTE) return
  wx.navigateTo({ url: ENERGY_PAGE, fail: () => wx.reLaunch({ url: ENERGY_PAGE }) })
}

/** 「参与场次」列表页 */
const PARTICIPATIONS_PAGE = '/pages/me/participations/participations'
/** 页面栈里那一页的 route 写法（无斜杠） */
const PARTICIPATIONS_ROUTE = 'pages/me/participations/participations'

/** 打开「参与场次」—— 与 openChallengesPage 同一套去重逻辑（别压两层同样的页） */
export function openParticipationsPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === PARTICIPATIONS_ROUTE) return
  wx.navigateTo({ url: PARTICIPATIONS_PAGE, fail: () => wx.reLaunch({ url: PARTICIPATIONS_PAGE }) })
}
/** 页面栈里那一页的 route 写法（无斜杠）—— 判断「是不是已经在这一页了」 */
const CHALLENGES_ROUTE = 'pages/me/challenges/challenges'

export function openChallengesPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === CHALLENGES_ROUTE) return
  wx.navigateTo({ url: CHALLENGES_PAGE, fail: () => wx.reLaunch({ url: CHALLENGES_PAGE }) })
}

/**
 * ⭐ 跳到**挑战结果页** —— 一次挑战的全部分数，本人与从分享链接进来的人看的是同一屏。
 *
 * ⚠️ 只带 `sid` 就够了：那一页自己会去取结果（服务端把参考原文、逐词、榜单、
 *    AI 点评都放在同一个结果包里）—— 传一堆参数反而会出现「参数与实际不一致」。
 * ⚠️ 检测还没出结果的记录不该点进来（列表那边已经拦了），这里不管。
 */
export function openChallengePage(submissionId: string): void {
  const url = CHALLENGE_PAGE + '?sid=' + encodeURIComponent(submissionId)
  wx.navigateTo({ url, fail: () => wx.reLaunch({ url }) })
}
