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

/**
 * ⭐ **连续静音多久才算"读完了"**。
 *
 * ⚠️⚠️ 从 1200 提到 **1500**（2026-10-09 用户指出逻辑问题之后）：
 *    人念一句话时，**词组之间停 1~2 秒是常态** ✗ ——
 *    ⚠️ 1200ms 挡不住这种自然停顿 ⇒ ⭐ 稍微顿一下就判读完 ✗
 * ⚠️ 代价：真读完了也会**多等 0.3 秒**才结束 ✓ —— ⭐ 这点代价换"不误停"完全值得 ✓
 *    （⭐ 误停 = 用户还在读、录音被掐 ✗ 那是体验级的伤害 ✓；
 *      不停 = 读完还得手点一下 ✓ 只是少省一次点击 ✓）
 */
export const AUTO_STOP_SILENCE_MS = 1500

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
 *    ⇒ ⭐ `词数 × AUTO_STOP_WORD_MS × 0.85` ✓
 *      · 11 个词 ⇒ 3740ms（⭐ 全句约 4400ms ✓）
 *        ⚠️ 读到第 6 个词停（~2400ms ✗）⇒ ⭐ **不触发** ✓
 *        ⚠️ 读到第 10 个词喘口气（~3600ms ✗ < 3740）⇒ ⭐ **不触发** ✓（⭐ 安全 ✓）
 *        ⭐ 读完了（~4400ms ✓）且静音够久 ⇒ ⭐ 触发 ✓
 *    ⭐ 零服务端依赖 ✓（⭐ 只用 `words.length` ✓）零网络 ✓
 *
 * ⚠️⚠️ **为什么是 0.85 而不是 0.6**（⭐ 用户 2026-10-09 追问"你觉得逻辑有问题吗"✓）：
 *    这个下限只是**准入条件** ✗ —— ⚠️ 一旦过了它，后面的判据只剩"静音够久" ✗
 *    ⇒ ⚠️ **0.6 的话：用户读到六成之后，任何一次自然停顿都会被判成"读完"** ✗✓
 *      —— ⚠️ 那和"读一半就停"是同一类错误的另一半 ✓
 *
 * ⭐ 而且方向要对：⭐ **宁可不停，不可误停** ✓✓
 *    · ⚠️ 误停（⭐ 还在读却被掐断 ✗）⇒ ⚠️ 体验直接毁掉 ✗
 *    · ⚠️ 不停（⭐ 读完了还得手点 ✓）⇒ ⚠️ 只是少省一次点击 ✓
 *    ⇒ ⭐ 保守参数是对的 ✓（⚠️ 代价是"读完多等半秒"✓）
 */
export const AUTO_STOP_MIN_RATIO = 0.85

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
/**
 * ⭐⭐ **自适应阈值**（⭐ 2026-10-10 加 ✓）—— ⭐ **不写死一个 RMS 数字** ✗
 *
 * ## ⚠️⚠️ 为什么固定阈值一定会坏
 *
 *    `SILENCE_RMS = 0.02` 是**按常识取的、没有真机数据**（⭐ 原注释自己承认了 ✓）。
 *    而**真机的录音增益差很多** ✗：
 *      ⚠️ **低增益设备**（⭐ 用户实测的那台就是 ✓）⇒ ⭐ **RMS 一直很小** ✗
 *      ⇒ ⚠️ **每一帧都 < 0.02** ⇒ ⭐ **全判成 `'silence'`** ✗
 *      ⇒ ⭐ **`voicedMs` 永不增长** ⇒ ⭐ **`autoStopAfter` 的第一条永远不成立** ✓✓
 *      ⇒ ⭐⚠️ **症状：⭐ 读完了它不停** ✓（⭐ 用户报的就是这个 ✓）
 *
 *    ⚠️ **而波形那条路早就遇到过同一个问题** ✗ ——
 *       `b264419`：⭐「波形加**自动增益** —— ⭐ 真机反馈『其它都对，就是**幅度不够**』」✓
 *       ⇒ ⭐ **它的解法就是"用见到的峰值归一化"** ✓
 *       ⇒ ⭐ **VAD 照抄这个思路就行，不必再猜阈值** ✓
 *
 * ## ⭐ 判据：⭐ 跟自己比，而不是跟一个绝对数字比
 *
 *    ⭐ 记住**见过的最大 RMS**（`peak`）✓
 *    ⭐ 静音 = `rms < max(FLOOR, peak × RATIO)` ✓
 *    ⇒ ⭐ **增益低的设备峰值也低，比例判据照样成立** ✓✓
 *    ⚠️ `FLOOR` 是**绝对下限**：⭐ 防止"安静环境里一点点底噪就成了峰值"✗，
 *       那样会把正常说话也判成静音 ✓
 */
