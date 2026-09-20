/**
 * ⭐ 一段标准音的引用。
 *
 * ⚠️⚠️ 字段含义**由 kind 决定**，客户端必须按它解释：
 *    · 'cloud' → 云存储 fileID，要用 wx.cloud.getTempFileURL 换地址
 *    · 'http'  → 服务端路径，客户端加 BASE_URL 前缀直接用
 *
 * ⚠️ 两种形态都要活着，因为它们对应两种运行环境：
 *    · 'cloud' —— 云托管（真机 / 体验版 / 正式版），音频在对象存储里
 *    · 'http'  —— 本机 Docker，没有云存储，由服务端读 content/ 回吐
 *    只留一种，另一种环境就永远测不到这个功能 —— 而「真机上才发现播不出来」
 *    正是这类功能最典型的死法。
 *
 * ⚠️ 它**不是**「音频地址」，也不该被当成地址用：服务端存的是对象存储的 key，
 *    直接塞给 InnerAudioContext 就是一个 404 的相对路径。
 */
export interface AudioRef {
  full: string
  kind: 'cloud' | 'http'
}

/** 整句 + 逐词 */
export interface ArticleAudio extends AudioRef {
  /** 与 text 切词后的下标一一对应 */
  words: (string | null)[]
}

/**
 * 内容静态资源结构。
 * ⚠️ 内容不走后端 API 查库，全部由 CDN 分发。
 *    articles.contentJson / tipsJson / standardAudio 分别指向下面的 JSON / MP3。
 */

/** 文章正文静态 JSON —— articles.contentJson 指向它 */
export interface ArticleContent {
  id: number
  /** 句子原文 —— 评分的参考文本 */
  text: string
  translation: string
  /** 词级数据（点词回放 / 逐词 A/B 的基础设施） */
  words: ArticleWord[]

  /**
   * ⭐ 标准音的**云存储 fileID** —— 由服务端按当前环境拼好返回。
   *
   * ⚠️ 刻意不写进仓库里的 content JSON：fileID 里带**环境 ID 和桶名**，
   *    写死就会让同一份内容只能指向某一个环境的桶。
   *
   * ⚠️ 客户端拿到后必须用 wx.cloud.getTempFileURL 换成可播地址 ——
   *    InnerAudioContext 不认 cloud:// 协议。
   *    这条路的代价为零：小程序不需要为云存储配 downloadFile 合法域名。
   *
   * ⚠️ 没有标准音时是 null，客户端据此**隐藏播放入口**，
   *    而不是渲染一个点了没反应的图标。
   */
  audio?: ArticleAudio
}

/** 朗读技巧静态 JSON —— articles.tipsJson 指向它 */
export interface ArticleTips {
  tips: ReadingTip[],
}

export interface ArticleWord {
  pos: number
  word: string
  /** 国际音标（来自 ECDICT） */
  ipa: string | null
  /** 词性 */
  posTag: string | null
  /** 该词在此语境下的中文释义 */
  meaningZh: string | null,
  startMs: number
  endMs: number
  /** 预切的单词音频 ⭐ 精度优于运行时 seek() */
  audioUrl: string
}

export type TipType =
  | 'linking'          // 连读
  | 'weak_form'        // 弱读
  | 'stress'           // 重音
  | 'intonation'       // 语调
  | 'pause'            // 停顿
  | 'difficult_sound'  // 难音

/** 朗读技巧 —— 规则检测产出，LLM 只做润色 */
export interface ReadingTip {
  type: TipType
  /** 涉及的词区间，用于高亮 */
  wordStart: number
  wordEnd: number
  noteZh: string
  ipa?: string
  /** 针对性示范音频区间 ⭐ 用词级时间戳切出 */
  audioStartMs: number
  audioEndMs: number
}
