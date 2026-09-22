import type { ScoreParts } from '../scoring'

/**
 * 引擎输出的词级结果。
 * ⚠️ 与内容的 ArticleWord 是两回事：
 *   WordScore = **运行时的评分结果**（这次这个词读得怎么样）
 *   ArticleWord = **内容侧的词级数据**（音标 / 释义 / 示范音频）
 * 客户端按 position 把两者拼起来渲染。
 */
export interface WordScore {
  word: string
  score: number
  dp: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
  startMs: number
  endMs: number
}

/**
 * ⭐ 讯飞 ISE 的四个**句级维度**（需要 extra_ability: multi_dimension 才会返回）。
 *
 * ⚠️ 掌握它们的真实关系，否则界面上很容易把话说过头：
 *
 *     total = (0.6×accuracy + 0.3×fluency + 0.1×standard) × integrity
 *
 *   ⚠️⚠️ 权重是 **0.6 / 0.3 / 0.1**，不是文档里那个 0.5 / 0.3 / 0.2 ——
 *      这是拿真实返回**算出来的**，不是抄来的：
 *        真实录音：acc 88.81818 / flu 74.44706 / std 54.59834 / integrity 91.66666
 *                  → 0.6/0.3/0.1 得 74.327783，实际 74.327800（Δ = 0.000017）
 *                  → 0.5/0.3/0.2 得 71.190964（差 3.1 分，明显不对）
 *        分句节点同样只对得上 0.6/0.3/0.1。
 *      原因：**我们这一路返回的节点名是 <read_chapter>，走的是篇章权重**，
 *      即使请求里 category 传的是 read_sentence（见 engines/xfyun.ts 的实测记录）。
 *
 *   完整度（integrity）是**乘性因子** —— 读得再准，漏读会把总分按比例整体拉低。
 *   所以「总分低」有两种完全不同的解释：发音不准（准确度低），或者没读完（完整度低）。
 *   界面上必须把这两件事分开说，否则用户不知道该练什么。
 *
 * 字段来源：rec_paper 下的 <read_chapter> 节点（**即使题型是 read_sentence**，节点名也叫 read_chapter）。
 * 实测结构见 apps/server/scripts/dump-ise-xml.ts。
 */
export interface ScoreDimensions {
  /** 准确度 —— 权重 0.5 */
  accuracy: number
  /** 流利度 —— 权重 0.3 */
  fluency: number
  /** 标准度 —— 权重 0.2（音节/重音层面与标准音的接近程度） */
  standard: number
  /** 完整度 —— **乘性因子**，漏读/增读会直接压低总分 */
  integrity: number
}

/** 统一响应包装 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/* ---------- 提交检测（核心） ---------- */

export interface SubmitRequest {
  articleId: number
  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.pcm */
  audioKey: string
  /**
   * 可选：该音频的**带签名下载地址**（小程序 wx.cloud.getTempFileURL 拿到的）。
   *
   * ⚠️ 为什么需要它：服务端自己读对象存储要靠「开放接口服务」取临时密钥，
   *    而该服务在本项目 dev 环境实测**始终没有旁加载到实例**
   *    （容器内 api.weixin.qq.com 解析到公网 IP、响应头无 x-openapi-seqid）。
   *    给了这个地址，服务端就不必依赖那个服务。
   *
   * ⚠️ 服务端会严格校验它：host 必须是我们自己的桶，且路径解出来必须**等于 audioKey**。
   *    详见 services/audio-key.ts 的 assertAudioUrlMatchesKey。
   */
  audioUrl?: string
  /**
   * ⭐ 是否**公开这次录音** —— 别人能不能听到这段声音。默认 true。
   *
   * ⚠️ 它不是「能不能上榜」：无论公开与否，成绩都进榜、音频都存在对象存储里。
   *    区别只是**别人能不能听到**。
   *    语音是生物特征 —— 「默认公开」这件事必须给用户一个关掉的开关。
   */
  isPublic?: boolean
}

/**
 * ⭐ 提交的**受理**结果 —— 不是打分结果。
 *
 * ⚠️⚠️ 为什么提交与打分要在协议上分开：
 *    一次讯飞评测要 10–20 秒，而云托管 callContainer 单次超时上限只有 15 秒。
 *    一个请求**装不下**一次打分 —— 所以后端受理后立刻返回 submissionId，
 *    客户端轮询 SubmissionStatusResponse，直到 status 变成 scored / failed。
 *
 *    这样链路上**没有任何「打分最多能跑多久」的假设**：
 *    唯一的判据是服务端的心跳，句子再长也只是多轮询几次。
 */
