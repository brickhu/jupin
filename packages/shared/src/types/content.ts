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

/**
 * 内容静态资源结构。
 * ⚠️ 内容不走后端 API 查库，全部由 CDN 分发。
 *    正文的位置**由 id 推导**（`content/articles/<id>.json`，见 services/content.ts
 *    的 contentPathOf）—— 库里**不存路径**（曾经那列 \`content_json\` 已删除，
 *    因为它是同一件事的第二个真相）；standardAudio 那一列仍存对象存储的 key。
 */

/**
 * ⭐ 句子难度 —— **朗读难度**，四档：0 初级 / 1 中级 / 2 高级 / 3 专家。
 *
 * ⚠️⚠️ 不是阅读难度：量的是「中文母语者念出来有多难」，不是「读起来好不好懂」
 *    （为什么可读性公式不能用，写在 level.ts 的头注释里）。
 * ⚠️ 值就是**档位数字**：0–3 单调、可排序、可直接落库按档位筛。
 *    中文只在 UI 与运营 CLI 上出现（LEVEL_LABEL），别写进数据里。
 */
export type ArticleLevel = 0 | 1 | 2 | 3

/**
 * ⭐ 定难度用的**三个判据分**，顺序固定：**[词汇及句式, 发音, 句子长度]**，各 1–5。
 *
 * ⚠️ 它们是**过程数据**，不是给用户看的量：用户看到的是合成后的那一个 difficulty。
 *    记进正文 JSON 是为了**能被代码验算**（difficulty === difficultyFromScores(scores)，
 *    见 shared/level.ts）—— 模型自己算加权总会有算错的时候。
 * ⚠️ 顺序是元组的一部分：换顺序等于换语义，所以不写成对象（三个键太长，
 *    正文里满屏 'vocabulary' / 'pronunciation' 反而看不清）。
 */
export type DifficultyScores = [number, number, number]

/**
 * ⭐ 句子的**视觉主题** —— 卡片配图与配色：{ image, background, foreground }。
 *
 * ⚠️ 三个字段都是「怎么画」：
 *    · image      —— 配图（静态资源路径 / 云存储引用）
 *    · background —— 背景色
 *    · foreground —— 前景（文字）色
 * ⚠️ 整份 theme 可以为空（老内容没有），端侧据此退回默认配色。
 */
export interface ArticleTheme {
  /** 配图；暂时留 null（见 theme.ts 的说明） */
  image: string | null
  background: string
  foreground: string
}

/** 文章正文静态 JSON —— 路径由文章 id 推导：content/articles/<id>.json */
export interface ArticleContent {
  /**
   * ⭐ 文章 id = **内容 hash**（sha256(正文 trim 后) 的十六进制**前 16 位**，
   *    长度定义在 shared 的 constants:ARTICLE_ID_LENGTH）。
   *
   * ⚠️ 三处必须**同一个值**：文件名、这份 JSON 的 id、articles.id。
   *    内容一改就是新文章（老提交/排期仍指向老正文）。
   *    口径的唯一定义在 tools/pipeline/src/lib/article-id.ts（articleIdOf）。
   */
  id: string
  /** 句子原文 —— 评分的参考文本 */
  text: string
  translation: string
  /** 词级数据（点词回放 / 逐词 A/B 的基础设施） */
  words: ArticleWord[]