export const SILENCE_PEAK_RATIO = 0.25
export const SILENCE_RMS_FLOOR = 0.004

/** ⭐ 更新"见过的最大 RMS"—— ⭐ 只涨不跌（⭐ 峰值是该设备的量程参考 ✓） */
export function advancePeakRms(peak: number, rms: number): number {
  return rms > peak ? rms : peak
}

/** ⭐ 按当前峰值算这一帧的静音阈值 */
export function silenceThresholdOf(peakRms: number): number {
  const byPeak = peakRms * SILENCE_PEAK_RATIO
  return byPeak > SILENCE_RMS_FLOOR ? byPeak : SILENCE_RMS_FLOOR
}

/** ⭐ 一帧的 RMS（⭐ 抽出来，⭐ 调用方要拿它更新峰值 ✓） */
export function rmsOf(samples: Float32Array | null): number {
  if (!samples || samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

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
    /**
     * ⭐⭐ **`'undecodable'` 也算"他在说话"** ✗（⭐ 2026-10-10 改 ✓）
     *
     * ## ⚠️⚠️ 为什么必须改
     *
     *    原来的口径是"只有**明确**判成 `'voice'` 才累加"✗（⭐ `'undecodable'` 不动 ✓）。
     *    而 `'undecodable'` 的含义是"**不知道**他在不在说"✓ ——
     *    ⚠️ 于是"安全方向"只体现在**不掐断**上 ✗，代价却是 ⭐ **`voicedMs` 会饿死** ✓✓：
     *      ⚠️ 只要有一部分帧解不开（⭐ 解码失败、帧边界、机型差异 ✓）
     *      ⇒ ⭐ **`voicedMs` 涨得比真实慢** ⇒ ⭐ **`voicedMs >= floor` 永远不成立** ✓
     *      ⇒ ⭐⭐ **读完永不停** ✓✓
     *      ⚠️ 用户实测：⭐ **iOS 和 Android 两端都不行** ✗ ——
     *         ⚠️ 那说明不是"某台设备音量小"✗，⭐ **是这条判据本身会饿死** ✓
     *
     * ## ⭐ 为什么这样是安全的
     *
     *    ⭐ `'undecodable'` 累加 `voicedMs` ⇒ ⭐ 与 `recordedMs` 同步涨 ✓
     *    ⚠️ **但它同时会把 `silentMs` 清零** ✗（⭐ 见上一行 ✓）
     *    ⇒ ⭐ 而 `autoStopAfter` **必须** `silentMs >= AUTO_STOP_SILENCE_MS` ✓
     *    ⇒ ⭐⭐ **"读一半停着不说话"仍然不会误判** ✗✓ ——
     *       ⭐ 因为那段时间的帧如果解不开，`silentMs` 就攒不起来 ✓✓
     *
     *    ⭐ 一句话：⭐ **"解不开"往两个方向都按"他还在说"处理** ✓ ——
     *    ⭐ 既不提前掐断（⭐ `silentMs` 不涨 ✓）⭐ 也不让 `voicedMs` 饿死 ✓✓
     */
    voicedMs:
      kind === 'voice' || kind === 'undecodable' ? state.voicedMs + frameMs : state.voicedMs,
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
   * ⚠️ 判据只此一条（⭐ 加上"先安静下来"✓）—— ⭐ 不要加墙钟兜底 ✗
   *    理由见下面那段说明 ✓
   * ⚠️ 不能是固定毫秒数 ✗ —— 那会让"读半句就停"被当成读完 ✓
   */
  const floor = input.wordCount * AUTO_STOP_WORD_MS * AUTO_STOP_MIN_RATIO

  /**
   * ⚠️⚠️ **这里曾经想加一条"用 `recordedMs`（墙钟）兜底"** ✗ —— ⭐ **撤回了** ✓
   *
   *    ⚠️ 动机是真的：⭐ `voicedMs` 在 `'undecodable'` 帧上不累加 ⇒ 会**饿死** ✓
   *    ⚠️ 但拿墙钟兜底会**重新引入 `0e9b527` 修掉的那个 bug** ✗：
   *       ⭐「读一半就停也被判读完」✓ ——
   *       ⚠️ 用户读了半句然后不说话，`recordedMs` 照样涨 ⇒ ⭐ 过一会儿就误判 ✓
   *    ⇒ ⭐ **正解在 `advanceVad` 里**（⭐ 见那里对 `'undecodable'` 的处理 ✓）：
   *       ⭐ **让解不开的帧也算"他在说话"** ✓✓ ——
   *       ⭐ 那既不饿死 `voicedMs`，又**不放松"必须先安静下来"** ✓
   */
  if (input.voicedMs < floor) return false
  return input.silentMs >= AUTO_STOP_SILENCE_MS
}
