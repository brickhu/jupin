import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⭐ auth 的单测 —— 守的是**决定能不能动手**的那几条分支。
 *
 * ⚠️ 为什么值得写：这里是全站唯一判断"服务端认不认识我"的地方，
 *    而它的两个失败方向都很贵：
 *      · 该拦没拦 → uid=0 时上传路径非法、成绩没有归属（用户真的白读一遍）；
 *      · 不该拦却拦 → 后端抖一下就把老用户推去加入页，他以为账号没了。
 */

const memory = new Map<string, unknown>()
/** 记录所有跳转 —— 断言"跳没跳、跳到哪" */
const nav: string[] = []
let stack: { route: string }[] = []

vi.stubGlobal('getCurrentPages', () => stack)
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
  navigateTo: (o: { url: string }) => nav.push('to:' + o.url),
  reLaunch: (o: { url: string }) => nav.push('reLaunch:' + o.url),
})

const fetchMe = vi.fn()
const login = vi.fn()
vi.mock('./api/client', () => ({
  fetchMe: () => fetchMe(),
  login: () => login(),
  getUserId: () => Number(memory.get('uid') ?? 0),
  setUserId: (id: number) => memory.set('uid', id),
}))

let store: typeof import('./store')
let auth: typeof import('./auth')

beforeAll(async () => {
  store = await import('./store')
  auth = await import('./auth')
})

/** 造一份能塞进 store 的 /me 响应（只填这个用例关心的字段） */
const profile = (energy = 3) =>
  ({
    id: 7,
    nickname: '张三',
    avatarUrl: null,
    energy,
    conqueredCount: 0,
    challengedCount: 0,
    challengedRounds: 0,
    streak: {},
  }) as never

beforeEach(() => {
  memory.clear()
  nav.length = 0
  stack = []
  fetchMe.mockReset()
  login.mockReset()
  store.reset()
})

describe('isAuthed —— 只读判断，不发请求', () => {
  it('服务端应答过我 → true（判据是账号，与昵称无关）', () => {
    store.applyProfile(profile())
    expect(auth.isAuthed()).toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
  })

  it('从没应答过 → false', () => {
    expect(auth.isAuthed()).toBe(false)
  })
})

describe('ensureAuthed —— 动手前的门禁', () => {
  it('⭐⭐ 已经有身份：一次网络都不发', async () => {
    store.applyProfile(profile())
    await expect(auth.ensureAuthed()).resolves.toBe(true)
    expect(login).not.toHaveBeenCalled()
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('⭐⭐ 还没有身份：静默登录 + 一次 /me（这一步就是注册）', async () => {
    // login() 成功后服务端给出 uid —— 模拟 client 的副作用
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    fetchMe.mockResolvedValue(profile(2))

    await expect(auth.ensureAuthed()).resolves.toBe(true)
    expect(login).toHaveBeenCalledTimes(1)
    expect(fetchMe).toHaveBeenCalledTimes(1)
    // 顺带把资料写回 store（导航栏/面板当场一致）
    expect(store.getState().userInfo?.energy).toBe(2)
    expect(nav).toEqual([])
  })

  it('⭐⭐ 登录失败 → 跳加入页并返回 false（不假装成功）', async () => {
    login.mockRejectedValue(new Error('request:fail timeout'))

    await expect(auth.ensureAuthed()).resolves.toBe(false)
    expect(nav).toEqual(['to:/pages/join/join'])
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('⭐⭐ 登录成功但 /me 问不到 → 跳加入页并返回 false', async () => {
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    fetchMe.mockRejectedValue(new Error('boom'))

    await expect(auth.ensureAuthed()).resolves.toBe(false)
    expect(nav).toEqual(['to:/pages/join/join'])
    // ⚠️ 失败也要把"身份解析结束"标记上，否则导航栏永远转圈
    expect(store.getState().session).toBe('ready')
  })

  it('⚠️ 已经在加入页上 → 不再压一层（返回要按好几次）', async () => {
    stack = [{ route: 'pages/join/join' }]
    login.mockRejectedValue(new Error('boom'))
    await auth.ensureAuthed()
    expect(nav).toEqual([])
  })

  it('needProfile：已有身份但要顺带拿资料时补一次 /me', async () => {
    store.applyProfile(profile(5))
    fetchMe.mockResolvedValue(profile(1))
    await expect(auth.ensureAuthed({ needProfile: true })).resolves.toBe(true)
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(store.getState().userInfo?.energy).toBe(1)
  })
})

describe('requireIdentity —— 表单保存那条路（失败抛人话，不跳页）', () => {
  it('已经有 uid → 直接过，不发请求', async () => {
    memory.set('uid', 7)
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(login).not.toHaveBeenCalled()
  })

  it('没有 uid → 登录一次', async () => {
    login.mockImplementation(() => {
      memory.set('uid', 9)
    })
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(login).toHaveBeenCalledTimes(1)
    expect(nav).toEqual([])
  })

  it('⚠️ 登录失败 → 抛一句人话，且**不跳页**（加入页正是目的地，跳了就死循环）', async () => {
    login.mockRejectedValue(new Error('request:fail'))
    await expect(auth.requireIdentity()).rejects.toThrow('没连上服务器')
    expect(nav).toEqual([])
  })
})