  /**
   * ⭐ **朗读难度**（0 初级 / 1 中级 / 2 高级 / 3 专家）—— **对外只有这一个档位**。
   *
   * ⚠️⚠️ 定它的时候**分三个判据想**（词汇及句式 ×5 / 发音 ×4 / 长度 ×1），
   *    由**代码**按公式合成为一个值（公式与权重在 shared/level.ts，
   *    锚点样本在 tools/pipeline/src/lib/article-meta.ts 的 SYSTEM）。
   *
   *    ⚠️ 判据分**不是用户要的量**（用户 2026-09 纠正）：用户看到的是一枚徽章
   *       + 一句「难在哪」。但它们会随 scores 一起记进这份 JSON —— 好让**代码能验算**
   *       （模型自己算加权常有算错的；见 scores）。
   *
   * ⚠️ 可选，**这不是省事、是必须的**：正文在静态资源 / CDN 上，可能比代码旧 ——
   *    老 JSON 里没有这个字段。所以一律 fail-soft，并且**不许**补一个默认档位。
   */
  difficulty?: ArticleLevel
  /**
   * ⭐ 三个判据分 [词汇, 发音, 长度] —— 与 difficulty **同源、同一次调用产出**。
   *
   * ⚠️⚠️ 它的用处是**可验算**：difficulty 必须等于 difficultyFromScores(scores)。
   *    对不上就说明有一次算错了 —— 这种错以前是**静默**的（徽章上只是「高级」变「专家」，
   *    没有任何地方会报错）。
   * ⚠️ 一律走 normalizeScores 收口，认不出就是 undefined（绝不补默认分）；
   *    老正文没有这个字段很正常，**不许**因为它缺失就退回某个档位。
   * ⚠️ 它**不进公开 API**：ArticleDetail / ArticleListItem 都不带它 ——
   *    对外只有 difficulty + reason（怎么公开是 shared/types/api.ts 的决定）。
   */
  scores?: DifficultyScores
  /**
   * ⭐ **给用户看的一句话** —— 固定格式：以「相当于<级别>水平」开头，
   *    随后是发音难点，`；` 后是词汇与句式点评。例：
   *
   *    「相当于大学4级水平，world 的 r 和 l 挨着念、结尾 -ngths 连读很别扭；
   *      词都比较常见，只有 sophistication 稍超纲。」
   *
   * ⚠️ 它是**产品文案**（detail 接口返回给客户端），不是给审核的术语堆：
   *    说人话、可以带音标、**不用语法行话**、不贬低用户、必须点到具体的词或音。
   * ⚠️ 与 difficulty / scores **同源**：同一次 LLM 调用产出，一起写、一起重跑 ——
   *    所以它进这份 JSON（真相），而不是单开一列。
   */
  reason?: string
  /**
   * ⭐ 主题 / 朗读特征标签（自由文本，顺序即重要程度）。
   *
   * ⚠️ 与难度一样是**可选**的，理由同上。
   * ⚠️ 读到的值不必假设干净：入库前一律走 normalizeTags（去空 / 去重 / 限个数）。
   * ⚠️ tags **会**被物化进 article_tags（和 difficulty 一起，见 services/article-index.ts）：
   *    那份索引只为「按标签/档位筛选」能走 SQL 而存在，**真相永远是这份 JSON**。
   *    规矩只有一条：索引只由 syncArticleIndex 写，随时可从 JSON 全量重建。
   * ⚠️ 顺序有意义（第一个最重要），而 article_tags 是**集合**语义、丢了顺序 ——
   *    要展示顺序就读这份 JSON（详情接口就是这么做的）。
   */
  tags?: string[]
  /**
   * ⚠️ 这里**曾经有一个 `audio?: ArticleAudio`**，已删除。
   *
   *    它是**放错了类型**的字段：这个接口描述的是仓库里那份**静态 JSON**
   *    （`content/articles/<id>.json`），而 audio 从来不在文件里 ——
   *    它是服务端在**返回时**按当前环境拼出来的（fileID 带环境 ID 与桶名，
   *    写进文件就会让同一份内容只能指向某一个环境的桶）。
   *    更糟的是它声明的形状**和服务端实际返回的也不是一回事**
   *    （声明说 `full: string`、`words: (string|null)[]`；实际是 `full: string|null`、
   *      `words: string[]` —— 见 api.ts 的 ArticleDetailAudio）。
   *
   *    ⇒ 响应体裁归 api.ts：详情用 **ArticleDetail**（= ArticleContent + audio + theme），
   *      这份类型只管**文件里真有的东西**。
   */
}

/**
 * ⚠️ 这里**曾经有 ArticleTips / ReadingTip / TipType**（朗读技巧的整套类型），已删除。
 *
 *    它们对应的那条流水线从来没有建过：全仓库没有一处 import、没有一处读写，
 *    articles.tips_json 那一列也一起删了（迁移 0033）。
 *    类型不是「先放着不碍事」—— 它会让下一个读代码的人以为技巧已经做了一半，
 *    于是去猜「数据从哪来」。真要做的时候再定义，那时才知道它该长什么样。
 */
export interface ArticleWord {
  pos: number
  word: string
  /** 国际音标（来自 ECDICT） */
  ipa: string | null
  /** 词性 */
  posTag: string | null
  /** 该词在此语境下的中文释义 */
  meaningZh: string | null,
  /**
   * ⭐ **点这个词时该播的那一段**（毫秒）—— 从整句标准音上定位到 startMs、播到 endMs。
   *
   * ⚠️⚠️ 它**不是**引擎给的原始词时间戳：两侧按「相邻两词的中点」夹取、再各留 0.09s，
   *    与预切切片用的是**同一条规则**（见 tools/pipeline 的 wordRangesOf）。
   *    所以它描述的是「这个词连同前后一点点」的区间 —— 短词（the 只有 80ms）
   *    裸切出来只剩一声爆音，夹取之后才听得清。
   */
  startMs: number
  endMs: number
}