export interface SubmissionStatusResponse {
  submissionId: string
  status: 'scoring' | 'scored' | 'failed'
  /**
   * ⚠️ 只在 status === 'scored' 时存在。
   *    POST 受理时如果这段音频**早就打过分**（幂等命中），也会直接带上它 ——
   *    客户端看到 scored 就不必再轮询了。
   */
  result?: SubmitResponse
  /** ⚠️ 只在 status === 'failed' 时存在 */
  error?: string
}

export interface SubmitResponse {
  /** 云端权威分 0–100 */
  score: number
  /**
   * ⭐ AI 教练的 4–8 字点评（展示用）。
   * ⚠️ 可能没有：没配大模型、或调用失败 —— 前端据此整块不渲染，
   *    而不是显示一个空框（见 services/coach.ts）。
   */
  aiComment?: string
  /** ⭐ AI 教练的提升建议（给用户自己看，会指名到具体的词/音） */
  aiAdvice?: string
  /**
   * ⭐ **我们自己那套打分的分项明细** —— 结果页的「评分详情」显示的就是它。
   *
   * ⚠️ 不要拿引擎那四维（accuracy/fluency/standard/integrity）当详情：
   *    总分已经不按它们等权算了，摆在一起用户对不上（「我准确度 91，为什么总分 85」）。
   *    这里给的正是总分的五个组成部分，加起来就是那个分。
   */
  parts?: ScoreParts
  /**
   * ⭐ 这次读的**参考原文**（服务端一并给出）。
   *
   * ⚠️ 为什么要它：详情/分享页要把句子逐词上色，而逐词结果的第 i 项
   *    对应的是**这一句**的第 i 个词 —— 客户端自己再去拉一次正文，
   *    等于同一份数据两条路，哪天正文改了版本就对不上了。
   */
  text?: string
  /** ⭐ 这段录音有多长（毫秒）—— 结果页显示在播放按钮旁边 */
  durationMs?: number
  /**
   * ⭐ 这次挑战属于哪一天（YYYY-MM-DD）—— 结果页的排名卡点进竞技场要用它。
   * ⚠️ 不能拿端侧日期凑：历史挑战点进去要看的是**当时那一轮**的榜单。
   */
  scheduleDate?: string
  rank: number
  participantCount: number
  /** 距上一名还差多少分；null 表示已是第一 */
  gapToPrev: number | null
  /** 击败人数（= participantCount - rank） */
  beatenCount: number
  isPersonalBest: boolean
  isConquered: boolean
  /**
   * ⭐ 这次提交读的是**哪一句**（服务端认定的）。
   *
   * ⚠️⚠️ 客户端拿它当「我在这句上的战绩」的键 —— 竞技数据跟着句子走，与日期无关。
   *    必须由服务端回传：终端自己从 URL 里取的话，取错了就是
   *    「提交完参与状态不刷新」，而每一处代码单独看都是对的。
   */
  articleId: number
  /**
   * ⭐ 这段录音当前的可见性（别人能不能听到）。
   *
   * ⚠️ 提交时**不再问**用户，统一按默认值落库，结果页再给开关 ——
   *    所以这里必须回传**权威值**，不能让客户端自己猜一个：
   *    用户可能已经改过，而结果页会被反复拉到。
   */
  isPublic: boolean
  /** 上一次成绩，用于「🎉 62 → 87」 */
  previousBest: number | null
  /** 榜单中心 5 条 */
  leaderboard: LeaderboardRow[]
  /** 词级结果（可选增强；缺失时端侧兜底） */
  words?: WordScore[]
  /**
   * 句级四维得分（可选增强）。
   * ⚠️ 缺失时界面必须能优雅退化 —— mock 引擎与历史数据都可能没有。
   */
  dimensions?: ScoreDimensions
  /**
   * ⭐ 这次打分带来的 streak 变化。
   * ⚠️ 只有**真正打分成功**的那一次才有 —— 幂等重放不带它，
   *    因为重放不是一次新的「今天来读了」。
   */
  streak?: StreakDelta
}

export interface LeaderboardRow {
  rank: number
  nickname: string
  score: number
  isMe: boolean
}

/* ---------- Streak（连续天数） ---------- */

/**
 * Streak 的**展示视图** —— 服务端算好、客户端只负责显示。
 *
 * ⚠️ 客户端不重算「今天读没读」：手机时钟可以随便改，
 *    让客户端来判断只会出现「本地显示已打卡、服务端根本不记」的错位。
 *    日期一律来自服务端的 day.ts。
 */
