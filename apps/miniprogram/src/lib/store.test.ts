import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  unfreezeCards: 0,
  unfreezeExpiresOn: null,
  readToday: true,
}

/** 造一天的排期卡片 */
function entry(date: string, articleId: number, myBest: number | null = null, myAttempts = 0) {
  return {
    date,
    articleId,
    text: 'x',
    translation: 'x',
    isScheduled: false,
    isToday: false,
    participantCount: 5,
    topScore: 80,
    myBest,
    myAttempts,
  }
}

function listResponse(today = entry('2026-09-21', 3), history: unknown[] = []) {
  return { date: '2026-09-21', streak: STREAK, today, history } as never
}

beforeEach(() => {
  memory.clear()
  store.reset()
})

describe('applyArenaRecords —— 「我的战绩」由个人接口喂（按句子落，不按日期）', () => {
  it('把服务端给的战绩写进对应句子', () => {
    store.applyArenaRecords([{ articleId: 3, bestScore: 72, attempts: 2 }])
    expect(store.arenaOf(3)).toEqual({ myBest: 72, myAttempts: 2 })
  })

  it('没参与过的句子返回「没参与」，而不是 undefined', () => {
    expect(store.arenaOf(999)).toEqual({ myBest: null, myAttempts: 0 })
  })

  it('⭐ 同一句给多次 → 只落一个键（按 articleId，不按日期）', () => {
    store.applyArenaRecords([
      { articleId: 1, bestScore: 85, attempts: 2 },
      { articleId: 1, bestScore: 60, attempts: 1 },
    ])
    expect(Object.keys(store.getState().arena)).toEqual(['1'])
    expect(store.arenaOf(1)).toEqual({ myBest: 85, myAttempts: 2 })
  })

  it('⚠️ 保守合并：旧快照不能把更高的分盖回去', () => {
    store.applyArenaRecords([{ articleId: 3, bestScore: 80, attempts: 1 }])
    store.applyArenaRecords([{ articleId: 3, bestScore: 60, attempts: 1 }])
    expect(store.arenaOf(3)).toEqual({ myBest: 80, myAttempts: 1 })
  })

  it('⭐ 公开列表接口（applySchedules）不再碰 arena / streak —— 它只带公开数据', () => {
    store.applySchedules(listResponse(entry('2026-09-21', 3)))
    expect(store.getState().arena).toEqual({})
    expect(store.getState().streak).toBeNull()
  })
})

describe('applySubmissionResult —— 这条就是那个 bug 的解药', () => {
  it('⭐ 打分成功后，不经过任何网络请求，战绩立刻就是新的', () => {
    expect(store.arenaOf(3).myBest).toBeNull()
    store.applySubmissionResult({ articleId: 3, score: 74 })
    expect(store.arenaOf(3)).toEqual({ myBest: 74, myAttempts: 1 })
  })

  it('同一句再提交一次：次数累加，最好成绩取较大值', () => {
    store.applyArenaRecords([{ articleId: 3, bestScore: 80, attempts: 1 }])
    store.applySubmissionResult({ articleId: 3, score: 60 })
    expect(store.arenaOf(3)).toEqual({ myBest: 80, myAttempts: 2 })
  })

  it('⚠️ 提交到别的句子时，不能动这一句的战绩', () => {
    store.applySubmissionResult({ articleId: 1, score: 91 })
    expect(store.arenaOf(1).myBest).toBe(91)
    expect(store.arenaOf(3).myBest).toBeNull()
  })

  it('streak 用服务端给的，端侧一个数都不算', () => {
    store.applySubmissionResult({
      articleId: 3,
      score: 70,
      streak: { streakDays: 9, streakBest: 9, unfreezeCards: 0, counted: true, delta: 1 },
    })
    expect(store.getState().streak?.streakDays).toBe(9)
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
    store.applySubmissionResult({ articleId: 3, score: 70 })
    expect(store.getState().streak?.streakDays).toBe(3)
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
    const off = store.subscribe((s) => seen.push(s.arena[3]?.myAttempts ?? -1))
    // ⚠️ 战绩的写入方是 applyArenaRecords（公开列表不再带「我的」字段）
    store.applyArenaRecords([{ articleId: 3, bestScore: 1, attempts: 1 }])
    store.applySubmissionResult({ articleId: 3, score: 2 })
    expect(seen).toEqual([1, 2])
    off()
  })

  it('⚠️ 退订之后不能再回调 —— 页面销毁后回调会 setData 报错', () => {
    const fn = vi.fn()
    const off = store.subscribe(fn)
    off()
    store.applySubmissionResult({ articleId: 3, score: 1 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('⚠️ 一个订阅者抛异常：不影响其它订阅者，但必须**报出来**', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = vi.fn()
    store.subscribe(() => {
      throw new Error('boom')
    })
    store.subscribe(good)
    store.applySubmissionResult({ articleId: 3, score: 1 })
    expect(good).toHaveBeenCalled()
    // ⚠️ 被吞掉的话，症状是「数据变了界面不动」，而没有任何东西看起来是坏的
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('hydrate —— 冷启动读回上次的战绩', () => {
  it('读回后订阅者立刻拿到数据，首帧不必等网络', async () => {
    store.applySubmissionResult({ articleId: 3, score: 88 })
    // ⚠️ 不能在这里调 store.reset() —— 它会 persist 一份空状态，把刚写的覆盖掉
    vi.resetModules()
    const fresh = await import('./store')
    const fn = vi.fn()
    fresh.subscribe(fn)
    fresh.hydrate()
    expect(fn).toHaveBeenCalled()
    expect(fresh.arenaOf(3).myBest).toBe(88)
  })
})
