import { formatScore } from '@jushuo/shared'
import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipationDetail } from '../../lib/api/client'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { renderParts } from '../../lib/score-parts'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, goPublic } from '../../lib/route'
import { agoText } from '../../lib/time'

/**
 * ⭐ **参与详情**（`pages/participation?id=<participations.id>`）—— 一条参与记录的完整一屏。
 *
 * ⚠️⚠️ 页面只干一件事：把 `GET /api/participation/{id}` 返回的那**一行**画出来，
 *    自己不加工、不补算、也不去别处凑数据（分数 / 名次 / 成长值 / 词表快照都在那一条里）。
 *    ⇒ 榜单点进来看到的数，就是榜上那一行的数（服务端同一个 participationRecordById）。
 *
 * ⚠️ **公开页**：不拦身份（`PROTECTED` 里没有它），从分享链接进来的陌生人也能看 ——
 *    与竞技场 / 成绩墙同一类。页面上的动作（去竞技场）也是公开的。
 *
 * ⚠️ `id` 是**派生地址**（`sha256(userId:articleId)` 前 24 位），整表重建后不变，
 *    所以这一页的链接可以放心分享（见 shared 的 participationIdOf）。
 */

/** 词表一行：只画"有内容的那几格"，空的不占位 */
interface WordRow {
  text: string
  /** 音标 */
  ipa: string
  /** 句中释义 */
  meaning: string
}

interface ParticipationView {
  articleId: string
  /** 句子原文：词表快照拼出来；快照为空时用服务端兜底给的 text */
  sentence: string
  bestText: string
  worstText: string
  attempts: number
  /** 「第 3 名 / 共 12 人」 */
  rankText: string
  /** 「最近 3 天前」 */
  lastText: string
  /** ⭐ 这一句累计赚到的饼干（成品文本，视图不自己算） */
  cookieText: string
  words: WordRow[]

  // ── ⭐⭐ 竞技档案（2026-10-15 起 participation 是有状态的，见 prd §7.2）──────
  /** ⭐ 那条录音的地址（**全站只留这一份** = 这句上读得最好那一次）；没有 = 空串 */
  audioUrl: string
  /** 这条录音多长（成品文本，如 00:23） */
  audioMsText: string
  /** ⭐ 五维明细（上标签下分数；被采纳那一份的） */
  parts: { key: string; label: string; value: string }[]
  /** ⭐ 累计薄弱词汇 —— **结构化事实**（由 submissions 聚合），不是 AI 说的 */
  weak: { word: string; times: string; dp: string }[]
  /** ⭐ AI 总结（LLM 产物，逐轮更新）；没生成出来就是空串 */
  summary: string
  /** ⭐ 总结的状态：pending 生成中 / failed 没生成出来（两者都要说清，别让空白自己解释） */
  summaryState: string
}

/**
 * ⚠️ 原文**从 words 拼**（`words[].text` 自带标点），不是另存一份 text ——
 *    与 ParticipationRecord 的口径一致；只有快照为空（内容缺口）时才用服务端给的 text。
 */
/** 毫秒 → `00:23`（WXML 里做不了格式化，所以在这里就拼好） */
function msText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss
}

