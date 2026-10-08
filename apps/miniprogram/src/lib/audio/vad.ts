/**
 * ⭐⭐ **静音检测与"读完自动结束"的判据**（2026-10 定）。
 *
 * ## 为什么要有它
 *
 * 录音交互从「按住朗读」改回「**点一下开始、再点一下结束**」（用户 2026-10 定）——
 * 于是"什么时候算读完"必须由程序判断：用户点一下就开始说话，读完不用再去点结束 ✓
 *
 * ## ⚠️⚠️ 判据为什么是**两个条件**，不是单个静音
 *
 * 只判静音的话，**读到一半的停顿**会被当成读完 ✗ —— 那是最难受的失败方式：
 * 用户还在想下一个词，录音已经被掐断了。
 * ⇒ 所以还要一个"**时长下限**"：先把该说的时间说够，再等静音。
 *
 *     recordedMs ≥ expectedMs × 1.2   **且**   silentMs ≥ 1.2s
 *
 * ⭐ `expectedMs` 用**标准音的时长**（每一句都有，standardAudioMs）——
 *    它是逐句的、真实的参考语速 ✓ 比"按词数估"准得多。
 *
 * ## ⚠️ 阈值需要在真机上标定
 *
 * `SILENCE_RMS` 是我按常识取的保守值（**没有真机数据**）。
 * 环境噪音大的地方会偏小、录音增益低的设备会偏大 —— 两边的症状不同：
 *   · 阈值太低 ⇒ 环境噪音被当成"有人在说话" ⇒ **永远不自动结束** ✗（可接受：用户手动点）
 *   · 阈值太高 ⇒ 说话间隙被当成静音 ⇒ **提前掐断** ✗✗（不可接受）
 * ⇒ 所以取值**偏保守**（宁可判成"还在说"）✓
 */

/**
 * 一帧算不算静音：看**均方根**（RMS）。
 *
 * ⚠️ 用 RMS 而不是"峰值"：峰值对一两个爆音极其敏感，而说话间隙里的
 *    呼吸、唇齿声都会有峰值 —— 用峰值判会让静音永远不成立 ✗
 */
export const SILENCE_RMS = 0.02

/** ⭐ 连续静音多久才算"读完了" */
export const AUTO_STOP_SILENCE_MS = 1200

/**
 * ⭐ **正常朗读时，每个词大约说多久** —— 用来从【词数】推出"该说多久"。
 *
 * ⚠️ 取 400ms：偏保守 ✓（⭐ 正常朗读大约每分钟 150 词 ⇒ 每词 ~400ms ✓）
 * ⚠️ 这个值只用来算**下限**，不是用来卡时间 ✓
 */
export const AUTO_STOP_WORD_MS = 400
/**
 * ⭐ **净说话时长至少要到"这句话该说时长"的多少倍**，才允许判"读完"。
 *
 * ⚠️⚠️ 这个下限要同时挡住两种错，两者是一对矛盾（2026-10-09 用户逐个指出）：
 *
 *   ① 太高 ⇒ **读得快的人永不触发** ✗
 *      最初用「标准音时长 × 1.2」✗ —— 而那还要求客户端**先取回服务端时长** ✗
 *      （⭐ 取不到就永不自动结束 ✓ 那是最早的 bug ✓）
 *   ② 太低 ⇒ **读一半就停也会被当成"读完了"** ✗
 *      后来改成固定的 800ms ✗ —— ⚠️ 用户随即指出：半句话早就超过 800ms 了 ✗✓
 *
 * ⭐ 解法：下限**跟着句子长度走**，而词数客户端本来就知道 ✓✓
 *    ⇒ ⭐ `词数 × AUTO_STOP_WORD_MS × 0.6` ✓
 *      · 11 个词 ⇒ 2640ms ⇒ ⚠️ 读一半（~1300ms）**不够** ✓
 *      · 3 个词的短句 ⇒ 720ms ⇒ ⭐ 读完了就够 ✓
 *    ⭐ 零服务端依赖 ✓（⭐ 只用 `words.length` ✓）零网络 ✓
 *
 * ⚠️ 0.6 是"允许比参考语速快四成" —— 读得快的人保得住 ✓，
 *    而"读半句"（⭐ 大约 0.5 以下）拦得住 ✓
 */
export const AUTO_STOP_MIN_RATIO = 0.6

/**
 * ⭐⭐ 一帧属于哪一种 —— **刻意做成三态而不是布尔**。
 *
 * ⚠️⚠️ 为什么不能只有"静音 / 不静音"两种 ✗：
 *    解码失败（`decodeFrameToSamples` 给 null）时，如果按"静音"算，
 *    在不支持解码的环境里会**连着一路攒静音** ⇒ 一秒多之后**把录音掐断** ✗✗
 *    （而那个环境恰恰是开发者工具 —— 正在调这个功能的那个 ✓）
 *    ⇒ 'undecodable' 是**独立的第三种**，调用方必须为它写一条分支 ✓
 *      （TypeScript 会逼着写 ✓）
 */
export type ChunkKind = 'voice' | 'silence' | 'undecodable'

/**
 * 判一帧属于哪一种：看**均方根**（RMS）。
 *
 * ⚠️ 用 RMS 而不是"峰值"：峰值对一两个爆音极其敏感，而说话间隙里的
 *    呼吸、唇齿声都会有峰值 —— 用峰值判会让静音永远不成立 ✗
 * ⚠️ 空数组也算 'undecodable'（不是"静音"）：解出来什么都没有，说明这一帧没用上 ✓
 */
