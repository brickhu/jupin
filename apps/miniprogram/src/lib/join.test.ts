import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * refreshMe / openJoinPage / openProfilePage 的单测。
 *
 * ⚠️⚠️ 这一版守的是一条产品判断：**「加入」= 有账号，与有没有起名字无关**。
 *
 *    若 refreshMe 的三态不分开，就会把「没问到」当成「没加入」：
 *      · true / false —— 服务端认识我（false 只是「还没填昵称」，不是「没加入」）
 *      · null         —— 没问到，注册状态未知
 *    后果很实在：老用户被推去加入页，然后以为自己的成绩没了。
 */

const memory = new Map<string, unknown>()
/** 记录所有跳转 —— 断言"跳了没有、跳到哪"就靠它 */
const nav: string[] = []
/** 页面栈：测试里由用例自己摆 */
let stack: { route: string }[] = []

vi.stubGlobal('getCurrentPages', () => stack)
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
  navigateTo: (o: { url: string }) => nav.push('to:' + o.url),
  navigateBack: () => nav.push('back'),
  reLaunch: (o: { url: string }) => nav.push('reLaunch:' + o.url),
})

const fetchMe = vi.fn()
vi.mock('./api/client', () => ({
  fetchMe: () => fetchMe(),
}))

let store: typeof import('./store')
let join: typeof import('./join')

beforeAll(async () => {
  store = await import('./store')
  join = await import('./join')
})

/** 造一份 /api/user/me 的响应 */
function meResponse(nickname: string | null) {
  return {
    id: 1,
    nickname,
    avatarUrl: null,
    status: 'active',
    isMember: false,
    dailyLimit: 1,
    usedToday: 0,
    challengedCount: 0,
    challengedRounds: 0,
    conqueredCount: 0,
    streak: {
      streakDays: 0,
      streakBest: 0,
      freezeCount: 0,
      badge: null,
      nextBadge: null,
      daysToNext: 7,
      readToday: false,
    },
  }
}

beforeEach(() => {
  fetchMe.mockReset()
  nav.length = 0
  stack = [{ route: 'pages/index/index' }]
  store.reset()
})

describe('refreshMe', () => {
  it('服务端认识我 → true，并把资料写进 state', async () => {
    fetchMe.mockResolvedValue(meResponse('老用户'))
    await expect(join.refreshMe()).resolves.toBe(true)
    expect(store.hasJoined()).toBe(true)
  })

  it('服务端不认识我 → false', async () => {
    fetchMe.mockResolvedValue(meResponse(null))
    await expect(join.refreshMe()).resolves.toBe(false)
  })

  it('⚠️ 问不到 → null（与 false 分开，调用方据此决定放不放行）', async () => {
    fetchMe.mockRejectedValue(new Error('boom'))
    await expect(join.refreshMe()).resolves.toBe(null)
  })
})

describe('applyProfilePatch —— 保存接口的返回值直接定「已经有名字」', () => {
  it('⭐ 昵称一写进来就立刻算已加入（不依赖再 GET 一次）', () => {
    expect(store.hasJoined()).toBe(false)
    store.applyProfilePatch({ nickname: '张三', avatarUrl: null })
    expect(store.hasJoined()).toBe(true)
    expect(store.getState().profile?.nickname).toBe('张三')
  })

  it('⚠️ 只动昵称/头像，已征服数原样留着（保存接口不返回它）', () => {
    const withCount = { ...meResponse('旧名字'), conqueredCount: 7 }
    store.applyProfile(withCount as never)
    store.applyProfilePatch({ nickname: '新名字', avatarUrl: null })
    expect(store.getState().profile?.conqueredCount).toBe(7)
  })
})

describe('openJoinPage', () => {
  it('⚠️ 已经在加入页上 → 不再压一层（否则返回要按好几次）', () => {
    stack = [{ route: 'pages/index/index' }, { route: 'pages/join/join' }]
    join.openJoinPage()
    expect(nav).toEqual([])
  })

  it('在别的页面上 → navigateTo 压上去（这样「确认加入」能返回原页）', () => {
    join.openJoinPage()
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
  })
})

describe('openProfilePage —— 用户面板里的「修改」', () => {
  it('⭐ 去的是修改资料页，不是加入页', () => {
    join.openProfilePage()
    expect(nav).toEqual(['to:' + join.PROFILE_PAGE])
    expect(join.PROFILE_PAGE).not.toBe(join.JOIN_PAGE)
  })

  it('⚠️ 已经在那一页上就不再压一层', () => {
    stack = [{ route: 'pages/index/index' }, { route: 'pages/profile-edit/profile-edit' }]
    join.openProfilePage()
    expect(nav).toEqual([])
  })
})
