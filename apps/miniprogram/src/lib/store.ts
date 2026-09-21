/**
 * ⭐ 全局「我」的 store —— **按句子（竞技场）组织的战绩** + streak。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **键是 articleId，不是日期。**
 *
 *    竞技数据的单位永远是句子：排名、参与人数、最高分、我的最好成绩，
 *    全部跟着**那一段文本**走。日期只是排期表上的一个格子（见 db/schema.ts
 *    的 schedules），它答完「今天展示哪一句」就没它的事了。
 *
 *    这条写错过一次，代价是一整类查不出来的 bug：
 *      · 同一句被排在多天，按日期存就会把**同一份战绩复制好几份**，
 *        写其中一份、其余几份要等下次刷新才对 —— 于是「提交完不刷新」
 *      · 客户端的日期来自 URL、服务端来自自己的时钟，两个字符串
 *        只要差一个字符，首页就会拿一个**永远匹配不上的键**去查，
 *        表现同样是「不刷新」，而每一处代码单独看都是对的
 *    ⇒ 改按 articleId 之后，两边用的是**同一个不可变的身份**，
 *      这类错配从根上不可能发生。
 * ══════════════════════════════════════════════════════════════════
 *
 * 它要解决的原始问题：提交完返回首页，首页不更新。
 * 根子在于「我参与了吗」这个事实没有单一存放处，散在三个页面各自的 data 里。
 * 现在有一处权威的记录：谁拿到新数据就往里写，所有页面订阅它。
 *
 * ⚠️ 两条必须守住的边界：
 *
 *   ① **服务端是唯一真相，这里只做缓存与广播。**
 *      分数、名次、是否参与，全部来自接口返回值，端侧**绝不自己算**。
 *
 *   ② **每个页面仍然照常向服务端刷新。**
 *      store 解决的是「拿到了新数据，别人不知道」，不解决「一直没去拿」。
 */

import type {
  MeResponse,
  ScheduleDetail,
  SchedulesResponse,
  StreakDelta,
  StreakView,
} from '@jushuo/shared'
import { daysBetween, today } from '@jushuo/shared'

/** 我在某个**竞技场（句子）**里的战绩 */
export interface ArenaRecord {
  /** 我在这句上的最好成绩；没参与为 null */
  myBest: number | null
  /** 我在这句上打过几次分 */
  myAttempts: number
}

/**
 * 「我是谁」—— 头像 / 昵称 / 已征服句子数。
 *
 * ⚠️ 只放**展示用**的字段，不放 token / openid 那类身份凭据：
 *    凭据由 lib/api/client 自己管（它要落 storage 且要能刷新）。
 *    这里的东西会随头像一起渲染到导航栏上，多放一个字段就多一份泄露面。
 */
export interface Profile {
  nickname: string | null
  avatarUrl: string | null
  /** 已征服的句子数（服务端按去重句子算，只增不减） */
  conqueredCount: number
}

export interface MeState {
  /** 服务端的「今天」—— 只用于显示与判断缓存过期，不参与任何竞技口径 */
  serverDate: string | null
  /** ⭐ articleId → 我在那个竞技场里的战绩 */
  arena: Record<number, ArenaRecord>
  /** 我的连续天数与徽章 */
  streak: StreakView | null
  /** 我的头像 / 昵称 —— 自定义导航栏左侧那个圆形头像靠它 */
  profile: Profile | null
  /**
   * ⭐ 「加入句拼」页开着没有。
   *
   * ⚠️⚠️ 它**必须放在这个全局 store 里**，不能放在某个页面或组件自己的 data 里：
   *    要弹它的人（首页/竞技场/朗读页）和真正渲染它的人（导航栏里的组件）
   *    是**两个页面/模块**，而小程序里每个页面是独立的模块作用域 ——
   *    页面自己存一个标志，导航栏那份是另一个实例，永远看不到。
   *    这正是本项目踩过的「共享 store 被内联成多份」那个坑的同一个形状。
   */
  joinSheet: boolean
}

/**
 * 存储键 —— 带版本号。
 * ⚠️ 结构变了必须换键：拿旧结构去解新代码，症状是「缓存里的数据永远读不出来」，
 *    而没有任何东西报错。这次从「按日期」改成「按句子」，正是一次结构变更。
 */
const STORAGE_KEY = 'me_state_v2'

function emptyState(): MeState {
  return { serverDate: null, arena: {}, streak: null, profile: null, joinSheet: false }
}

