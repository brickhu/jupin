/**
 * ⭐ 上一次录音的本地缓存 —— **以句子为单位，只留最新 1 条**。
 *
 * 为什么需要它：录一段 10–20 秒的朗读是有成本的（找安静的地方、清嗓子、重来），
 * 而录音会因为一些和用户无关的原因丢掉 —— 接了个电话、切了个页面、
 * 手滑退出小程序、甚至只是想先去看看昨天的榜单。丢掉就得**从头再读一遍**。
 *
 * 所以录完就落盘：再回到这句子上时，直接恢复成「已录好」的状态，
 * 可以试听、可以直接提交，也可以点「重录」换一段。
 *
 * ⚠️⚠️ 三条边界：
 *
 *   ① **键是「句子」，不是日期，也不是含糊的「上一次」。**
 *
 *      录音能不能用，取决于**参考文本** —— 讯飞拿它和音频对齐打分。
 *      而参考文本由句子（articleId）唯一决定：同一句换个日期再轮到，
 *      参考文本一字不差，这段录音照样是有效的。
 *      日期不参与判定，因为日期不改变「这段话读的是什么」。
 *
 *      ⚠️ 但键必须至少精确到句子。若只按「上一次」记住，
 *        你在 A 题录的音进了 B 题就会被当成「你已经录好了」——
 *        而那段音频读的根本不是 B 题的句子，提交必然被判「乱读」。
 *
 *   ② **只留 1 条，且固定路径。**
 *      小程序的本地文件有 **10MB 总量上限**，而且超了是**静默失败**。
 *      每次录音写一个新文件，几次之后就再也存不下了。
 *      固定两个路径（上传用 .pcm / 试听用 .wav），天然只会有一份。
 *
 *   ③ **点「重录」= 清除，下一次录音 = 替换。**
 *      这是用户的意图：他点重录就是要这段没了。
 *      所以清除必须发生在**点重录的那一刻**，而不是等下一次录完才覆盖 ——
 *      否则用户点完重录又退出去，下次进来旧的又回来了。
 */

/** 缓存元信息的存储键（带版本号，结构变了直接换键） */
const META_KEY = 'last_recording_v2'

/**
 * ⚠️ 必须**固定路径**、且必须落在 USER_DATA_PATH：
 *    临时目录会被系统清理，而 USER_DATA_PATH 是小程序的持久用户目录。
 */
/**
 * ⚠️ 缓存放在**独立目录**里：文件名要沿用原始文件名（见 savedNameOf），
 *    所以同名冲突、以及「按目录整体清理」都需要一个自己的空间。
 */
const AUDIO_PREFIX = wx.env.USER_DATA_PATH + '/jushuo-last'

/**
 * ⚠️⚠️ 缓存文件必须**沿用原始文件名**，不能一律存成 jushuo-last.pcm。
 *
 *    这条是实测出来的：**缓存下来的录音试听不了，刚录完的却能。**
 *
 *    原因不在内容 —— 字节是完整复制的，而在**文件名**：
 *    录音 API 给的 tempFilePath 在不同环境下是**完全不同的东西**：
 *      · 开发者工具 —— WebM/Opus 容器（实测过零率 0.156 = 标准语音）
 *      · 真机       —— 无头裸 PCM
 *    而播放器**按文件名挑解码器**。把 WebM 的字节存成 .pcm，
 *    就等于告诉它「这是裸 PCM」—— 表现是「试听没声音」，而且不报错。
 *
 *    ⇒ 连扩展名一起照搬。扩展名照搬了就不会猜错；
 *      平台给了什么名字，我们就用什么名字。
 */
function savedNameOf(tempFilePath: string): string {
  // ⚠️ 先砍掉 query 和目录（有些临时路径长这样：http://tmp/abc.webm?x=1）
  const clean = (tempFilePath.split('?')[0] ?? '').trim()
  const base = clean.split('/').pop() ?? ''
  // ⚠️⚠️ 必须净化：临时文件名里可能带 : / 等非法字符，
  //    直接拿去当目标文件名会写失败，而失败的表现同样是「缓存没了」。
  //    只保留字母数字和 . - _，其余一律换掉。
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(-64)
  // ⚠️ 兜底：实在拿不到名字，用 .pcm —— 真机就是裸 PCM，这个默认是对的
  return safe ? 'cached-' + safe : 'cached-clip.pcm'
}

