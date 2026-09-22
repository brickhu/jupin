import { alignWordScores, formatScore, wordLevel, WORD_GREEN_LINE, WORD_RED_LINE } from '@jushuo/shared'
import type { ChallengeRecord, ChallengeWordScore } from '@jushuo/shared'

import { fetchChallenges, fetchSubmissionAudio } from '../../../lib/api/client'
import { ensureLocalAudio } from '../../../lib/audio/standard'
import { playAudioUrl, stopAudio } from '../../../lib/audio/play'
import { openChallengePage } from '../../../lib/challenges'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { agoText } from '../../../lib/time'

/**
 * ⭐ 「我的挑战」—— 这个用户**所有的挑战记录**，按时间倒序。
 *
 * ⚠️ 数据来自 GET /api/user/challenges，而它的数据源就是 submissions ——
 *    不另立一张「挑战记录表」（那是第二份真相，见路由里的说明）。
 * ⚠️ 点一条进**挑战详情**：复用朗读页的结果屏（带 sid 进去切到回看模式），
 *    而不是另做一个详情页 —— 分数、分项、AI 建议、逐词上色都在那一屏上。
 *
 * 一行的排版（用户定的）：
 *
 *     [▶] The best way to predict…（一行，溢出渐隐）   5 分钟前
 *     55.4，部分单词发音错误
 *
 * ⚠️ 句子**只占一行**、超出的部分用右侧渐隐遮罩盖住：
 *    这一页是给人「竖着扫过去比」的，一行一句、句句等宽，扫视才有意义；
 *    句子换行会把每一行的高度拉得参差不齐。看不全就点进去看。
 */

/** 句子里的一个词 —— 与朗读页的 WordView 同构（都是 index + 文本 + 颜色类） */
interface RowWord {
  i: number
  text: string
  /** 'text-ok'（读准了）/ 'text-bad' / 'text-ink' */
  cls: string
}

/** 列表里一行（显示形态与接口字段分开：WXML 里没法算） */
interface Row {
  submissionId: string
  articleId: number
  /** ⭐ 切好、上好色的词 */
  words: RowWord[]
  /** '55.4' / '—' */
  scoreText: string
  /** 分数后面那一句：为什么是这个分（见 verdictOf） */
  verdict: string
  /** '5 分钟前' / '今天 14:03' —— 精确到分 */
  ago: string
  // ⚠️ 这里原来有一个 conquered（🏆 已征服）—— 去掉它：
  //    攻克的口径已经变成「拿到分就算」（85 分线废除），于是**每一条有分的记录**
  //    都会带上这个标记，一列队徽就成了噪声。
  /** 检测失败的记录：没有分数，多半也没有音频了 */
  failed: boolean
  scheduleDate: string
}

/**
 * ⭐ 把句子切成词、按**那一次**的逐词结果上色。
 *
 * ⚠️ 切法与朗读页、服务端完全一致（空白切分）—— 三处不一致就会整行错位，
 *    而界面上完全看不出来（每个词都还是有颜色的，只是颜色张冠李戴）。
 * ⚠️ 拿不到逐词结果（老成绩），或词数对不上（正文换过版）→ 整句不上色。
 *    宁可全墨色，也不能按下标硬套。
 * ⚠️ 绿色判据用的是 shared 的 wordLevel()，与结果屏**同一处** ——
 *    否则同一句、同一个词，列表里是绿的、点进去是灰的。
 */
function toWords(text: string, scores: ChallengeWordScore[] | null): RowWord[] {
  const plain = text.split(/\s+/).filter(Boolean)
  if (!scores) return plain.map((t, i) => ({ i, text: t, cls: 'text-ink' }))
  // ⚠️ 用词对齐而不是按下标 —— 引擎词表可能多一个插入词（见 alignWordScores 的说明）
  const align = alignWordScores(text, scores.map((s) => s.word ?? ''))
  return plain.map((t, i) => {
    const at = align[i]
    const s = at === null || at === undefined ? undefined : scores[at]
    return { i, text: t, cls: s ? 'text-' + wordLevel(s.score, s.dp) : 'text-ink' }
  })
}

/**
 * ⭐ 分数后面那一句 —— **说清这个分是怎么来的**。
 *
 * ⚠️ ⚠️ 优先用**逐词结果**自己说，而不是 AI 点评：
 *    逐词结果是引擎的原始判定，和上面那些绿字/红字是**同一份数据** ——
 *    用户看到「3 个词读错或漏读」就能在句子里数出那 3 个红词。
 *    AI 点评是另一套话术（「韵律偏弱停顿偏多」），说不到具体的词上。
 * ⚠️ 只有老成绩没有逐词结果时才退回 AI 点评，两样都没有就只显示分数。
 * ⚠️ 用词与绿线共用常量：说「读得不准」的那一档就是没到绿线的那些词。
 */