export interface StreakView {
  /** 当前连续天数 */
  streakDays: number
  /**
   * 历史最长连续天数 —— **只增不减**。
   * ⚠️ 等级徽章已整体废除，它现在只剩展示用途（我的主页上的「历史最长」）。
   */
  streakBest: number
  /** 今天是否已经读过（读过再读不叠加） */
  readToday: boolean
  /**
   * ⭐ 手上还有几张**解冻卡**（未过期、未使用）。
   * ⚠️ **现算**，不是 users 上的计数器 —— 卡有有效期，整数表达不了。
   */
  unfreezeCards: number
  /** 手上最早到期那张的到期日 'YYYY-MM-DD'；没有就是 null */
  unfreezeExpiresOn: string | null
}

/** 一次提交给 streak 带来的具体变化 —— 结果页要逐条讲清楚 */
export interface StreakDelta {
  streakDays: number
  streakBest: number
  /** 这次读有没有被计入（false = 今天已经读过） */
  counted: boolean
  /** streak 变化量 */
  delta: number
  /** 读完之后手上还有几张解冻卡（含本次新发的） */
  unfreezeCards: number
}

/* ---------- 每日挑战 ---------- */

/**
 * 首页列表里的一张挑战卡。
 *
 * ⚠️⚠️ **竞技数据属于句子，不属于日期。**',
 *    句子就是竞技场：所有人读同一段文本、比同一个分数。
 *    日期只是首页这张列表上的一个格子 —— 它指向哪个句子，就进哪个竞技场。
 *
 *    所以下面这几个字段（参与人数 / 最高分 / 我的成绩 / 挑战次数）是
 *    **那个句子**的数据。同一句被排在多天时，那几张卡片会显示同一份数字 ——
 *    这是对的：它们本来就是同一个竞技场。
 *
 *    ⚠️ 唯一按日期算的是连续天数（streak），它在 SchedulesResponse 里单列。
 */
export interface ScheduleEntry {
  /** 挑战日期 'YYYY-MM-DD'（北京时间） */
  date: string
  articleId: number
  /** 句子原文 */
  text: string
  translation: string
  // ⚠️ 这里**刻意没有**标准音字段。
  //    听句子是朗读页的事，标准音只经 /api/articles/:id/content 发布、
  //    只被朗读页消费（见 ArticleContent.audio）。
  //    列表页和详情页都不该有播放入口 —— 卡片整张是「点进详情」的 tap 目标，
  //    再塞一个音频控件必然互相误触。
  /** 这条句子是不是专门排给那一天的（false = 从池子按天轮转来的） */
  isScheduled: boolean
  isToday: boolean
  /** 参与人数（当日去重用户数） */
  participantCount: number
  /** 当日最高分；无人参与为 null */
  topScore: number | null
  /** 我的最好成绩；没参与为 null */
  myBest: number | null
  /**
   * ⭐ 我在这天**打过几次分**（0 = 还没挑战）。
   *
   * ⚠️ 只数 status='scored' 的，与参与人数同一口径：
   *    把「音频读不出来 / 引擎判无效」也算进去的话，用户会看到
   *    「你已挑战 3 次」却只有一条成绩，而其中两次他根本没读成 —— 没法解释。
   */
  myAttempts: number
}

/**
 * 单个挑战的详情 —— 从首页卡片点进来。
 *
 * ⚠️ 与 ScheduleEntry 的分工：卡片是「一眼扫过去」，详情是「看进去」。
 *    所以这里多出**完整榜单**与**我的名次**（列表里 7 天各算一次名次太贵）。
 */
export interface ScheduleDetail {
  date: string
  articleId: number
  text: string
  translation: string
  isScheduled: boolean
  isToday: boolean
  participantCount: number
  topScore: number | null
  myBest: number | null
  /** 我在这天打过几次分（0 = 还没挑战） */
  myAttempts: number
  /** 我的名次；没参与为 null */
  myRank: number | null
  /** 我击败了多少人；没参与为 null */
  myBeatenCount: number | null
  /** 完整榜单（从头往下数，最多 20 条） */
  leaderboard: LeaderboardRow[]
}

export interface SchedulesResponse {
  /** 服务端认定的「今天」 */
  date: string
  today: ScheduleEntry
  /** 历史挑战，最近的在最前（不含今天） */
  history: ScheduleEntry[]
  /**
   * 我的连续天数与解冻卡。
   *
   * ⚠️⚠️ 它**和这张列表没有任何关系** —— 只是搭个顺风车省一次往返。
   *    streak 按**用户实际提交的时间**算（见 services/scoring.ts），
   *    不看这张列表上的日期，也不看提交挂在哪一天的挑战上：
   *    用户可以回到往日的挑战点「再次挑战」，那不该让他补签、也不该把今天的读记成上周的。
   */
  streak: StreakView
}

