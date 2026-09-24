/**
 * ⭐ 全局「我」的 store —— 三层里的**逻辑层 + 热更新层**。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 三层分工，别串：
 *
 *   ① store（本文件）—— 全局状态的调用入口、业务逻辑、热更新。
 *      **所有写入都必须经过 commit()**，它是全项目唯一同时动这三层的地方：
 *          state = next                    状态层
 *          globalData.state / .userInfo     挂载层（同一引用，不是副本）
 *          wx.setStorageSync(KEY, state)    持久层
 *          notify(listeners)                热更新
 *      任何别处单独写 globalData 或 storage，都是把这三层撕开 ——
 *      迟早出现「界面变了但缓存没变」这类查不出来的不一致。
 *
 *   ② globalData —— 数据的**挂载点**。任何地方都能
 *      getApp().globalData.state（或 .userInfo）直接读当前状态。
 *
 *   ③ storage —— 持久化。小程序**没有** localStorage / sessionStorage，
 *      持久只有 wx.setStorageSync；会话级数据留在内存即可。
 *      读回缓存的入口只有 hydrate()。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **竞技数据的键是 articleId，不是日期。**
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
  ProfileUpdateResponse,
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
 * 全局状态。
 *
 * ⚠️ 「我是谁」只有一份：`userInfo`，就是 `GET /api/user/me` 的**原始返回体**。
 *    不再另存一份裁剪过的 profile —— 那种派生副本一旦和原始数据并存，
 *    就会出现「两个来源对不上」，而 streak 这类字段尤其容易分叉。
 */
/**
 * ⭐ 身份解析状态 —— 别把「还没问到」和「问到了但没有账号」混成一件事。
 *
 *   · 'pending'：还没跟服务端确认过身份（启动登录中 / 冷启动首屏）。
 *     界面上该**等一下**（导航栏左侧画 spinner），而不是先画个「加入」——
 *     否则每个用户打开小程序都会先看到一个假的「加入」，再闪成自己的头像。
 *   · 'ready'  ：已经问过了（成功或失败都算）。
 *     这时再按 hasJoined() 决定画头像还是「加入」。
 */
export type SessionState = 'pending' | 'ready'

export interface MeState {
  /** 服务端的「今天」—— 只用于显示与判断缓存过期，不参与任何竞技口径 */
  serverDate: string | null
  /** ⭐ articleId → 我在那个竞技场里的战绩 */
  arena: Record<string, ArenaRecord>
  /** ⭐ /api/user/me 的原始返回体；null = 服务端还没答上来（还没确认账号） */
  userInfo: MeResponse | null
  /** ⭐ 身份解析到哪一步了（见 SessionState） */
  session: SessionState
  /**
   * ⭐ 上一次拿到的那一屏卡片（今日 + 历史）—— **只为冷启动首屏秒开**。
   *
   * ⚠️⚠️ 它是**公开内容**的缓存，与上面那些「我的」数据分开：内容只有拉到才有，
   *    而云托管缩容到 0 时第一次请求要硬等 9~25 秒（见 client.ts 的 LAUNCH_BUDGET_MS），
   *    那段时间首屏不该是一片空白。
   * ⚠️ 用它之前**必须校验日期**（见 cachedSchedules）：跨天的排期是错的，
   *    把昨天那句当「今日挑战」画出来比空着更糟。
   */
  schedules: SchedulesResponse | null
}

/**
 * 存储键 —— 带版本号。
 * ⚠️ 结构变了必须换键：拿旧结构去解新代码，症状是「缓存里的数据永远读不出来」，
 *    而没有任何东西报错。v2 → v3 就是把 `profile` 换成了 `userInfo`。
 * ⚠️ 但**加一个可选字段不需要换**（v3 加 schedules 就是这种）：旧缓存里没有它，
 *    读回时 `?? null` 兜住即可。换键会让所有人的战绩缓存白丢一次，
 *    换来的只是「更整齐」—— 判据是**拿旧数据会不会解错**，不是字段有没有变。
 */
const STORAGE_KEY = 'me_state_v3'

function emptyState(): MeState {
  return { serverDate: null, arena: {}, userInfo: null, session: 'pending', schedules: null }
}