function verdictOf(r: ChallengeRecord): string {
  if (r.status === 'failed') return '这次检测没有通过'
  if (r.score === null) return '还在检测中'
  const ws = r.wordScores
  if (!ws || ws.length === 0) return r.aiComment ?? ''

  const missed = ws.filter((w) => w.dp !== 'normal').length
  if (missed > 0) return missed + ' 个词读错或漏读'
  const muddy = ws.filter((w) => w.score < WORD_RED_LINE).length
  if (muddy > 0) return muddy + ' 个词读得不准'
  const green = ws.filter((w) => w.score >= WORD_GREEN_LINE).length
  if (green === ws.length) return '每个词都读准了'
  return '部分单词发音错误'
}

function toRow(r: ChallengeRecord): Row {
  return {
    submissionId: r.submissionId,
    articleId: r.articleId,
    words: toWords(r.text, r.wordScores),
    scoreText: formatScore(r.score),
    verdict: verdictOf(r),
    ago: agoText(r.at),

    failed: r.status === 'failed',
    scheduleDate: r.scheduleDate ?? '',
  }
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',
    rows: [] as Row[],
    /** 一次都没挑战过 —— 和「加载中」是两件事，文案也不同 */
    empty: false,
    /**
     * ⭐ 正在播的那一行的下标（-1 = 没在播）。
     * ⚠️ 只存一个下标，不给每行加 playing 字段：
     *    同时只可能播一段（见 lib/audio/play.ts），存两份状态迟早不同步。
     */
    playing: -1,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    void this.load()
  },

  /** ⚠️ 每次回到这一页都重拉：刚挑战完返回时，列表必须已经有那一条 */
  onShow() {
    if (!this.data.loading) void this.load()
  },

  /**
   * ⚠️ 离开页面就停声音：列表里点开一条详情，那段录音不该在背后继续响。
   *    两处都停（hide 是「翻走了」，unload 是「真没了」）。
   */
  onHide() {
    this.stopPlayback()
  },

  onUnload() {
    this.stopPlayback()
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  async load() {
    this.setData({ error: '' })
    try {
      const res = await fetchChallenges()
      const rows = res.items.map(toRow)
      this.setData({ loading: false, rows, empty: rows.length === 0 })
    } catch (err) {
      // ⚠️ 失败时**保留已有的列表** —— 拉不到新的不该把已经看到的内容也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
    }
  },

  onRetry() {
    void this.load()
  },

  /** 停掉正在播的那一段（并清掉行上的标记） */
  stopPlayback() {
    stopAudio()
    if (this.data.playing !== -1) this.setData({ playing: -1 })
  },

  /**
   * ⭐ 播放这一行的录音。
   *
   * ⚠️ 地址是**按需向服务端要**的（见 fetchSubmissionAudio）：
   *    它每条单独授权、会过期，所以不能提前批量取、也不能缓存起来长期用。
   * ⚠️ catchtap 而不是 bindtap：整行是「进详情」的入口，
   *    不拦住冒泡的话，点播放会顺手把人送进详情页。
   */
  async onPlay(e: WechatMiniprogram.BaseEvent) {
    const i = Number((e.currentTarget.dataset as { i?: number }).i)
    const row = this.data.rows[i]
    if (!row) return

    // 再点一次 = 停（同一行）
    if (this.data.playing === i) {
      this.stopPlayback()
      return
    }

    if (row.failed) {
      wx.showToast({ title: '这段录音已经不在了', icon: 'none' })
      return
    }

    // 先切到「正在播」：等网络回来再变色的话，用户会以为没点上而连点几次
    stopAudio()
    this.setData({ playing: i })

    try {
      const { audio } = await fetchSubmissionAudio(row.submissionId)
      // ⚠️ audio 为 null = 音频不在了（失败的提交会被服务端删掉）
      if (!audio) throw new Error('这段录音已经不在了')
      // ⚠️ 拿本地文件再播：同一个地址反复听时不必每次重下（见 lib/audio/standard.ts）
      const path = await ensureLocalAudio(audio.src, audio.kind)
      if (!path) throw new Error('取不到这段录音')
      // ⚠️ 等待期间用户可能已经点了别的行 —— 那就别再播这一段了
      if (this.data.playing !== i) return
      await playAudioUrl(path, '录音', () => {
        // ⚠️ 播完清标记，但只在「还是这一行」时清，别把新点的那一行带掉
        if (this.data.playing === i) this.setData({ playing: -1 })
      })
    } catch (err) {
      if (this.data.playing === i) this.setData({ playing: -1 })
      wx.showToast({ title: (err as Error).message, icon: 'none', duration: 2000 })
    }
  },

  /** 点一条 → 挑战详情（朗读页的结果屏） */
  onOpen(e: WechatMiniprogram.BaseEvent) {
    const ds = e.currentTarget.dataset as { i?: number }
    const row = this.data.rows[ds.i ?? -1]
    if (!row) return

    /**
     * ⚠️ 没有成绩的那条不给点：详情屏展示的是**结果**，
     *    拿不到结果进去只会看到一片空白。列表上它本来就标着「检测中/失败」。
     */
    if (row.failed) {
      wx.showToast({ title: '这条没有成绩', icon: 'none' })
      return
    }
    if (row.scoreText === '—') {
      wx.showToast({ title: '还在检测中，稍后再看', icon: 'none' })
      return
    }
    this.stopPlayback()
    openChallengePage(row.submissionId)
  },
})