let state: MeState = emptyState()
let hydrated = false
const listeners = new Set<(s: MeState) => void>()

/* ---------------------------------------------------------------- */
/* 读                                                               */
/* ---------------------------------------------------------------- */

export function getState(): MeState {
  return state
}

/** 我在**这一句**上的战绩；没参与过就返回「没参与」 */
export function arenaOf(articleId: number): ArenaRecord {
  return state.arena[articleId] ?? { myBest: null, myAttempts: 0 }
}

/**
 * ⭐ 我**加入句拼**了没有 —— 判据是**昵称非空**。
 *
 * ⚠️ 为什么不是「有没有 openid」：openid 是 wx.login 静默拿到的，
 *    用户从来就没有"没登录"这个状态。他真正能感知到的那个动作，
 *    是**取了个名字、认领了头像**（见服务端 routes/user.ts 的 /profile）——
 *    也就是"加入"。所以界面上、代码里都叫加入，不叫登录。
 * ⚠️ 同一个判据：没有昵称 = 导航栏显示「加入」按钮 = 挑战被拦。
 */
export function hasJoined(): boolean {
  return !!state.profile?.nickname
}

/** 让导航栏把「加入句拼」页弹出来（任何页面都可以调） */
export function openJoinSheet(): void {
  commit({ ...state, joinSheet: true })
}

export function closeJoinSheet(): void {
  commit({ ...state, joinSheet: false })
}

/** 服务端的「今天」还没拿到时，退回本机时区的今天（只用于首屏占位） */
export function bestKnownDate(): string {
  return state.serverDate ?? today()
}

/**
 * 订阅变更，返回取消订阅的函数。
 *
 * ⚠️ 页面**必须**在 onUnload 里退订，否则页面销毁后回调还在跑，
 *    里面一句 setData 就会报「setData on destroyed page」。
 */
export function subscribe(fn: (s: MeState) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---------------------------------------------------------------- */
/* 写                                                               */
/* ---------------------------------------------------------------- */

function commit(next: MeState): void {
  state = next
  persist()
  // ⚠️ 复制一份再遍历：回调里退订不会打乱这次遍历
  for (const fn of [...listeners]) {
    try {
      fn(state)
    } catch (err) {
      /**
       * ⚠️⚠️ 一个订阅者出错**不能**影响其它订阅者，但**更不能被静默吞掉**。
       *    只 warn 一句 message 的后果很隐蔽：页面重画的回调一旦抛异常，
       *    表现是「数据明明变了，界面就是不动」—— 而那正是最难查的一类问题，
       *    因为**没有任何东西是坏的**，只是没人告诉你它失败了。
       */
      console.error('[store] 订阅回调出错，对应页面不会更新：', err)
    }
  }
}

function persist(): void {
  try {
    wx.setStorageSync(STORAGE_KEY, state)
  } catch {
    // 存储写不进去不该影响主流程
  }
}

/**
 * 冷启动时把上次的状态读回来 —— 让首页**首帧就有数据**，不必先白一下。
 * ⚠️ 读回来的只是**缓存**：页面照常会向服务端刷一遍，以服务端为准。
 */
export function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = wx.getStorageSync(STORAGE_KEY) as Partial<MeState> | '' | undefined
    if (raw && typeof raw === 'object' && raw.arena) {
      state = {
        serverDate: raw.serverDate ?? null,
        arena: raw.arena,
        streak: raw.streak ?? null,
        // ⚠️ 这一条是**后加的字段**，还没换存储键：
        //    hydrate 是逐字段取、缺了就退回默认值，旧结构读进来只是 profile 为 null，
        //    不会像「按日期存」→「按句子存」那次一样解出错误的数据。
        //    真正会解错的结构变更才需要换键（见 STORAGE_KEY 的说明）。
        profile: raw.profile ?? null,
        // ⚠️ 界面态不继承：上次退出时加入页开着，不代表这次也要开着
        joinSheet: false,
      }
      for (const fn of [...listeners]) fn(state)
    }
  } catch (err) {
    console.warn('[store] 读取缓存失败：' + (err as Error).message)
    state = emptyState()
  }
}