export function classifyChunk(samples: Float32Array | null, rmsThreshold = SILENCE_RMS): ChunkKind {
  if (!samples || samples.length === 0) return 'undecodable'

  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / samples.length) < rmsThreshold ? 'silence' : 'voice'
}

/** 逐帧累计的两个计数器（自动结束看的就是它们） */
export interface VadState {
  /** 已经录了多久（⭐ 墙钟：连静音一起算 ✓ 只用于超时兜底 ✓） */
  recordedMs: number
  /** 当前**连续**静音了多久（有声音时清零） */
  silentMs: number
  /**
   * ⭐⭐ **累计【确认为语音】的时长** —— "读完了"该看的就是它 ✓
   *
   * ⚠️⚠️ 2026-10-09 之前用的是 `recordedMs` ✗，而它把**开头静音**和
   *    **用户读的时候自己的停顿**全算进去了 ✗
   *    ⇒ ⚠️ 于是判据实际变成"**录够了这么久的墙钟时间**"✗
   *    ⇒ ⭐ 用户看到的行为就是"按秒数停，不是按读完停"✗✓（用户就是这么报的 ✓）
   * ⚠️ 口径：只有 `'silence'` 之外的**明确语音**才累加 ✓
   *    （`'undecodable'` 是"不知道"✗ ⇒ 不累加也不清零 ✓ 见 advanceVad 的说明 ✓）
   */
  voicedMs: number
}

export const VAD_STATE_ZERO: VadState = { recordedMs: 0, silentMs: 0, voicedMs: 0 }

/**
 * ⭐ 吃进一帧，吐出新的计数器 —— 纯函数，好测，也好让调用方一眼看出规则。
 *
 * ⚠️⚠️ **'undecodable' 时 `silentMs` 必须清零**，而不是保持原值更不是累加 ✗：
 *    解不出来的意思是"**我们不知道**他在不在说话" ⇒ 只能往**安全**的方向倒 ——
 *    当成"他在说话" ⇒ 永远不自动结束 ✓（用户还能手动点结束 ✓）
 *    ⚠️ 反过来（当成静音）就会在不支持解码的环境里**提前掐断** ✗✗，
 *      而那正是最不能接受的失败方式（用户还在读，录音没了 ✓）
 *
 * ⚠️ `recordedMs` **任何一帧都要加**（时间真的过去了 ✓）——
 *    不然"时长下限"这个条件在不支持解码的环境里永远不成立 ✓
 */
export function advanceVad(state: VadState, kind: ChunkKind, frameMs: number): VadState {
  return {
    recordedMs: state.recordedMs + frameMs,
    // ⚠️ 只有**确认为静音**才累加；'voice' 与 'undecodable' 都清零
    silentMs: kind === 'silence' ? state.silentMs + frameMs : 0,
    // ⭐ 只有**明确是语音**才累加 ✓（'undecodable' 不累加 ✓ 见类型的说明 ✓）
    voicedMs: kind === 'voice' ? state.voicedMs + frameMs : state.voicedMs,
  }
}

/**
 * ⭐ **该不该判"读完了"** —— 纯本地判断，**不依赖任何服务端数据** ✓。
 *
 * 判据两条，缺一不可：
 *   ① ⭐ 净说话时长 ≥ `AUTO_STOP_MIN_VOICED_MS`（⭐ 防"嗯…"一下就被判完 ✓）
 *   ② ⭐ 连续静音 ≥ `AUTO_STOP_SILENCE_MS`
 *
 * ⚠️⚠️ 2026-10-09 之前这里还有第三条：`expectedMs`（⭐ 标准音时长 × 1.2 ✗）——
 *    **拆掉了** ✗，两个理由：
 *      · 它用的是墙钟时长 ⇒ ⭐ 读得快的人永远到不了 ⇒ **读完永不停** ✗✓（用户报的 bug ✓）
 *      · 那个时长来自**服务端** ⇒ ⚠️ 把纯本地的判断绑上了网络与后端 ✗
 *        （⭐ 取不到就永不自动结束 ✗）
 *    ⭐ 而"读完了没"只需要听：**说过话 + 然后安静下来** ✓
 */
export function autoStopAfter(input: {
  /** ⭐ 累计净说话时长（⭐ 判据看它 ✓） */
  voicedMs: number
  silentMs: number
  /** ⭐ 这句话有几个词（⭐ 用来推"该说多久" ✓ 客户端本来就知道 ✓） */
  wordCount: number
}): boolean {
  // ⚠️ 一个词都没有（⭐ 正文异常 / 还没加载 ✓）⇒ ⭐ 绝不自动结束 ✓
  if (input.wordCount <= 0) return false
  /**
   * ⭐ **下限跟着句子长度走** ✓（⭐ 见 AUTO_STOP_MIN_RATIO 的说明 ✓）
   * ⚠️ 不能是固定毫秒数 ✗ —— 那会让"读半句就停"被当成读完 ✓
   */
  const floor = input.wordCount * AUTO_STOP_WORD_MS * AUTO_STOP_MIN_RATIO
  // ⭐ 看【净说话时长】而不是墙钟（⚠️ 后者会把开头静音和用户停顿都算进去 ✗）
  if (input.voicedMs < floor) return false
  return input.silentMs >= AUTO_STOP_SILENCE_MS
}
