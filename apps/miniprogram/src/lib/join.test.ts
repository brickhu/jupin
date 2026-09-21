import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ensureJoined / openJoinPage 的单测。
 *
 * ⚠️⚠️ 这一版守的是一条产品判断，不是一个工具函数：
 *
 *    「点加入」要区分**两件事** —— 账号已经在服务端（换设备 / 清了缓存）
 *    和账号还不存在。前者必须**直接进去**，后者才谈得上跳加入页。
 *    判错的代价不是报错：老用户会被要求重新认领一次自己，
 *    然后以为成绩没了。所以四种情况逐条钉死。
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
    attemptsPerSentence: 1,
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

describe('ensureJoined', () => {
  it('⭐ 本地已经有昵称 → 直接放行，一次请求都不发', async () => {
    store.applyProfile(meResponse('老用户') as never)
    await expect(join.ensureJoined()).resolves.toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(nav).toEqual([])
  })

  it('⭐ 本地没有、但服务端认识我 → 直接放行，不跳加入页', async () => {
    fetchMe.mockResolvedValue(meResponse('老用户'))
    await expect(join.ensureJoined()).resolves.toBe(true)
    expect(store.hasJoined()).toBe(true)
    expect(nav).toEqual([])
  })

  it('⭐ 服务端也不认识我 → 放行=false 且跳加入页', async () => {
    fetchMe.mockResolvedValue(meResponse(null))
    await expect(join.ensureJoined()).resolves.toBe(false)
    expect(store.hasJoined()).toBe(false)
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
  })

  it('⚠️ 只有空白昵称也算「还没认领」', async () => {
    fetchMe.mockResolvedValue(meResponse('   '))
    await expect(join.ensureJoined()).resolves.toBe(false)
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
  })

  it('⚠️ 取资料失败 → 仍然跳加入页，而不是静默什么都不做', async () => {
    fetchMe.mockRejectedValue(new Error('network down'))
    await expect(join.ensureJoined()).resolves.toBe(false)
    expect(nav).toEqual(['to:' + join.JOIN_PAGE])
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