/**
 * ⭐ 把临时文件落到持久目录。
 *
 * ⚠️⚠️ 必须两条路都试。开发者工具给的 tempFilePath 可能是 http://tmp/xxx.webm
 *    这种**网络形态**的路径，而 copyFileSync 只认本地文件路径 ——
 *    失败时它只抛一个错，而外层一旦吞掉，**元信息就不会写**，
 *    表现是「缓存永远恢复不出来」，且完全看不出原因。
 *    ⇒ 退回「读出字节再写」：readFileSync 对这类路径能拿到内容。
 *
 * ⚠️ 刻意**不用** wx.saveFile / saveFileSync：那两个会把临时文件**移走**，
 *    而上传（wx.cloud.uploadFile）随后还要用那个 tempFilePath —— 移走了就传不上去。
 *    这里只需要一份副本。
 */
function persistFile(from: string, to: string): void {
  try {
    fs().copyFileSync(from, to)
    return
  } catch (err) {
    console.warn('[last-recording] copyFileSync 失败，改走读+写：' + (err as Error).message)
  }
  const bytes = fs().readFileSync(from)
  fs().writeFileSync(to, bytes as ArrayBuffer)
}

/**
 * 试听文件的固定路径（加了 WAV 头的副本）。
 * ⚠️ 由页面调用 writePlayableWav 写入；这里只负责**指向它**。
 *    两边各写一份字面量的话，改路径时必然漏一处，
 *    而症状是「试听没声音」—— 一个看起来像音频格式问题、其实是路径问题的故障。
 */
export const REPLAY_PATH = wx.env.USER_DATA_PATH + '/jushuo-replay.wav'

export interface LastRecording {
  /** 这段录音读的是哪一句 —— 缓存的身份 */
  articleId: number
  durationMs: number
  /** 落盘时刻（毫秒时间戳）—— 只用于展示与排查，不参与「能不能用」的判定 */
  savedAt: number
  /** 上传用的文件路径（录音原始文件的副本，扩展名与原件一致） */
  audioPath: string
  /** 试听用的文件路径（可能是空串，见 loadLastRecording） */
  playPath: string
}

/**
 * ⚠️ audioPath 也存进元信息，而不是每次按固定名拼：
 *    扩展名是**上一次录音时**决定的（可能是 .webm，也可能是 .pcm），
 *    不记下来就既找不到它、也删不掉它。
 */
export type Meta = Omit<LastRecording, 'playPath'>

/**
 * 纯判定：这份缓存对**这一句**还能不能用。
 *
 * ⚠️ 抽成纯函数是为了能单测 —— 它守着边界 ①（身份必须精确到句子），
 *    而这一条一旦写错，表现是「提交了一段完全不对的音频」，极难从现象倒推。
 *
 * ⚠️ 刻意**没有保质期**：缓存的槽位只有一个，而清除规则的触发点只有两个 ——
 *    **点「重录」** 与 **提交拿到分数**（见 clearLastRecording）。
 *    再叠一个「超过 N 小时就作废」的规则，收益为零，
 *    却会凭空多出一个用户无法理解、也无法控制的失效条件。
 */
export function isUsable(meta: Meta | null | undefined, articleId: number): boolean {
  if (!meta) return false
  // ① 身份必须落在同一句上
  if (meta.articleId !== articleId) return false
  // ② 时长要有意义 —— 0 毫秒的录音恢复出来只会让用户白等一次提交
  if (!Number.isFinite(meta.durationMs) || meta.durationMs <= 0) return false
  // ③ 路径必须记着 —— 没有它既找不到文件也删不掉
  if (typeof meta.audioPath !== 'string' || !meta.audioPath) return false
  return true
}

function fs() {
  return wx.getFileSystemManager()
}

function exists(path: string): boolean {
  try {
    fs().accessSync(path)
    return true
  } catch {
    return false
  }
}

function removeFile(path: string | undefined): void {
  if (!path) return
  try {
    if (exists(path)) fs().unlinkSync(path)
  } catch {
    // 删不掉也无所谓：本地文件有上限，但一条录音远没到那个量级
  }
}

/** 清掉整个缓存目录 —— 换了一条录音时，旧的（可能换了名字）必须一起走 */
function removeDir(): void {
  try {
    fs().rmdirSync(AUDIO_PREFIX, true)
  } catch {
    // 目录不存在是常态（还没录过），不该报错
  }
}

function readMeta(): Meta | null {
  try {
    return (wx.getStorageSync(META_KEY) as Meta | '') || null
  } catch {
    return null
  }
}

/**
 * 录完之后落盘（**替换**上一条）。
 *
 * @param tempFilePath 录音 API 给的临时文件（上传对象存储的原始来源）
 * @param playPath     writePlayableWav 生成的试听文件（已经在 USER_DATA_PATH 里）
 */
