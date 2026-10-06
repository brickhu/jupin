import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { today } from '@jushuo/shared'

/**
 * store 的单测。
 *
 * ⚠️⚠️ 这一版守的核心是**键必须是句子，不是日期**。
 *
 *    竞技数据跟着句子走，与日期无关（见 services/leaderboard.ts）。
 *    按日期存会坏在两个地方，两个都真实发生过：
 *      · 同一句排在多天 → 同一份战绩被复制成好几份，写一份其余几份不对
 *      · 客户端的日期来自 URL、服务端来自自己的时钟 → 差一个字符就永远匹配不上
 *    两者的表现都是「提交完，参与状态不刷新」。
 */

const memory = new Map<string, unknown>()
vi.stubGlobal('wx', {
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
})

let store: typeof import('./store')

beforeAll(async () => {
  store = await import('./store')
})

const STREAK = {
  streakDays: 3,
  streakBest: 3,
  unfreezeExpiresOn: null,
  readToday: true,
}

/**
 * 造一张句库卡片。
 * ⚠️ 卡片是**纯句子数据**（见 ArticleCard 的头注释）：日期/今天这类上下文
 *    已经移到响应信封上，所以这里**没有** date / isToday。
 * ⚠️ `myBest` / `myAttempts` 是**故意留下的诱饵**：它们不在 ArticleCard 契约里，
 *    下面那条测试正是要证明 applyLatestCards **不会**拿它们去填"我的战绩"
 *    （那一格现在只由 /api/user/participation/{articleId} 写，见 lib/participation.ts）。
 */
function entry(articleId: string, myBest: number | null = null, myAttempts = 0) {
  return {
    articleId,
    text: 'x',
    translation: 'x',
    participantCount: 5,
    topScore: 80,
    myBest,
    myAttempts,
  }
}

/**
 * ⚠️ 夹具要**照着契约**来：公开列表接口（`/api/articles/latest`）
 *    **不含「今日」那一句**（它由公开接口 `/api/articles/today` 给，见 LatestCardsResponse）。
 *    这里曾经塞过 `today`，而 `as never` 把类型检查绕过去了 ——
 *    夹具"模仿了一个不存在的契约"，最容易误导后来人。
 * ⚠️ 带 `date`（服务端的今天）—— 端侧拿它判"这份缓存是不是今天的"。
 */
function listResponse(items: unknown[] = []) {
  // ⚠️ 形状跟着接口走：`GET /api/articles/latest` → `{ date, items }`
  //    （原来是 `/api/schedules` 的 `{ date, streak, latest }`，那条接口已删除）
  return { date: today(), items } as never
}

beforeEach(() => {
  memory.clear()
  store.reset()
})

/**
 * ⚠️⚠️ 这里原来是 applyArenaRecords 那一组（批量「我在这几句上的战绩」）。
 *    那条接口（`/api/user/arena-records`）2026-09 已删 —— 战绩改由
 *    `/api/user/participation/{articleId}` 按句子单独取（见上面「参与状态」那一组）。
 */
describe('公开接口不碰「我的」那一格', () => {
  it('⭐ 公开列表接口（applyLatestCards）不再碰 participation / streak —— 它只带公开数据', () => {
      store.applyLatestCards(listResponse([entry('3')]))
    expect(store.getState().participation).toEqual({})
    expect(store.getState().userInfo?.streak ?? null).toBeNull()
  })
})

/**
 * ⚠️⚠️ 这一组现在**只测 streak 那一半**（2026-09 改）。
 *    原来这里还断言"打完分端侧自己把 myBest/myAttempts 加起来"——那套（store.arena）
 *    连同 arena-records 接口一起删了：战绩是**参与记录**的事，由服务端说了算，
 *    端侧只在提交后把那一句标成"未知"、下次页面读它时重新拉
 *    （见上面「参与状态」那一组的最后两条用例）。
 */
describe('applySubmissionResult —— streak 那一半（战绩不再由端侧累加）', () => {
  it('streak 用服务端给的，端侧一个数都不算', () => {
    store.applySubmissionResult({
      articleId: '3',
      score: 70,
      streak: { streakDays: 9, streakBest: 9, counted: true, delta: 1 },
    })
    expect(store.getState().userInfo?.streak?.streakDays).toBe(9)
  })

  it('服务端没给 streak 时保留旧值，不要清空', () => {
    // ⚠️ streak 的写入方是 /api/user/me（applyProfile），不是公开列表
    store.applyProfile({
      id: 7,
      nickname: null,
      avatarUrl: null,
      conqueredCount: 0,
      challengedCount: 0,
      challengedRounds: 0,
      energy: 0,
      growth: { self: 0, diligence: 0, standout: 0 },
      streak: STREAK,
    } as never)
    store.applySubmissionResult({ articleId: '3', score: 70 })
    expect(store.getState().userInfo?.streak?.streakDays).toBe(3)
  })
})
// ⚠️ 放在「订阅」前面：那一组里有一个故意抛异常的订阅者不退订，
//    它会让后面每一次 commit 都吐一行 console.error（不影响结果，但没必要把日志搞脏）。
// ⚠️ 放在「订阅」前面：那一组里有一个故意抛异常的订阅者不退订，
//    它会让后面每一次 commit 都吐一行 console.error（不影响结果，但没必要把日志搞脏）。
describe('hasJoined —— 「加入」的判据是账号，不是昵称', () => {
  const profile = (nickname: string | null) =>
    ({
      id: 7,
      nickname,
      avatarUrl: null,
      conqueredCount: 0,
      challengedCount: 0,
      challengedRounds: 0,
      streak: STREAK,
    }) as never

  it('⭐ 服务端一次都没应答过 → 还没加入', () => {
    expect(store.hasJoined()).toBe(false)
  })

  it('⭐⭐ 有账号、但还没起名字 → 已经加入（这正是曾经被搞错的那一格）', () => {
    store.applyProfile(profile(null))
    expect(store.hasJoined()).toBe(true)
  })

  it('起了名字 → 当然也是已加入', () => {
    store.applyProfile(profile('张三'))
    expect(store.hasJoined()).toBe(true)
  })
})

