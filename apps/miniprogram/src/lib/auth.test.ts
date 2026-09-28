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
  /**
   * ⚠️ 真的 ApiError 只多一个 `code` —— auth 就是靠它区分
   *    「服务端明确说认不出我（401）」与「根本没问到（超时/没网）」。
   */
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
let auth: typeof import('./auth')

beforeAll(async () => {
  store = await import('./store')
  auth = await import('./auth')
})

/**
 * ⭐ 「已经有账号」= 本机有 uid（端侧唯一判据，见 lib/auth）+
 *    可选地把资料也补上（画界面 / 拿权威余额用）。
 * ⚠️ uid 与 userInfo 是两件事：**登录成功但 /me 断网**时只有前者 —— 那也是"有账号"。
 */
function becomeAuthed(profileEnergy: number | null = 3): void {
  memory.set('uid', 7)
  if (profileEnergy !== null) store.applyProfile(profile(profileEnergy))
}

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
    becomeAuthed()
    expect(auth.isAuthed()).toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
  })

  it('⭐⭐ 只有 uid、还没问到资料 → 不算"有记录"（判据是服务端那一行，不是 uid）', () => {
    becomeAuthed(null)
    expect(auth.isAuthed()).toBe(false)
    // ⚠️ 但也不是"没记录"：问不到时是 unknown（header 画「重新连接」，不画「加入」）
    store.markSessionUnknown()
    expect(store.getState().session).toBe('unknown')
  })

  it('从没应答过 → false', () => {
    expect(auth.isAuthed()).toBe(false)
  })
})

describe('ensureAuthed —— 动手前的门禁', () => {
  it('⭐⭐ 已经有身份：一次网络都不发', async () => {
    becomeAuthed()
    await expect(auth.ensureAuthed()).resolves.toBe('joined')
    expect(login).not.toHaveBeenCalled()
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('⭐⭐ 还没有身份：静默登录 + 一次 /me（这一步就是注册）', async () => {
    // login() 成功后服务端给出 uid —— 模拟 client 的副作用
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    fetchMe.mockResolvedValue(profile(2))

    await expect(auth.ensureAuthed()).resolves.toBe('joined')
    expect(login).toHaveBeenCalledTimes(1)
    expect(fetchMe).toHaveBeenCalledTimes(1)
    // 顺带把资料写回 store（导航栏/面板当场一致）
    expect(store.getState().userInfo?.energy).toBe(2)
    expect(nav).toEqual([])
  })

  it('⭐⭐⭐ 登录失败（没问到）→ **不跳加入页**，返回 unknown', async () => {
    login.mockRejectedValue(new Error('request:fail timeout'))

    await expect(auth.ensureAuthed()).resolves.toBe('unknown')
    expect(nav).toEqual([])
    expect(fetchMe).not.toHaveBeenCalled()
    // ⚠️ 也不能标成 ready（那会让 header 画出假的「加入」）
    expect(store.getState().session).toBe('unknown')
  })

  it('⭐⭐⭐ 登录成功、但 /me 断网 → 仍然算有账号（不许把老用户推去加入页）', async () => {
    becomeAuthed()
    fetchMe.mockRejectedValue(new Error('boom'))
    // 有账号：needProfile 时 /me 失败 = 拿不到余额，但**身份是有的**
    await expect(auth.ensureAuthed({ needProfile: true })).resolves.toBe('unknown')
    // ⚠️ 返回 unknown 只表示"没拿到资料"；**绝不能跳加入页**（那会让人以为账号没了）
    expect(nav).toEqual([])
  })

  it('⭐⭐⭐ /me 明确回 401（服务端说认不出我）→ 这才是"未加入"，跳加入页', async () => {
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    const { ApiError } = (await import('./api/client')) as unknown as {
      ApiError: new (m: string, c?: string) => Error
    }
    fetchMe.mockRejectedValue(new ApiError('未登录', 'AUTH_EXPIRED'))

    await expect(auth.ensureAuthed()).resolves.toBe('not-joined')
    expect(nav).toEqual(['to:/pages/join/join'])
    expect(store.getState().session).toBe('ready')
  })

  it('⭐⭐⭐ /me 超时（没问到）→ **不跳加入页**，返回 unknown 并标成 unknown', async () => {
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    fetchMe.mockRejectedValue(new Error('request:fail timeout'))

    await expect(auth.ensureAuthed()).resolves.toBe('unknown')
    expect(nav).toEqual([])
    expect(store.getState().session).toBe('unknown')
  })

  it('⚠️ 已经在加入页上 → 不再压一层（返回要按好几次）', async () => {
    stack = [{ route: 'pages/join/join' }]
    login.mockImplementation(() => {
      memory.set('uid', 7)
    })
    const { ApiError } = (await import('./api/client')) as unknown as {
      ApiError: new (m: string, c?: string) => Error
    }
    fetchMe.mockRejectedValue(new ApiError('未登录', 'AUTH_EXPIRED'))
    await auth.ensureAuthed()
    expect(nav).toEqual([])
  })

  it('needProfile：已有身份但要顺带拿资料时补一次 /me', async () => {
    becomeAuthed(5)
    fetchMe.mockResolvedValue(profile(1))
    await expect(auth.ensureAuthed({ needProfile: true })).resolves.toBe('joined')
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(store.getState().userInfo?.energy).toBe(1)
  })
})

describe('requireIdentity —— 表单保存那条路（失败抛人话，不跳页）', () => {
  it('已经有记录 → 直接过，不发请求', async () => {
    becomeAuthed()
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(login).not.toHaveBeenCalled()
  })

  it('还没记录 → 登录一次 + 问一次 /me', async () => {
    login.mockImplementation(() => {
      memory.set('uid', 9)
    })
    fetchMe.mockResolvedValue(profile(3))
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(login).toHaveBeenCalledTimes(1)
    expect(nav).toEqual([])
  })

  it('⚠️ 登录失败 → 抛一句人话，且**不跳页**（加入页正是目的地，跳了就死循环）', async () => {
    login.mockRejectedValue(new Error('request:fail'))
    await expect(auth.requireIdentity()).rejects.toThrow('检查网络后再点一次')
    expect(nav).toEqual([])
  })
})