/** 两个「我的最好成绩」合并：有成绩的优先，都有取大 */
function mergeBest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/** 用排期列表接口的返回值刷新 */
export function applySchedules(res: SchedulesResponse): void {
  const arena = { ...state.arena }
  /**
   * ⚠️⚠️ 按 **articleId** 落，而不是按日期。
   *
   *    竞技数据跟着句子走 —— 同一句排在多天时，它们本来就是同一份战绩，
   *    这里写的是同一个键，不会出现「几份副本各自为政」。
   *
   * ⚠️ 而且必须**保守合并**，不能「后来者覆盖」：
   *    同一天列表里同一句会出现多次（今天 + 往日各一张卡），
   *    直接赋值等于让最后一张卡决定这一句显示什么 ——
   *    而顺序取决于服务端排序，出问题时是随机现象，根本查不出来。
   */
  for (const e of [res.today, ...res.history]) {
    const prev = arena[e.articleId]
    arena[e.articleId] = {
      myBest: mergeBest(prev?.myBest ?? null, e.myBest),
      myAttempts: Math.max(prev?.myAttempts ?? 0, e.myAttempts),
    }
  }
  // ⚠️ profile 原样带着走：它只有 /api/user/me 会写，这张列表不碰它
  commit({ serverDate: res.date, arena, streak: res.streak, profile: state.profile, joinSheet: state.joinSheet })
}

/** 用排期详情接口的返回值刷新 */
export function applyScheduleDetail(d: ScheduleDetail): void {
  const arena = { ...state.arena }
  arena[d.articleId] = { myBest: d.myBest, myAttempts: d.myAttempts }
  commit({ ...state, arena })
}

/**
 * ⭐⭐ 一次打分成功后写入 —— **这条是整个 store 存在的理由**。
 *
 * 朗读页拿到结果的那一刻就知道「我读的是哪一句、拿了多少分、streak 怎么变的」，
 * 直接写进来，首页 / 详情页立刻就是新数据 ——
 * 不用等 onShow，也不用管页面还在不在栈里。
 *
 * ⚠️ 键用 **articleId**（服务端回传的），不是 URL 上的日期。
 * ⚠️ 分数与 streak 都用**服务端给的**，端侧一个数都不算。
 */
export function applySubmissionResult(input: {
  articleId: number
  score: number
  streak?: StreakDelta
}): void {
  const prev = arenaOf(input.articleId)
  const arena = { ...state.arena }
  arena[input.articleId] = {
    // ⚠️ 取较大的那个：同一句可能提交多次，这一个是「又一次」，不一定是新高。
    //    端侧只做这一步保守合并；真正的权威值会在下一次刷新时被服务端覆盖。
    myBest: prev.myBest === null ? input.score : Math.max(prev.myBest, input.score),
    myAttempts: prev.myAttempts + 1,
  }

  // streak 直接用服务端算好的那一份；只有服务端没给时才保留旧的
  const streak: StreakView | null = input.streak
    ? {
        streakDays: input.streak.streakDays,
        streakBest: input.streak.streakBest,
        freezeCount: input.streak.freezeCount,
        badge: input.streak.badge,
        // ⚠️ 这两个是「下一个目标」，提交响应里没带，保留上一次刷新拿到的值
        nextBadge: state.streak?.nextBadge ?? null,
        daysToNext: state.streak?.daysToNext ?? 0,
        readToday: input.streak.counted,
      }
    : state.streak

  commit({ ...state, arena, streak })
}

/**
 * ⭐ 用 GET /api/user/me 的返回值刷新「我是谁」。
 *
 * ⚠️ 顺带把 streak 也写进来：同一份响应里就有，而且是**更完整**的那一份
 *    （含 nextBadge / daysToNext，提交响应里没有这两个）。
 *    两条路（这里和 schedules）写的是同一个服务端视图，谁后到谁生效。
 */
export function applyProfile(m: MeResponse): void {
  const profile: Profile = {
    nickname: m.nickname,
    avatarUrl: m.avatarUrl,
    conqueredCount: m.conqueredCount,
  }
  // ⚠️ 顺手把加入页收起来：拿到 profile 就意味着这次资料已经落库，
  //    用户不该再看到一个「加入」框杵在那儿（见 /profile 路由）
  commit({ ...state, profile, streak: m.streak, joinSheet: false })
}

/** 换账号 / 清空重置时调用 —— 否则会把上一个人的成绩显示给下一个人 */
export function reset(): void {
  commit(emptyState())
}

/** 缓存里的「今天」是否已经落后于真实今天（切后台过夜） */
export function isStale(now = today()): boolean {
  if (!state.serverDate) return true
  return daysBetween(state.serverDate, now) > 0
}