/* ---------- 其他 ---------- */

export interface TokenResponse {
  token: string
  user: { id: number; nickname: string | null }
}

export interface MyStats {
  isMember: boolean
  streak: StreakView
}

/**
 * ⭐ 「我是谁」—— 全局用户面板（头像 / 昵称 / 战绩）的**唯一数据源**。
 *
 * ⚠️ 它就是 GET /api/user/me 的返回体，客户端**不再自己拼**：
 *    头像和昵称将来可能来自微信授权，任意时刻都可能变；
 *    端侧再存一份自己拼的副本，就是第二份真相。
 *    这里的字段全部原样用服务端的。
 *
 * ⚠️ streak 也在这份响应里 —— 它和 schedules 响应里的那份是同一个视图，
 *    两条路都写进全局 store，谁后到谁生效（服务端是唯一真相）。
 */
/**
 * ⭐ 三个成长值 —— **分开给，不合成总分**。
 *
 * ⚠️ 三个数各自回答一个问题，相加之后没人解释得清那个数是怎么来的：
 *    · self      自我超越（跟自己的历史比）
 *    · diligence 孜孜不倦（坚持的里程碑）
 *    · standout  鹤立鸡群（跟榜单比）
 */
export interface GrowthView {
  self: number
  diligence: number
  standout: number
}

export interface MeResponse {
  id: number
  nickname: string | null
  avatarUrl: string | null
  /** 'active' / 'banned'；界面目前只区分「能不能用」 */
  status: string
  /**
   * ⭐ **能量点数**（替代旧的"每天 N 次挑战机会"）。
   * ⚠️ 每次挑战消耗 2 点、每日补足到 3 点；端侧只做展示，不自己算余额。
   */
  energy: number
  /** ⭐ 挑战过**几句**（去重句子数，全时段累计）—— 首页状态卡的「挑战场次」 */
  challengedCount: number
  /** ⭐ 一共挑战了**几回**（打分成功的提交数，全时段累计）—— 首页状态卡的「挑战回合」 */
  challengedRounds: number
  /** 攻克金句数：**拿到过分数**的去重句子数（只要参与并出分就算，只增不减） */
  conqueredCount: number
  /** ⭐ 三个成长值（分开展示） */
  growth: GrowthView
  streak: StreakView
}

/**
 * ⭐ 「我的挑战」列表里的一条（GET /api/user/challenges）。
 *
 * ⚠️ 它**不是** SubmitResponse：列表只要够认出「这是哪一次」+ 一眼看到分数，
 *    把榜单、逐词明细也带上会让响应大好几倍，而列表根本不用。
 */
/**
 * ⭐ 列表里一条的**逐词结果** —— 只要够把那一行的句子重新上色。
 *
 * ⚠️ 刻意不是完整的 WordScore：起始/结束时间、坏音素都是点开详情才有用的东西，
 *    而列表是一次几十条地返回 —— 带上它们等于把整个详情包乘上条数。
 * ⚠️ score 是**原始分**（不四舍五入）：标绿的判据与结果屏共用同一个数，
 *    这里先舍一次，两边就会在 84.96 这种边界上一个绿一个灰。
 */
export interface ChallengeWordScore {
  /**
   * 引擎认定的那个词 —— **对齐要用它**（见 alignWordScores）。
   * ⚠️ 不能省：引擎词表可能比原文多一个插入词（把别的音读成了词），
   *    少了它就只剩「按下标硬套」这条路，而那会让颜色整体错位。
   */
  word: string
  score: number
  /** 引擎的读音判定；不是 'normal' 一律标红（与结果屏同一条口径） */
  dp: string
}

/**
 * ⭐ 分享出去的「一次挑战结果」—— GET /share/challenge/:sid（**不需要登录**）。
 *
 * ⚠️ 它是给别人看的：拿到链接的人可能没有账号、也没读过这句。
 *    所以这里只放**公开信息**：分数、分项、逐词、榜单、这条录音是否公开；
 *    录音地址只在 isPublic 时给（成绩永远进榜，公开与否只管**声音**）。
 */
export interface ChallengeShareResponse {
  /** 与本人看到的 result 同构（同一处 describe() 产出），所以两屏能共用一套渲染 */
  result: SubmitResponse
  /** 这条挑战是谁读的 */
  owner: { nickname: string; avatarUrl: string | null }
  /** 这段录音的可播地址；**不公开时为 null** */
  audio: SubmissionAudioRef | null
  /** 提交时刻（ISO）—— 分享页只显示到分钟 */
  at: string
}

