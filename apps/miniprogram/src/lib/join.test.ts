import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * refreshMe / openJoinPage / openProfilePage 的单测。
 *
 * ⚠️⚠️ 这一版守的是两条产品判断：
 *    ① **「加入」= 服务端库里有我这一行**，与有没有起名字无关；
 *    ② **注册不是自动的**（2026-09 用户定）—— auth 只负责判断与跳页，
 *       建行只发生在加入页按下「确认加入」那一下（见 components/profile-form）。
 *
 *    refreshMe 的三态必须分开，否则会把「没问到」当成「没加入」：
 *      · 'joined'       —— 服务端认识我
 *      · 'unregistered' —— 服务端明确说库里没有我（该画「加入」）
 *      · 'unknown'      —— 没问到（画「重新连接」，绝不推去加入页）
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
  setNotRegisteredHandler: () => {},
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly code?: string,
      readonly payload?: Record<string, unknown>,
    ) {
      super(message)
      this.name = 'ApiError'
    }
  },
}))

let store: typeof import('./store')
let join: typeof import('./join')

beforeAll(async () => {
  store = await import('./store')
  join = await import('./join')
})

/** 造一份 /api/user/me 的响应（只填用例关心的字段） */
function meResponse(nickname: string | null) {
  return {
    id: 1,
    nickname,
    avatarUrl: null,
    gender: null,
    age: null,
    bio: null,
    status: 'active',
    energy: 3,
    challengedCount: 0,
    challengedRounds: 0,
    conqueredCount: 0,
    growth: { self: 0, diligence: 0, standout: 0 },
    streak: {
      streakDays: 0,
      streakBest: 0,
      readToday: false,
      unfreezeCards: 0,
      unfreezePending: 0,
      unfreezeExpiresOn: null,
    },
  }
}

async function notRegistered(): Promise<Error> {
  const { ApiError } = (await import('./api/client')) as unknown as {
    ApiError: new (m: string, c?: string) => Error
  }
  return new ApiError('还没有加入句拼', 'NOT_REGISTERED')
}

beforeEach(() => {
  fetchMe.mockReset()
  nav.length = 0
  stack = [{ route: 'pages/index/index' }]
  store.reset()
})

describe('refreshMe —— 「我加入了没有」的三态', () => {
  it('服务端认识我 → joined，并把资料写进 state', async () => {
    fetchMe.mockResolvedValue(meResponse('老用户'))
    await expect(join.refreshMe()).resolves.toBe('joined')
    expect(store.hasJoined()).toBe(true)
  })

  it('服务端明确说库里没有我 → unregistered（并把本机过期快照清掉）', async () => {
    store.applyProfile(meResponse('旧快照') as never)
    fetchMe.mockRejectedValue(await notRegistered())
    await expect(join.refreshMe()).resolves.toBe('unregistered')
    expect(store.hasJoined()).toBe(false)
    expect(store.getState().session).toBe('ready')
  })

  it('⚠️ 问不到 → unknown（与 unregistered 分开，调用方据此决定跳不跳页）', async () => {
    fetchMe.mockRejectedValue(new Error('boom'))
    await expect(join.refreshMe()).resolves.toBe('unknown')
    expect(store.getState().session).toBe('unknown')
  })
})

describe('applyProfilePatch —— 保存接口的返回值直接定「已经有名字」', () => {
  it('⭐ 昵称一写进来就立刻算已加入（不依赖再 GET 一次）', () => {
    expect(store.hasJoined()).toBe(false)
    store.applyProfilePatch({ nickname: '张三', avatarUrl: null, gender: null, age: null, bio: null })
    expect(store.hasJoined()).toBe(true)
    expect(store.getState().userInfo?.nickname).toBe('张三')
  })

  it('⚠️ 只动昵称/头像，已征服数原样留着（保存接口不返回它）', () => {
    const withCount = { ...meResponse('旧名字'), conqueredCount: 7 }
    store.applyProfile(withCount as never)
    store.applyProfilePatch({ nickname: '新名字', avatarUrl: null, gender: null, age: null, bio: null })
    expect(store.getState().userInfo?.conqueredCount).toBe(7)
  })
})

describe('openJoinPage', () => {
  it('⚠️ 已经在加入页上 → 不再压一层（否则返回要按好几次）', () => {
    stack = [{ route: 'pages/index/index' }, { route: 'pages/join/join' }]
    join.openJoinPage()
    expect(nav).toEqual([])
  })

  it('⭐ 服务端明确说库里没有我（403）→ auth 自己把人送到加入页', async () => {
    fetchMe.mockRejectedValue(await notRegistered())
    await expect(join.ensureAuthed()).resolves.toBe('not-joined')
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
  })

  it('⭐⭐ 问不到（超时）→ **不跳加入页**（别把老用户推过去）', async () => {
    fetchMe.mockRejectedValue(new Error('request:fail timeout'))
    await expect(join.ensureAuthed()).resolves.toBe('unknown')
    expect(nav).toEqual([])
  })

  it('在别的页面上 → navigateTo 压上去（这样「确认加入」能返回原页）', () => {
    join.openJoinPage()
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
  })
})

describe('openProfilePage —— 用户面板里的「修改」', () => {
  it('⭐ 去的是修改资料页，不是加入页', async () => {
    // ⚠️ 修改资料是**受保护页**：先让 store 里有一份"已加入"（否则 auth 会先送人去加入页）
    store.applyProfile(meResponse('张三') as never)
    nav.length = 0
    join.openProfilePage()
    // ⚠️ goOnce → go 是 async 的（中间还要过一次 auth）：等它落下来再断言
    await vi.waitFor(() => expect(nav).toEqual(['to:' + join.PROFILE_PAGE]))
    expect(join.PROFILE_PAGE).not.toBe(join.JOIN_PAGE)
  })

  it('⚠️ 已经在那一页上就不再压一层', () => {
    stack = [{ route: 'pages/index/index' }, { route: 'pages/me/edit-user/edit-user' }]
    join.openProfilePage()
    expect(nav).toEqual([])
  })
})