export function saveLastRecording(input: {
  articleId: number
  tempFilePath: string
  playPath: string
  durationMs: number
}): void {
  const audioPath = `${AUDIO_PREFIX}/${savedNameOf(input.tempFilePath)}`

  // ⚠️⚠️⚠️ 顺序不能反：**先清、后写**。
  //
  //    这里踩过一次，而且很难看出来：原来把清理放在拷贝**之后**，
  //    于是每次录完都「写进去 → 立刻被自己删掉」，元信息指向一个不存在的文件，
  //    下次进页面 exists() 检查失败、缓存被丢弃 ——
  //    症状就是「上次的录音老是丢」，而每一处代码单看都没毛病。
  //
  //    ⇒ 写入即替换（边界 ②③）：上一条的文件名可能不同（沿用原件名），
  //      所以按**目录**整体清掉再写。留下旧文件会一直占着本地空间（上限 10MB）。
  removeDir()

  try {
    // ⚠️ 临时文件随时会被系统清掉，必须落一份到 USER_DATA_PATH 才算真的留下来
    if (input.tempFilePath && input.tempFilePath !== audioPath) {
      fs().mkdirSync(AUDIO_PREFIX, true)
      persistFile(input.tempFilePath, audioPath)
    }
  } catch (err) {
    // ⚠️ 存不下来**不该影响这次提交** —— 只是下次回来看不到它而已。
    //    ⚠️ 但日志里必须带上**源路径**：不带的话只知道失败了，
    //       不知道是路径形态不对、还是目录不允许、还是空间不够。
    console.warn(
      '[last-recording] 保存录音失败 src=' + input.tempFilePath + ' —— ' + (err as Error).message,
    )
    return
  }

  try {
    const meta: Meta = {
      articleId: input.articleId,
      durationMs: input.durationMs,
      savedAt: Date.now(),
      audioPath,
    }
    wx.setStorageSync(META_KEY, meta)
  } catch (err) {
    console.warn('[last-recording] 写元信息失败：' + (err as Error).message)
  }
}

/**
 * 读取并校验。没有、不是这一句的、文件没了 —— 一律返回 null。
 *
 * ⚠️ 任何一条不满足就**顺手把缓存清掉**：
 *    留着一条永远用不上的元信息，只会让下一次的判断更绕。
 */
export function loadLastRecording(
  articleId: number,
  now: number = Date.now(),
): LastRecording | null {
  void now // 保留参数位，便于将来真要加时效时不必改所有调用点
  const meta = readMeta()

  if (!isUsable(meta, articleId)) {
    if (meta) clearLastRecording()
    return null
  }

  // ⚠️ 元信息说「有」不算数 —— 文件可能被系统清理过（10MB 上限、用户清缓存）
  if (!exists((meta as Meta).audioPath)) {
    clearLastRecording()
    return null
  }

  return {
    ...(meta as Meta),
    // ⚠️ 试听文件可能根本没写成功（见 writePlayableWav 的 catch），
    //    那种情况下只恢复「能提交」，不能假装能试听
    playPath: exists(REPLAY_PATH) ? REPLAY_PATH : '',
  }
}

/**
 * 清掉缓存 —— **点「重录」时就要调它**。
 *
 * ⚠️ 必须清的时刻只有三个：
 *    · **用户点「重录」**—— 它的意图就是不要这段了。
 *      这一步不能省成「等下次录完自然覆盖」：用户点完重录又退出去，
 *      下次进来旧的又回来了，等于重录没生效。
 *    · **提交拿到分数**（见 reading.ts 的 applyResult）—— 录音已经被消费掉了，
 *      而结果页没有试听入口，留着只会让「隔天拿旧录音再提交一遍」成为可能。
 *    · 校验不通过时（见 loadLastRecording）。
 *
 * ⚠️⚠️ **提交失败不在此列。** 那是缓存存在的主要理由：用户读到一半断网、
 *    或者提交报错，他要的是「别让我重读一遍」，缓存必须留着让他直接重试。
 */
export function clearLastRecording(): void {
  const meta = readMeta()
  try {
    wx.removeStorageSync(META_KEY)
  } catch {
    // ignore
  }
  // ⚠️ 先按**元信息里记的路径**删，再整体清目录：
  //    文件名是上一次录音时按原件取的，猜不出来 —— 猜错的后果是
  //    用户目录里留一份永远用不上的音频（本地文件有 10MB 总量上限）。
  removeFile(meta?.audioPath)
  removeDir()
}