describe('订阅', () => {
  it('写入时通知订阅者', () => {
    const seen: number[] = []
    const off = store.subscribe((s) => seen.push(s.latestCards ? 1 : 0))
    // ⚠️ 公开列表的写入方是 applyLatestCards（它不再碰「我的」那一格）
    store.applyLatestCards(listResponse([entry('3')]))
    store.applySubmissionResult({ articleId: '3', score: 2 })
    expect(seen).toEqual([1, 1])
    off()
  })

  it('⚠️ 退订之后不能再回调 —— 页面销毁后回调会 setData 报错', () => {
    const fn = vi.fn()
    const off = store.subscribe(fn)
    off()
    store.applySubmissionResult({ articleId: '3', score: 1 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('⚠️ 一个订阅者抛异常：不影响其它订阅者，但必须**报出来**', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = vi.fn()
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.subscribe(good)
    store.applySubmissionResult({ articleId: '3', score: 1 })
    expect(good).toHaveBeenCalled()
    // ⚠️ 被吞掉的话，症状是「数据变了界面不动」，而没有任何东西看起来是坏的
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('cachedLatestCards —— 冷启动首屏的缓存（跨天必须丢掉）', () => {
  it('同一天能把上次那一屏取回来', () => {
    const res = { date: today(), items: [] } as never
    store.applyLatestCards(res)
    expect(store.cachedLatestCards()).toEqual(res)
  })

  it('⚠️ 跨天一律 null —— 拿昨天那句当「今日挑战」画出来，点进去还是昨天那句', () => {
    store.applyLatestCards({ date: '2000-01-01', items: [] } as never)
    expect(store.cachedLatestCards()).toBeNull()
  })

  it('从没拉到过也是 null', () => {
    expect(store.cachedLatestCards()).toBeNull()
  })
})

describe('cachedToday —— 今日挑战卡的首屏缓存（同样按 date 判过期）', () => {
  it('同一天能把上次那张卡取回来', () => {
    const res = { date: today(), item: { articleId: '3' } } as never
    store.applyToday(res)
    expect(store.cachedToday()).toEqual(res)
  })

  it('⚠️ 跨天一律 null —— 昨天那句不能当今天的「今日挑战」', () => {
    store.applyToday({ date: '2000-01-01', item: { articleId: '3' } } as never)
    expect(store.cachedToday()).toBeNull()
  })

  it('从没拿到过也是 null', () => {
    expect(store.cachedToday()).toBeNull()
  })
})

describe('参与状态（participation）—— 按句子存 /api/user/participation 的返回', () => {
  /** 造一条参与记录（只填这组用例关心的字段） */
  const record = (attempts = 2, bestScore: number | null = 88) =>
    ({
      articleId: '3',
      attempts,
      bestScore,
      worstScore: 60,
      rank: 2,
      participantCount: 9,
      lastAt: '2026-09-29T00:00:00.000Z',
      words: [],
      links: [],
      theme: null,
    }) as never

  it('⭐ 写入一条参与记录，读回来就是它', () => {
    store.applyParticipation('3', record())
    const got = store.participationOf('3')
    expect(got.loaded).toBe(true)
    expect(got.record?.bestScore).toBe(88)
  })

  it('⭐⭐ 三态必须分得开：没拉过 / 明确没参与 / 有记录', () => {
    // ① 没拉过 —— loaded=false（未知，界面不该下"你没参与过"的结论）
    expect(store.participationOf('3')).toEqual({ loaded: false, record: null })
    // ② 拉到了、服务端说没参与 —— loaded=true + null（这才是结论）
    store.applyParticipation('3', null)
    expect(store.participationOf('3')).toEqual({ loaded: true, record: null })
    // ③ 有记录
    store.applyParticipation('3', record())
    expect(store.participationOf('3').record?.attempts).toBe(2)
  })

  it('⚠️ 打分成功后把这一句标回"未知"（删键）—— 旧快照会让按钮停在旧状态', () => {
    store.applyParticipation('3', record(1, 70))
    store.applySubmissionResult({ articleId: '3', score: 90 })
    expect(store.participationOf('3').loaded).toBe(false)
  })

  it('⚠️ 身份被清掉时参与记录跟着清 —— 它是"我的"数据', () => {
    store.applyParticipation('3', record())
    store.clearIdentity()
    expect(store.participationOf('3').loaded).toBe(false)
  })

  it('⚠️ 参与记录落 storage：冷启动 hydrate 能读回来（首帧就有参与状态）', () => {
    store.applyParticipation('3', record())
    // ⚠️ 不能 reset()（它会 persist 一份空状态把刚写的覆盖掉）——见 hydrate 那组用例
    expect(memory.get('me_state_v3')).toBeTruthy()
  })
})

/**
 * ⭐⭐ 统计（`/api/stats/*`）在 store 里的两格 —— **参与统计 + 收藏总量**。
 *
 * ⚠️⚠️ 这一组的重点是**"全局响应式"**：取数写进 store，订阅者（= 页面）
 *    立刻拿到新值并自己重画 —— 页面**不需要**在本地存一份。
 *    两个写入口（applyArticleStats / applyFavoriteCounts）走的是同一个 commit，
 *    所以"谁能响应"这件事对两块是同一套机制。
 */
describe('统计（stats）—— 全局 store + 广播', () => {
  it('⭐ 收藏总量：写进去、读回来（`0` 是答案，不是"没拿到"）', () => {
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 0 }])
    expect(store.getFavoriteCount('3')).toBe(0)
  })

  it('⚠️ 没拉到与"0 人收藏"必须分开：键不存在回 null', () => {
    expect(store.getFavoriteCount('999')).toBeNull()
  })

  it('⭐⭐ 写入会广播给订阅者（页面据此重画 —— 这就是"全局响应式"）', () => {
    const seen: (number | null)[] = []
    const off = store.subscribe((s) => seen.push(s.articleFavoriteCounts['3'] ?? null))
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 5 }])
    // ⚠️ 一次 commit 一次通知，值就是新的那个
    expect(seen).toEqual([5])
    off()
  })

  it('⭐ 参与统计同一套机制：写进去就能读到', () => {
    store.applyArticleStats([
      { articleId: '3', participantCount: 7, topScore: 90, lowestScore: 61 },
    ] as never)
    expect(store.getArticleStats('3')?.participantCount).toBe(7)
  })

  /**
   * ⭐⭐⭐ 这条是**自激循环的结构性防线**（2026-09 真实事故：
   *    首页在 store 订阅回调里调 `ensureStats` → 写 store → `commit` → 广播 →
   *    回调 → 再拉 …… 无限请求 `/api/stats/*`）。
   *
   *    ⇒ 写入端必须做到：**值一模一样就不 commit、不广播**。
   *      于是"每次都重新拉"的统计在"拉回来发现没变"（常态）时不会激起下一轮。
   *    ⚠️ 但它只是**防线**，不是许可证：值真的变了照样广播，
   *      所以"订阅回调里不许取数"那条铁律仍然要守（见 store 的 subscribe 注释）。
   */
  it('⭐⭐⭐ 值没变就不广播；值变了照常广播', () => {
    const stats = { articleId: '3', participantCount: 7, topScore: 90, lowestScore: 61 }
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 5 }])
    store.applyArticleStats([stats] as never)

    const fn = vi.fn()
    const off = store.subscribe(fn)
    // 同样的一组值再写一遍 —— 一次广播都不该有
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 5 }])
    store.applyArticleStats([stats] as never)
    expect(fn, '值没变却广播了 —— 订阅里取数就会自激').not.toHaveBeenCalled()

    // 值真的变了 → 照常广播（各一次）
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 6 }])
    store.applyArticleStats([{ ...stats, participantCount: 8 }] as never)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
  })

  it('⚠️ 两块统计都**不落 storage**（会话级：值会随别人参与 / 收藏而变）', () => {
    store.applyFavoriteCounts([{ articleId: '3', favoriteCount: 5 }])
    store.applyArticleStats([
      { articleId: '3', participantCount: 7, topScore: 90, lowestScore: 61 },
    ] as never)
    const raw = memory.get('me_state_v3') as Record<string, unknown>
    expect(raw.articleFavoriteCounts, '收藏统计不该被持久化').toBeUndefined()
    expect(raw.articleStats, '参与统计不该被持久化').toBeUndefined()
  })
})

describe('hydrate —— 冷启动读回上次的战绩', () => {
  it('读回后订阅者立刻拿到数据，首帧不必等网络', async () => {
    store.applyLatestCards(listResponse([entry('3')]))
    // ⚠️ 不能在这里调 store.reset() —— 它会 persist 一份空状态，把刚写的覆盖掉
    vi.resetModules()
    const fresh = await import('./store')
    const fn = vi.fn()
    fresh.subscribe(fn)
    fresh.hydrate()
    expect(fn).toHaveBeenCalled()
    expect(fresh.getState().latestCards?.items.length).toBe(1)
  })
})