/** 一份零值 streak —— 只在「还没拿到 /me、但已经发生了一件需要账号的事」时临时用 */
function emptyStreak(): StreakView {
  return {
    streakDays: 0,
    streakBest: 0,
    readToday: false,
    unfreezeCards: 0,
    unfreezePending: 0,
    unfreezeExpiresOn: null,
  }
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
export function arenaOf(articleId: string): ArenaRecord {
  return state.arena[articleId] ?? { myBest: null, myAttempts: 0 }
}

/**
 * ⭐ 我**加入句拼**了吗 —— 服务端认不认识我，users 表里有没有我这一行。
 *
 * ⚠️⚠️ 判据**只有一个**：userInfo 非空。它与「我起名字了没有」**毫无关系**。
 *
 *    这个产品里有两层身份，混在一起就会写出自相矛盾的界面：
 *
 *      ① 授权层 —— openid。wx.login（或云托管网关注入）静默拿到。
 *                  「静默」只是说授权这一步不需要用户点什么，
 *                  **不等于他已经进了我们的业务库**。
 *      ② 账号层 —— users 里有没有我这一行。**就是本函数**。
 *                  ⭐ 任何业务数据（分数、榜单、排期）都挂在 user_id 上，
 *                  所以业务数据的前置条件就是这一层。
 *
 *    昵称 / 头像**不构成任何一层**：它们只回答「榜上显示成什么」，
 *    是加入之后随时可以补、也随时可以一直不补的资料（见 pages/join）。
 *    曾经拿「昵称非空」当登录判断，代价很实在：一个有账号、有成绩、
 *    只是没起名字的人会被判成新人 —— 状态卡给他 0，挑战把他往加入页推。
 *
 * ⚠️ 判据是「服务端给过我身份」：userInfo 只可能来自服务端的成功应答
 *    （GET /api/user/me），而服务端在那个接口上按 openid 取用户、
 *    **没有就当场建一行**（见 middleware/auth.ts）——
 *    所以「能返回」本身就证明了那一行存在。
 *
 * ⚠️ userInfo 会**落 storage**，所以断网重开也仍然算「加入过」 ——
 *    这是对的：账号在服务端，不因这一次请求失败而消失。
 *    反过来，拿不到它（后端没起来 / appid 没配）才叫「还没加入」，
 *    这时**不要显示任何业务数据**，首页状态卡就是这么判的。
 *
 * ⚠️ 界面上它对应导航栏那一格：加入了画头像，没加入画「加入」按钮。
 */
export function hasJoined(): boolean {
  return state.userInfo !== null
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
/* 写 —— 全部经 commit()，三层一起动                               */
/* ---------------------------------------------------------------- */

/**
 * ⭐ 挂载层：把当前 state 写到 globalData。
 *
 * ⚠️ 挂的是**同一个引用**，不是拷贝 —— 否则 globalData 会变成第二份真相。
 * ⚠️ App 还没建好（启动早期）或单测环境没有 getApp 时，挂载失败不影响主流程。
 */
function mount(): void {
  try {
    const app = getApp<{
      globalData: { state: MeState | null; userInfo: MeResponse | null }
    }>()
    if (!app?.globalData) return
    app.globalData.state = state
    app.globalData.userInfo = state.userInfo
  } catch {
    // 挂载失败只影响「全局直读」这条路，store 本身照常工作
  }
}

/**
 * ⭐ 三层唯一的调配点。顺序有意为之：
 *    先定状态 → 再挂载 → 再持久化 → 最后广播（订阅者读到的必是最新值）。
 */
function commit(next: MeState): void {
  state = next
  mount()
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

/** 持久层 —— 唯一写 storage 的地方（只被 commit 调） */
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
 * ⚠️ 这是唯一读 storage 的地方。
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
        userInfo: raw.userInfo ?? null,
        schedules: raw.schedules ?? null,
        // ⚠️ 缓存里有 userInfo 就直接算「已解析」（头像秒出，不必先转一圈 spinner）；
        //    没有就仍算 pending —— 本机也没记住我是谁，得等这次登录问回来。
        session: raw.userInfo ? 'ready' : 'pending',
      }
      for (const fn of [...listeners]) fn(state)
    }
  } catch (err) {
    console.warn('[store] 读取缓存失败：' + (err as Error).message)
    state = emptyState()
  }
  // 即使没有缓存也挂一次：让 globalData 至少指向当前（空）状态
  mount()
}

/** 两个「我的最好成绩」合并：有成绩的优先，都有取大 */
function mergeBest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/**
 * 拿当前 userInfo；还没有时建一份**最小的**（id 0 + 全零）。
 *
 * ⚠️ 只在「已经发生了一件只有真实账号才做得到的事」时才用得到 ——
 *    比如一次打分成功（提交本身要求账号）。
 *    光靠它 hasJoined() 会变 true，这是对的：事情都做成了，账号当然在。
 *    下一次 /api/user/me 回来会整份覆盖它，不必在这里凑字段。
 */
function ensureUserInfo(): MeResponse {
  return (
    state.userInfo ?? {
      id: 0,
      nickname: null,
      avatarUrl: null,
      gender: null,
      age: null,
      bio: null,
      status: 'active',
      energy: 0,
      challengedCount: 0,
      challengedRounds: 0,
      conqueredCount: 0,
      growth: { self: 0, diligence: 0, standout: 0 },
      streak: emptyStreak(),
    }
  )
}

/**
 * 用排期列表接口（**公开**）的返回值刷新。
 *
 * ⚠️⚠️ 这里刻意**不碰** arena 与 userInfo —— 公开接口不带「我的」字段了：
 *    · 「我在这句上的战绩」→ applyArenaRecords（鉴权接口 /api/user/arena-records）
 *    · 「连续天数 / 解冻卡」→ /api/user/me（写 userInfo 的是 applyProfile）
 *    一份数据一个写入方，才不会有「两个来源对不上」。
 */
