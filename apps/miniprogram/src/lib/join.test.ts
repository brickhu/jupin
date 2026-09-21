import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ensureJoined 的单测。
 *
 * ⚠️⚠️ 这一版守的是一条产品判断，不是一个工具函数：
 *
 *    「点加入」要区分**两件事** —— 账号已经在服务端（换设备 / 清了缓存）
 *    和账号还不存在。前者必须**直接进去**，后者才谈得上弹加入页。
 *    判错的代价不是报错：老用户会被要求重新认领一次自己，
 *    然后以为成绩没了。所以四种情况逐条钉死。
 */

const memory = new Map<string, unknown>()
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
})

const fetchMe = vi.fn()
vi.mock('./api/client', () => ({
  fetchMe: () => fetchMe(),
}))

let store: typeof import('./store')
let login: typeof import('./join')

beforeAll(async () => {
  store = await import('./store')
  login = await import('./join')
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
  store.reset()
})

describe('ensureJoined', () => {
  it('⭐ 本地已经有昵称 → 直接放行，一次请求都不发', async () => {
    store.applyProfile(meResponse('老用户') as never)
    await expect(login.ensureJoined()).resolves.toBe(true)
    expect(fetchMe).not.toHaveBeenCalled()
    expect(store.getState().joinSheet).toBe(false)
  })

  it('⭐ 本地没有、但服务端认识我 → 直接放行，不弹授权层', async () => {
    fetchMe.mockResolvedValue(meResponse('老用户'))
    await expect(login.ensureJoined()).resolves.toBe(true)
    expect(store.hasJoined()).toBe(true)
    expect(store.getState().joinSheet).toBe(false)
  })

  it('⭐ 服务端也不认识我 → 放行=false 且弹出授权层', async () => {
    fetchMe.mockResolvedValue(meResponse(null))
    await expect(login.ensureJoined()).resolves.toBe(false)
    expect(store.hasJoined()).toBe(false)
    expect(store.getState().joinSheet).toBe(true)
  })

  it('⚠️ 只有空白昵称也算「还没认领」', async () => {
    fetchMe.mockResolvedValue(meResponse('   '))
    await expect(login.ensureJoined()).resolves.toBe(false)
    expect(store.getState().joinSheet).toBe(true)
  })

  it('⚠️ 取资料失败 → 仍然弹授权层，而不是静默什么都不做', async () => {
    fetchMe.mockRejectedValue(new Error('network down'))
    await expect(login.ensureJoined()).resolves.toBe(false)
    expect(store.getState().joinSheet).toBe(true)
  })
})
