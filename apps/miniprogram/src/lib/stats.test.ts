import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「**我刚收藏 / 取消收藏** ⇒ 收藏总量跟着动」的单测。
 *
 * ⚠️⚠️ 为什么值得写：这一格最容易犯的错是**把"没拉到"当成 0**。
 *    用户点了一下星，界面顺手把收藏数写成 1 —— 而那可能是"我们根本没问到服务端"。
 *    所以下面每一条都在盯「什么情况下允许往 store 里写数」。
 */

const memory = new Map<string, unknown>()
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
})

const fetchFavoriteCounts = vi.fn()
vi.mock('./api/client', () => ({
  fetchFavoriteCounts: (ids: string[]) => fetchFavoriteCounts(ids),
  fetchArticleStats: vi.fn(),
}))

let store: typeof import('./store')
let stats: typeof import('./stats')

beforeAll(async () => {
  store = await import('./store')
  stats = await import('./stats')
})

beforeEach(() => {
  vi.clearAllMocks()
})

/** 造一个"已经拉到过"的收藏数（store 是唯一真源，所以直接写 store 就是造场景） */
const known = (articleId: string, n: number) => store.applyFavoriteCounts([{ articleId, favoriteCount: n }])

describe('noteMyFavoriteToggle —— 收藏总量跟着我的动作走', () => {
  it('⭐ 已经知道当前值：收藏 +1、取消 -1，且**不发请求**', () => {
    known('a1', 12)
    stats.noteMyFavoriteToggle('a1', true)
    expect(store.getFavoriteCount('a1')).toBe(13)
    stats.noteMyFavoriteToggle('a1', false)
    expect(store.getFavoriteCount('a1')).toBe(12)
    expect(fetchFavoriteCounts).not.toHaveBeenCalled()
  })

  it('⚠️ 本地减到 0 就停住（不下穿负数）', () => {
    known('a2', 0)
    stats.noteMyFavoriteToggle('a2', false)
    expect(store.getFavoriteCount('a2')).toBe(0)
  })

  it('⭐⭐ 还不知道当前值：**绝不猜**，改为去问服务端', async () => {
    fetchFavoriteCounts.mockResolvedValue({ items: [{ articleId: 'a3', favoriteCount: 7 }] })
    stats.noteMyFavoriteToggle('a3', true)
    // 同步返回时**不许**有任何本地数字
    expect(store.getFavoriteCount('a3')).toBeNull()
    expect(fetchFavoriteCounts).toHaveBeenCalledWith(['a3'])
    await vi.waitFor(() => expect(store.getFavoriteCount('a3')).toBe(7))
  })

  it('⭐⭐ 那一问失败 ⇒ 保持"未知"，不许退化成 0', async () => {
    fetchFavoriteCounts.mockRejectedValue(new Error('offline'))
    stats.noteMyFavoriteToggle('a4', true)
    await vi.waitFor(() => expect(fetchFavoriteCounts).toHaveBeenCalled())
    expect(store.getFavoriteCount('a4')).toBeNull()
  })

  it('空 articleId 直接忽略（页面数据还没就绪时会被调到）', () => {
    stats.noteMyFavoriteToggle('', true)
    expect(fetchFavoriteCounts).not.toHaveBeenCalled()
  })
})