export function applySchedules(res: SchedulesResponse): void {
  // ⚠️ 其余字段原样带着走（各有各的写入方，见上）
  // ⭐ 整份存下来 —— 它同时是「首屏缓存」（见 MeState.schedules）
  commit({ ...state, serverDate: res.date, schedules: res })
}

/**
 * ⭐ 冷启动首屏用：把上次那一屏卡片取回来 —— **只在还是同一天时**。
 *
 * ⚠️⚠️ 跨天一律返回 null：缓存里存的是**那一天**的排期，
 *    拿昨天的当「今日挑战」画出来，点进去还是昨天那句 —— 错的比空着更糟。
 * ⚠️ 判据用客户端自己的「今天」（shared 的 today()）——
 *    与切自然日用的是同一条规则，不会出现「端说同一天、服务端说不同天」。
 */
export function cachedSchedules(): SchedulesResponse | null {
  const s = state.schedules
  return s && s.date === today() ? s : null
}

/**
 * ⭐ 用「我在这几句上的战绩」（鉴权接口 /api/user/arena-records）刷新。
 *
 * ⚠️⚠️ 这是「我的」数据的**唯一来源**：公开接口（首页列表 / 竞技场）不含「我的」字段，
 *    端侧拿公开那一份渲染内容、拿这一份渲染「我读过没有 / 最好多少分 / 我第几名」。
 * ⚠️ 保守合并（理由同 applySchedules）：端侧可能已经有更高的分（刚打完分那次
 *    applySubmissionResult 先落了地），不能被一次旧快照盖回去。
 */
export function applyArenaRecords(
  items: { articleId: string; bestScore: number | null; attempts: number }[],
): void {
  const arena = { ...state.arena }
  for (const r of items) {
    const prev = arena[r.articleId]
    arena[r.articleId] = {
      myBest: mergeBest(prev?.myBest ?? null, r.bestScore),
      myAttempts: Math.max(prev?.myAttempts ?? 0, r.attempts),
    }
  }
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
 * ⚠️ streak 落在 userInfo 里（它是 /me 的一部分）；服务端没给 streak 时
 *    保留旧值，账号信息还没有时也不凭空造一份 —— 下一次 /me 会补齐。
 */
export function applySubmissionResult(input: {
  articleId: string
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
  let userInfo = state.userInfo
  if (input.streak) {
    const base = userInfo ?? ensureUserInfo()
    userInfo = {
      ...base,
      streak: {
        // 解冻卡的到期日 / 待领取数提交响应里没有，保留上一次刷新拿到的值
        ...base.streak,
        streakDays: input.streak.streakDays,
        streakBest: input.streak.streakBest,
        unfreezeCards: input.streak.unfreezeCards,
        readToday: input.streak.counted,
      },
    }
  }

  commit({ ...state, arena, userInfo })
}

/**
 * ⭐ 用 GET /api/user/me 的返回值刷新「我是谁」。
 *
 * ⚠️ 原样存整份响应 —— 不裁剪：裁剪出来的那份就是第二份真相，
 *    而 streak / status 这些字段迟早会在某一处被需要。
 * ⚠️ 这是 userInfo 的**唯一正式写入方**；提交响应、改资料都只做局部合并。
 */
export function applyProfile(m: MeResponse): void {
  commit({ ...state, userInfo: m, session: 'ready' })
}

/**
 * ⭐ 身份解析结束（成功或失败都算）—— 由登录 / refreshMe 的收尾调用。
 *
 * ⚠️ 为什么失败也要调：后端连不上时如果一直停在 pending，
 *    导航栏就永远转圈 —— 那比显示「加入 / 连不上，点我重试」更糟。
 *    解析结束 = 可以给用户一个**可操作**的界面了。
 */
export function markSessionReady(): void {
  if (state.session === 'ready') return
  commit({ ...state, session: 'ready' })
}

/**
 * ⭐ 只改头像 / 昵称这两格，其余（已征服数、streak）原样留着。
 *
 * ⚠️⚠️ 为什么不能存完再 GET 一次 /me 才知道自己是谁：
 *    POST /api/user/profile 成功 = 资料**已经落库**，这时候全局 state 还停在
 *    「没昵称」只有一种可能 —— 那次多余的 GET 失败了。
 *    而界面拿这一格画头像和昵称，于是他明明刚填完，界面却还是一个没名字的人。
 *    ⇒ 保存成功这件事必须以**保存接口自己的返回值**为准，不能靠第二次请求。
 * ⚠️ 顺带说清边界：这一格只是**展示资料**，改不改都不影响「是否已加入」
 *    （见 hasJoined）—— 但正因为界面拿它显示头像和昵称，它落后一步就看得见。
 */
export function applyProfilePatch(patch: ProfileUpdateResponse): void {
  const base = ensureUserInfo()
  commit({
    ...state,
    userInfo: {
      ...base,
      // ⚠️ 直接用服务端返回的**落库真相**：这次没选头像时它给的是库里存着的那张，
      //    不能因为入参没带就把界面上的头像抹掉（见 routes/user.ts 的说明）。
      nickname: patch.nickname,
      avatarUrl: patch.avatarUrl,
      gender: patch.gender,
      age: patch.age,
      bio: patch.bio,
    },
  })
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
