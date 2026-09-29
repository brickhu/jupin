import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⭐ auth 的单测 —— 守的是**决定能不能动手**的那几条分支。
 *
 * ⚠️ 为什么值得写：这里是全站唯一判断"服务端认不认识我"的地方，
 *    而它的两个失败方向都很贵：
 *      · 该拦没拦 → uid=0 时上传路径非法、成绩没有归属（用户真的白读一遍）；
 *      · 不该拦却拦 → 后端抖一下就把老用户推去加入页，他以为账号没了。
 *
 * ⚠️⚠️ 2026-09 起还有第三条，比上面两条都要紧：**auth 绝不注册**。
 *    注册只能由加入页那一次显式动作触发（见 components/profile-form）。
 *    所以这里所有用例都断言 `login` 没被调用。
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
vi.mock('./api/client', () => ({
  fetchMe: () => fetchMe(),
  /** auth 在模块初始化时注册「服务端说未注册」的回调 —— 单测里不需要它干活 */
  setNotRegisteredHandler: () => {},
  /**
   * ⚠️ 真的 ApiError 只多一个 `code` —— auth 就是靠它区分
   *    「服务端明确说库里没我（403 NOT_REGISTERED）」与「根本没问到（超时/没网）」。
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

/** 「已经加入」= 服务端那一行在（本机判据是 userInfo，见 lib/auth） */
function becomeAuthed(profileEnergy: number | null = 3): void {
  if (profileEnergy !== null) store.applyProfile(profile(profileEnergy))
}

/** 造一个服务端明确回答「还没加入句拼」的错误 */
async function notRegistered(): Promise<Error> {
  const { ApiError } = (await import('./api/client')) as unknown as {
    ApiError: new (m: string, c?: string) => Error
  }
  return new ApiError('还没有加入句拼', 'NOT_REGISTERED')
}

beforeEach(() => {
  memory.clear()
  nav.length = 0
  stack = []
  fetchMe.mockReset()
  store.reset()
})

describe('isAuthed —— 只读判断，不发请求', () => {
  it('服务端应答过我 → true（判据是账号，与昵称无关）', () => {
    becomeAuthed()
    expect(auth.isAuthed()).toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('从没应答过 → false', () => {
    expect(auth.isAuthed()).toBe(false)
  })

  it('⭐⭐ 服务端明确说"库里没我"之后 → false，且不再是 pending', () => {
    becomeAuthed()
    store.clearIdentity()
    expect(auth.isAuthed()).toBe(false)
    // ⚠️ ready（服务端答复过）而不是 pending —— 界面该画「加入」，不是继续转圈
    expect(store.getState().session).toBe('ready')
  })
})

describe('ensureAuthed —— 动手前的门禁（它绝不注册）', () => {
  it('⭐⭐ 已经加入：一次网络都不发', async () => {
    becomeAuthed()
    await expect(auth.ensureAuthed()).resolves.toBe('joined')
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('⭐⭐ 已知"还没加入"（session ready）：一次网络都不发，直接跳加入页', async () => {
    store.clearIdentity()
    await expect(auth.ensureAuthed()).resolves.toBe('not-joined')
    expect(fetchMe).not.toHaveBeenCalled()
    expect(nav).toEqual(['to:/pages/join/join'])
  })

  it('⭐⭐ 还没问过、服务端说已加入 → joined（并把资料写回 store）', async () => {
    fetchMe.mockResolvedValue(profile(2))
    await expect(auth.ensureAuthed()).resolves.toBe('joined')
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(store.getState().userInfo?.energy).toBe(2)
    expect(nav).toEqual([])
  })

  it('⭐⭐⭐ 服务端明确回 403 NOT_REGISTERED → "未加入"，跳加入页', async () => {
    fetchMe.mockRejectedValue(await notRegistered())

    await expect(auth.ensureAuthed()).resolves.toBe('not-joined')
    expect(nav).toEqual(['to:/pages/join/join'])
    // ⚠️ 服务端给了答复 ⇒ ready；库里没有我 ⇒ userInfo 必须为 null
    expect(store.getState().session).toBe('ready')
    expect(store.hasJoined()).toBe(false)
  })

  it('⭐⭐⭐ /me 超时（没问到）→ **不跳加入页**，返回 unknown 并标成 unknown', async () => {
    fetchMe.mockRejectedValue(new Error('request:fail timeout'))

    await expect(auth.ensureAuthed()).resolves.toBe('unknown')
    expect(nav).toEqual([])
    expect(store.getState().session).toBe('unknown')
  })

  it('⚠️ 已经在加入页上 → 不再压一层（返回要按好几次）', async () => {
    stack = [{ route: 'pages/join/join' }]
    fetchMe.mockRejectedValue(await notRegistered())
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

  it('needProfile：已加入但 /me 断网 → unknown，**不跳加入页**', async () => {
    becomeAuthed()
    fetchMe.mockRejectedValue(new Error('boom'))
    await expect(auth.ensureAuthed({ needProfile: true })).resolves.toBe('unknown')
    expect(nav).toEqual([])
  })
})

describe('retryAuth —— 用户明确要加入', () => {
  it('已加入：什么都不做', async () => {
    becomeAuthed()
    await auth.retryAuth()
    expect(nav).toEqual([])
  })

  it('服务端说未加入 → 去加入页', async () => {
    fetchMe.mockRejectedValue(await notRegistered())
    await auth.retryAuth()
    expect(nav).toEqual(['to:/pages/join/join'])
  })

  it('⚠️ 问不到也去加入页（他自己按的「加入」，不是被误判）', async () => {
    fetchMe.mockRejectedValue(new Error('request:fail'))
    await auth.retryAuth()
    expect(nav).toEqual(['to:/pages/join/join'])
  })
})

describe('requireIdentity —— 表单保存那条路（失败抛人话，不跳页）', () => {
  it('已经有记录 → 直接过，不发请求', async () => {
    becomeAuthed()
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(fetchMe).not.toHaveBeenCalled()
  })

  it('本机没缓存但服务端其实有 → 问一次就过', async () => {
    fetchMe.mockResolvedValue(profile(3))
    await expect(auth.requireIdentity()).resolves.toBeUndefined()
    expect(fetchMe).toHaveBeenCalledTimes(1)
    expect(nav).toEqual([])
  })

  it('⚠️ 确实没加入 → 抛一句人话，且**不跳页**（加入页正是目的地，跳了就死循环）', async () => {
    fetchMe.mockRejectedValue(await notRegistered())
    await expect(auth.requireIdentity()).rejects.toThrow('检查网络后再点一次')
    expect(nav).toEqual([])
  })
})
