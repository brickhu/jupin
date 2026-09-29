import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * participation 取数入口的单测 —— 守「一句的参与状态」这一条链路的**三态**。
 *
 * ⚠️⚠️ 为什么值得写：这里最容易犯的错是把**"没问到"当成"没参与过"** ——
 *    一次断网就会让界面肯定地告诉用户"你还没参与过"，而真相是"我们不知道"。
 *    所以下面每一条都在盯「什么情况下允许写 null」。
 */

const memory = new Map<string, unknown>()
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
})

const fetchParticipation = vi.fn()
vi.mock('./api/client', () => ({
  fetchParticipation: (id: string) => fetchParticipation(id),
}))
/** 只替掉一个判据函数 —— 别把整条 auth→route→auth 的模块图拉进单测 */
vi.mock('./auth', () => ({
  isUnregistered: (e: unknown) => (e as { code?: string })?.code === 'NOT_REGISTERED',
}))

let store: typeof import('./store')
let participation: typeof import('./participation')

beforeAll(async () => {
  store = await import('./store')
  participation = await import('./participation')
})

/** 一份能塞进 store 的 /me 响应（表示"已经加入"） */
const profile = () =>
  ({
    id: 7,
    nickname: '张三',
    avatarUrl: null,
    energy: 3,
    conqueredCount: 0,
    challengedCount: 0,
    challengedRounds: 0,
    growth: { self: 0, diligence: 0, standout: 0 },
    streak: {},
  }) as never

const record = (articleId: string) =>
  ({
    articleId,
    attempts: 2,
    bestScore: 88,
    worstScore: 60,
    rank: 2,
    participantCount: 9,
    lastAt: '2026-09-29T00:00:00.000Z',
    words: [],
    links: [],
    theme: null,
  }) as never

beforeEach(() => {
  memory.clear()
  fetchParticipation.mockReset()
  store.reset()
})

describe('loadParticipation —— 三态与"不写不该写的"', () => {
  it('⭐⭐ 未加入句拼（session ready + 没有 userInfo）→ 直接落 null，**一次请求都不发**', async () => {
    store.clearIdentity() // session = ready、userInfo = null ⇒ 服务端明确说过"库里没有我"
    await participation.loadParticipation('a1')
    expect(fetchParticipation).not.toHaveBeenCalled()
    expect(store.participationOf('a1')).toEqual({ loaded: true, record: null })
  })

  it('⭐⭐ 身份还未知（pending/unknown）→ **什么都不写、也不请求**（别把"不知道"说成"没参与"）', async () => {
    // 新 store 的初始态就是 pending
    await participation.loadParticipation('a2')
    expect(fetchParticipation).not.toHaveBeenCalled()
    expect(store.participationOf('a2').loaded).toBe(false)
  })

  it('⭐ 已加入 → 请求一次，记录写进 store', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockResolvedValue(record('a3'))
    await participation.loadParticipation('a3')
    expect(fetchParticipation).toHaveBeenCalledWith('a3')
    expect(store.participationOf('a3').record?.bestScore).toBe(88)
  })

  it('⭐ 服务端明确说这一句没参与过（data: null）→ 落一条**结论**', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockResolvedValue(null)
    await participation.loadParticipation('a4')
    expect(store.participationOf('a4')).toEqual({ loaded: true, record: null })
  })

  it('⭐⭐ 断网 / 超时 → **键保持不存在**（未知），下次还会再试', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockRejectedValue(new Error('request:fail timeout'))
    await participation.loadParticipation('a5')
    expect(store.participationOf('a5').loaded).toBe(false)
  })

  it('⭐ 403 NOT_REGISTERED（账号在服务端没了）→ 按"没参与过"落库', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockRejectedValue({ code: 'NOT_REGISTERED' })
    await participation.loadParticipation('a6')
    expect(store.participationOf('a6')).toEqual({ loaded: true, record: null })
  })

  it('⚠️ 同一句并发调多次 → 只打一次请求（今日卡与 onShow 会同时问）', async () => {
    store.applyProfile(profile())
    let resolve!: (v: unknown) => void
    fetchParticipation.mockImplementation(() => new Promise((r) => (resolve = r)))
    const p1 = participation.loadParticipation('a7')
    const p2 = participation.loadParticipation('a7')
    resolve(record('a7'))
    await Promise.all([p1, p2])
    expect(fetchParticipation).toHaveBeenCalledTimes(1)
  })
})

describe('ensureParticipation —— 列表批量版（所有句子列表都走这条）', () => {
  it('⭐ 一批句子各自拉一次，全部写进 store（一次 commit 写完整批）', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockImplementation((id: string) => Promise.resolve(record(id)))
    await participation.ensureParticipation(['b1', 'b2', 'b3'])
    expect(fetchParticipation).toHaveBeenCalledTimes(3)
    expect(store.participationOf('b1').record?.articleId).toBe('b1')
    expect(store.participationOf('b2').record?.articleId).toBe('b2')
    expect(store.participationOf('b3').record?.articleId).toBe('b3')
  })

  it('⚠️ 已经拉过的句子不再问（store 就是缓存）', async () => {
    store.applyProfile(profile())
    store.applyParticipation('b4', record('b4'))
    fetchParticipation.mockResolvedValue(record('b5'))
    await participation.ensureParticipation(['b4', 'b5'])
    expect(fetchParticipation).toHaveBeenCalledTimes(1)
    expect(fetchParticipation).toHaveBeenCalledWith('b5')
  })

  it('⭐⭐ 未加入句拼 → **一个请求都不发**，整批按"没参与过"落库', async () => {
    store.clearIdentity() // session ready + userInfo null
    await participation.ensureParticipation(['b6', 'b7'])
    expect(fetchParticipation).not.toHaveBeenCalled()
    expect(store.participationOf('b6')).toEqual({ loaded: true, record: null })
    expect(store.participationOf('b7')).toEqual({ loaded: true, record: null })
  })

  it('⭐⭐ 其中一句问不到 → 只有它保持未知，其余照常落库', async () => {
    store.applyProfile(profile())
    fetchParticipation.mockImplementation((id: string) =>
      id === 'b9' ? Promise.reject(new Error('timeout')) : Promise.resolve(record(id)),
    )
    await participation.ensureParticipation(['b8', 'b9', 'b10'])
    expect(store.participationOf('b8').loaded).toBe(true)
    expect(store.participationOf('b10').loaded).toBe(true)
    // ⚠️ 断网那一句**不能**写成"没参与过"
    expect(store.participationOf('b9').loaded).toBe(false)
  })

  it('⚠️ 并发上限 4：一屏 7 句也不会一次打出 7 个并发', async () => {
    store.applyProfile(profile())
    let running = 0
    let peak = 0
    fetchParticipation.mockImplementation(async (id: string) => {
      running++
      peak = Math.max(peak, running)
      // 让出一次微任务：制造"同时在飞"的窗口，否则测不出并发数
      await Promise.resolve()
      running--
      return record(id)
    })
    await participation.ensureParticipation(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
    expect(peak).toBeLessThanOrEqual(4)
    // ⚠️ 也要确认它**不是串行**（串行的话上限就白设了，一屏要等 7 个往返）
    expect(peak).toBeGreaterThan(1)
    expect(store.participationOf('c7').loaded).toBe(true)
  })
})
