/**
 * ⭐ 上一次录音的本地缓存 —— **以「句子原文 + 用户」为单位，每句最多留 1 条**。
 *
 * 为什么需要它：录一段 10–20 秒的朗读是有成本的（找安静的地方、清嗓子、重来），
 * 而录音会因为一些和用户无关的原因丢掉 —— 接了个电话、切了个页面、
 * 手滑退出小程序、甚至只是想先去看看昨天的榜单。丢掉就得**从头再读一遍**。
 *
 * 所以录完就落盘：再回到这句子上时，直接恢复成「已录好」的状态，
 * 可以试听、可以直接提交，也可以点「重录」换一段。
 *
 * ⚠️⚠️ 四条边界：
 *
 *   ① **键是 hash(句子原文) + uid，不是 articleId。**
 *
 *      录音能不能用，取决于**参考文本** —— 讯飞拿它和音频对齐打分。
 *      而参考文本只由**句子原文**决定，articleId 只是它在库里的编号：
 *      同一段文本重新导入一次、或换一个环境（自增号不同），
 *      那段录音其实照样有效，**按 id 存就会白白丢掉**。
 *      ⇒ 按内容寻址，才是「这句话我读过没有」这个问题的正确键。
 *
 *      ⚠️ 带上 uid 是因为开发者工具里多个测试账号**共用同一份本地存储**，
 *        不带 uid 会把别人的录音恢复成「你已经录好了」。
 *
 *      ⚠️ 但键必须至少精确到**整句**。若只按「上一次」记住，
 *        你在 A 句录的音进了 B 句就会被当成「你已经录好了」——
 *        而那段音频读的根本不是 B 句，提交必然被判「乱读」。
 *
 *   ② **每句一个槽位，最多留 MAX_SLOTS 条（按时间淘汰最旧的）。**
 *      不再是"只留一条"：按内容寻址之后，多留几件才有意义
 *      （来回对比今天要读的这几句）。
 *      ⚠️ 但**必须封顶**：小程序的本地文件有 **10MB 总量上限**，
 *        而且超了是**静默失败**。真机上一段 20 秒录音，原件（裸 PCM）+ 试听 WAV
 *        加起来约 1.3MB —— 留 3 条就是约 4MB，留 5 条就开始危险。
 *
 *   ③ **点「重录」= 清这一句，提交拿到分数 = 清这一句。**
 *      这是用户的意图：他点重录就是要这段没了。
 *      清除必须发生在**点重录的那一刻**，而不是等下一次录完才覆盖 ——
 *      否则用户点完重录又退出去，下次进来旧的又回来了。
 *      ⚠️ **提交失败不清** —— 那正是缓存存在的主要理由。
 *
 *   ④ **缓存文件沿用原始文件名**（见 savedNameOf）——
 *      这一条是实测出来的，不是洁癖，理由写在那个函数上。
 */

/** 缓存元信息的存储键（带版本号，结构变了直接换键） */
const META_KEY = 'last_recording_v3'

/**
 * 槽位上限。见边界 ②：一条录音在真机上约 1.3MB，而本地文件总量上限只有 10MB。
 */
const MAX_SLOTS = 3

/**
 * ⚠️ 必须**固定路径**、且必须落在 USER_DATA_PATH：
 *    临时目录会被系统清理，而 USER_DATA_PATH 是小程序的持久用户目录。
 * ⚠️ 每个槽位一个**子目录**：文件名要沿用原始文件名（见 savedNameOf），
 *    两句话的录音可能同名，挤在一个目录里必然互相覆盖。
 */
const AUDIO_PREFIX = wx.env.USER_DATA_PATH + '/jupin-recordings'

/**
 * ⚠️⚠️ 缓存文件必须**沿用原始文件名**，不能一律存成 clip.pcm。
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

/** 句子文本归一化：空白折叠 + 去首尾 —— 排版差异不该把同一句算成两句 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * ⭐ 缓存键 = hash(句子原文) + uid。
 *
 * ⚠️ 小程序里没有 crypto，这里也**不需要密码学强度** ——
 *    它只是个缓存键：同一句必须同键（确定性 ✔），不同句几乎不撞就够。
 *    djb2 的碰撞率对「一个人读过的几十句」这个量级完全够用。
 *
 * ⚠️ 刻意**没用 Math.imul**：多依赖一个 API 就多一处运行时不保证，
 *    而这里的收益是零。
 */
export function recordingKeyOf(text: string, uid: number): string {
  const normalized = normalizeText(text)
  let hash = 5381
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0
  }
  // ⚠️ 取无符号十六进制：负数的 toString(16) 会带一个 "-"，键里出现连字符会很难读
  return 'u' + uid + '-' + (hash >>> 0).toString(16).padStart(8, '0')
}

/** 某个槽位的目录 */
function slotDirOf(key: string): string {
  return AUDIO_PREFIX + '/' + key
}

/**
 * 试听文件的路径（加了 WAV 头的副本）。
 * ⚠️ 由页面调用 writePlayableWav 写入；这里只负责**指向它**。
 *    两边各写一份字面量的话，改路径时必然漏一处，
 *    而症状是「试听没声音」—— 一个看起来像音频格式问题、其实是路径问题的故障。
 */
export function replayPathOf(key: string): string {
  return slotDirOf(key) + '/replay.wav'
}