export interface ChallengeRecord {
  submissionId: string
  articleId: number
  /** 这次挑战归属哪一天（老数据可能为空） */
  scheduleDate: string | null
  /** 0–100，一位小数；没打完分时为空 */
  score: number | null
  isConquered: boolean
  /** scoring / scored / failed */
  status: string
  /** AI 的 4–8 字点评（有没有取决于当时配没配大模型） */
  aiComment: string | null
  /** 句子原文 —— 列表里靠它认出「这是哪一句」 */
  text: string
  /**
   * 逐词结果，下标与 text 切出来的词一一对应。
   * ⚠️ 老成绩没有这一列（或条数对不上）时是 null ——
   *    那时列表退回**不标色**的整句，而不是猜着上色。
   */
  wordScores: ChallengeWordScore[] | null
  /** 时间（ISO 字符串），列表按它倒序 */
  at: string
}

/**
 * ⭐ 一段**用户录音**的可播地址 —— 与 ArticleContent.audio 同构（kind + src）。
 *
 * ⚠️ 两条通道各有一套，客户端那侧只有一处分支（lib/audio/standard.ts 已处理）：
 *      · 'cloud' —— 云存储 fileID，客户端用 wx.cloud.getTempFileURL 换地址。
 *        云开发通道**不需要配 downloadFile 合法域名**，真机正式版才播得响。
 *      · 'http'  —— 服务端路径（本机联调，客户端自己拼 BASE_URL）。
 * ⚠️ 地址**只从「校验过归属的接口」发出来**（GET /api/submissions/:id/audio），
 *    这一页也是私人复盘页（只有本人看自己的记录），所以没有再套一层签名；
 *    真要把这条地址公开使用时，得先把鉴权加回去 —— 见 routes/media.ts。
 */
export interface SubmissionAudioRef {
  kind: 'cloud' | 'http'
  src: string
}

/** GET /api/submissions/:id/audio —— 拿一段自己录音的可播地址（audio 为 null = 音频不在了） */
export interface SubmissionAudioResponse {
  audio: SubmissionAudioRef | null
}

/**
 * ⭐ 「参与场次」里的一条 —— **一句 = 一个竞技场 = 一场**。
 *
 * ⚠️ 一条记录对应「我对这一句的全部战绩」，不是一次提交：
 *    同一句读十次，这里仍然只是一条（次数在 attempts 里）。
 */
export interface ParticipationRecord {
  articleId: number
  /** 句子原文 —— 列表里靠它认出是哪一句 */
  text: string
  /** 这句有多少个词（句子本身的长度，不是我能控制的） */
  words: number
  /** 我在这一句上挑战了几次（只数拿到分的） */
  attempts: number
  /** 最高分 / 最低分（都是拿到分的那些提交） */
  bestScore: number
  worstScore: number
  /** 我在这一句上的名次与参与人数（按最高分排） */
  rank: number
  participantCount: number
  /** 最近一次挑战的时间（ISO）—— 列表按它倒序 */
  lastAt: string
  /**
  /**
   * ⭐ **最近这次挑战属于哪一天**（YYYY-MM-DD）—— 点卡片跳**竞技场**要用它。
   * ⚠️ 竞技场是按「哪一天」取场次的（pages/arena 的 onLoad），
   *    所以这里给的必须是**你参与的那一场**的日期，而不是端侧的今天。
   * ⚠️ 老数据可能没有（schedule_date 为空）→ 空串，端侧那时不给跳。
   */
  lastScheduleDate: string
}

export interface ParticipationsResponse {
  items: ParticipationRecord[]
}

export interface ChallengesResponse {
  items: ChallengeRecord[]
}
/**
 * ⭐ 提交被拒的**业务分支**（429，但不是"错误"，是规则）。
 *
 * ⚠️ 它和真正的失败要分开说：客户端要给出**可行动**的提示
 *    （「今天的次数用完了，明天再来」），而不是一句「请求失败」。
 */
export interface QuotaExhaustedError {
  code: 'QUOTA_EXHAUSTED'
  /** free = 免费用户今天那 1 次用完了（付费可以继续）；cap = 付费用户今天也满了 */
  reason: 'free' | 'cap'
  /** 今天已经挑战了几次 */
  usedToday: number
  /** 今天的上限（免费 1 / 付费 50） */
  dailyLimit: number
}

/** 已经下线的错误码，留个说明免得看到旧代码发懵 */
// export interface TooFrequentError { code: 'TOO_FREQUENT'; retryAfterSec: number }
// export interface CooldownError { code: 'COOLDOWN'; nextFreeAt: string }