function toView(r: ParticipationRecord): ParticipationView {
  return {
    articleId: r.articleId,
    sentence: (r.text ?? '').trim() || r.words.map((w) => w.text).join(' '),
    bestText: formatScore(r.bestScore),
    worstText: formatScore(r.worstScore),
    attempts: r.attempts,
    rankText: '第 ' + r.rank + ' 名 / 共 ' + r.participantCount + ' 人',
    lastText: '最近 ' + agoText(r.lastAt),
    /**
     * ⭐ 这一句累计赚到的饼干（与 users.cookies 同一套口径）。
     * ⚠️ 只有**一个数** —— 三维成长值已整体废除（prd §7.6），
     *    所以这里不再有"合成总分说不清"的问题：它本来就是一句一句赚来的。
     */
    cookieText: String(r.cookies),
    words: r.words.map((w) => ({
      text: w.text,
      ipa: (w.ipa ?? '').trim(),
      meaning: (w.meaning ?? '').trim(),
    })),
    // ── ⭐⭐ 竞技档案 ──────────────────────────────────────────────
    audioUrl: r.audio?.url ?? '',
    audioMsText: msText(r.audio?.durationMs ?? 0),
    parts: renderParts(r.scoreParts).map((d) => ({ key: d.key, label: d.label, value: d.value })),
    /** ⚠️ 排序由服务端定（次数多的在前）—— 端侧不要再排，否则两处口径会漂 */
    weak: r.weakPoints.map((w) => ({
      word: w.word,
      times: w.count + ' 次',
      dp: w.dp ?? '',
    })),
    summary: (r.aiSummary ?? '').trim(),
    summaryState: r.summaryState ?? '',
  }
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',
    /** ⭐ 那条录音在放吗（同一时刻只放一路，见 onPlayAudio） */
    playing: false,
    /** 取到的那一条（null = 还没取到 / 取不到） */
    view: null as ParticipationView | null,
  },

  /** 这一页看哪一条：`?id=` = participations.id（派生地址，见文件头） */
  pid: '',

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ navTop: navPadTop() })
    this.pid = query.id ?? ''
    /**
     * ⚠️ 菜单只是入口，真正决定分享内容的是下面两个 onShare*。
     *    `withShareTicket` 与其它公开页一致（供"从分享卡片进来"的判据用）。
     */
    wx.showShareMenu?.({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] })
  },

  /** ⚠️ 用 onShow 而不是 onLoad：从竞技场返回时这一条可能已经变了（比如他刚又挑战了一次） */
  onShow() {
    void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  /** 取这一条参与记录 —— 只走公开接口，失败原样说出来 */
  async load() {
    if (!this.pid) {
      this.setData({ loading: false, error: '缺少参与记录地址' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const r = await fetchParticipationDetail(this.pid)
      /**
       * ⚠️ `null` 不是错误：服务端说"没有这一行"（记录被重算掉 / 地址拼错）。
       *    这时**不画一排 0** —— 0 分是合法成绩，把"没有记录"显示成"最高 0 分"是在编数据。
       */
      if (!r) {
        this.setData({ loading: false, view: null, error: '这条参与记录已经不在了' })
        return
      }
      this.setData({ loading: false, view: toView(r) })
    } catch (err) {
      this.setData({ loading: false, view: null, error: (err as Error).message || '取不到这条参与记录' })
    }
  },

  onRetry() {
    void this.load()
  },

  /**
   * 「去这一句的竞技场」—— 公开页，不需要身份（`goPublic` 的用法见 lib/route.ts）。
   * ⚠️ 竞技场按句子寻址（`?article=`），所以用记录里的 articleId，不需要再问服务端。
   */
  onOpenArena() {
    const articleId = this.data.view?.articleId
    if (!articleId) return
    goPublic(ROUTES.arena.url + '?article=' + encodeURIComponent(articleId))
  },

  /**
   * ⭐ **试听档案里那条录音** —— 它是**这句上读得最好那一次**的声音
   *   （没被采纳的那些成绩单，语音在确认那一刻就删了，见 services/confirm.ts）。
   * ⚠️ 播之前先 `stopAudio()`：标准音/上一次试听同时响，用户分不清在放什么。
   */
  async onPlayAudio() {
    const src = this.data.view?.audioUrl
    if (!src) return
    stopAudio()
    this.setData({ playing: true })
    try {
      await playAudioUrl(src, '这段录音')
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '这段录音播不出来', icon: 'none' })
    } finally {
      this.setData({ playing: false })
    }
  },

  onShareAppMessage() {
    return {
      title: '看看 TA 在这一句上的成绩',
      path: ROUTES.participationDetail.url + '?id=' + this.pid,
    }
  },

  /** ⭐ 分享到朋友圈 —— 朋友圈只能用 query 带参数 */
  onShareTimeline() {
    return {
      title: '看看 TA 在这一句上的成绩',
      query: 'id=' + this.pid,
    }
  },
})