export interface LastRecording {
  /** 缓存键（内容 hash + uid）—— 缓存的身份 */
  key: string
  durationMs: number
  /** 落盘时刻（毫秒时间戳）—— 只用于淘汰最旧的那条 */
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

/** 所有槽位：key → 元信息 */
type MetaMap = Record<string, Meta>

/**
 * 纯判定：这份缓存对**这个键**还能不能用。
 *
 * ⚠️ 抽成纯函数是为了能单测 —— 它守着边界 ①（身份必须精确到整句），
 *    而这一条一旦写错，表现是「提交了一段完全不对的音频」，极难从现象倒推。
 *
 * ⚠️ 刻意**没有保质期**：清除规则的触发点只有「重录」与「提交拿到分数」
 *    （见 clearLastRecording）。再叠一个「超过 N 小时就作废」，
 *    收益为零，却会凭空多出一个用户无法理解、也无法控制的失效条件。
 */
export function isUsable(meta: Meta | null | undefined, key: string): boolean {
  if (!meta) return false
  // ① 身份必须落在同一个键上（内容 + 用户）
  if (meta.key !== key) return false
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

/** 删一个槽位的整个目录 —— 文件名是上一次录音时按原件取的，猜不出来 */
function removeSlotDir(key: string): void {
  try {
    fs().rmdirSync(slotDirOf(key), true)
  } catch {
    // 目录不存在是常态（还没录过），不该报错
  }
}

function readMetaMap(): MetaMap {
  try {
    const raw = wx.getStorageSync(META_KEY) as MetaMap | '' | undefined
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeMetaMap(map: MetaMap): void {
  try {
    wx.setStorageSync(META_KEY, map)
  } catch (err) {
    console.warn('[last-recording] 写元信息失败：' + (err as Error).message)
  }
}

/**
 * 把临时文件落到持久目录。
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
 * 录完之后落盘（**替换这一句**的上一条）。
 *
 * @param key          见 recordingKeyOf —— 内容 hash + uid
 * @param tempFilePath 录音 API 给的临时文件（上传对象存储的原始来源）
 * @param playPath     writePlayableWav 生成的试听文件（已经在 USER_PATH 里）
 */
export function saveLastRecording(input: {
  key: string
  tempFilePath: string
  playPath: string
  durationMs: number
}): void {
  const dir = slotDirOf(input.key)
  const audioPath = dir + '/' + savedNameOf(input.tempFilePath)

  // ⚠️⚠️⚠️ 顺序不能反：**先清、后写**。
  //
  //    这里踩过一次，而且很难看出来：原来把清理放在拷贝**之后**，
  //    于是每次录完都「写进去 → 立刻被自己删掉」，元信息指向一个不存在的文件，
  //    下次进页面 exists() 检查失败、缓存被丢弃 ——
  //    症状就是「上次的录音老是丢」，而每一处代码单看都没毛病。
  removeSlotDir(input.key)

  try {
    // ⚠️ 临时文件随时会被系统清掉，必须落一份到 USER_DATA_PATH 才算真的留下来
    if (input.tempFilePath && input.tempFilePath !== audioPath) {
      fs().mkdirSync(dir, true)
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

  const map = readMetaMap()
  map[input.key] = {
    key: input.key,
    durationMs: input.durationMs,
    savedAt: Date.now(),
    audioPath,
  }

  // ⚠️ 封顶：本地文件总量只有 10MB、超了静默失败，
  //    所以淘汰最旧的几条（连同它们的文件一起删，不能只删元信息）
  const keys = Object.keys(map)
  if (keys.length > MAX_SLOTS) {
    keys
      .sort((a, b) => (map[a]?.savedAt ?? 0) - (map[b]?.savedAt ?? 0))
      .slice(0, keys.length - MAX_SLOTS)
      .forEach((k) => {
        delete map[k]
        removeSlotDir(k)
      })
  }

  writeMetaMap(map)
}

/**
 * 读取并校验。没有、不是这一句的、文件没了 —— 一律返回 null。
 *
 * ⚠️ 任何一条不满足就**顺手把这一槽清掉**：
 *    留着一条永远用不上的元信息，只会让下一次的判断更绕。
 */
export function loadLastRecording(key: string): LastRecording | null {
  const map = readMetaMap()
  const meta = map[key]

  if (!isUsable(meta, key)) {
    if (meta) clearLastRecording(key)
    return null
  }

  const found = meta as Meta
  // ⚠️ 元信息说「有」不算数 —— 文件可能被系统清理过（10MB 上限、用户清缓存）
  if (!exists(found.audioPath)) {
    clearLastRecording(key)
    return null
  }

  return {
    ...found,
    // ⚠️ 试听文件可能根本没写成功（见 writePlayableWav 的 catch），
    //    那种情况下只恢复「能提交」，不能假装能试听
    playPath: exists(replayPathOf(key)) ? replayPathOf(key) : '',
  }
}

/**
 * 清掉**这一句**的缓存 —— 点「重录」和提交拿到分数时都要调它。
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
export function clearLastRecording(key: string): void {
  const map = readMetaMap()
  if (map[key]) {
    delete map[key]
    writeMetaMap(map)
  }
  // ⚠️ 直接清整个槽位目录，而不是按元信息里记的那一个文件删：
  //    槽位里除了录音原件还有试听 WAV，只删前者会留下一份永远用不上的音频
  removeSlotDir(key)
}

/**
 * 清掉**全部**槽位 —— 退出登录 / 换账号时用。
 * ⚠️ 换账号不清的话，下一个人的同内容句子会恢复出上一个人的声音。
 */
export function clearAllRecordings(): void {
  try {
    wx.removeStorageSync(META_KEY)
  } catch {
    // ignore
  }
  try {
    fs().rmdirSync(AUDIO_PREFIX, true)
  } catch {
    // 目录不存在是常态
  }
}

/** 只给自检/排查用：磁盘上留了几个槽位 */
export function recordingSlots(): number {
  return Object.keys(readMetaMap()).length
}
