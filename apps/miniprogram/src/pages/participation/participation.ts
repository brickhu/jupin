import { formatScore } from '@jushuo/shared'
import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipationDetail } from '../../lib/api/client'
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
  growthText: string
  growthTotal: number
  words: WordRow[]
}

/**
 * ⚠️ 原文**从 words 拼**（`words[].text` 自带标点），不是另存一份 text ——
 *    与 ParticipationRecord 的口径一致；只有快照为空（内容缺口）时才用服务端给的 text。
 */
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
     * ⚠️ 三项明细都写出来，不只给总分：三个指标各自回答一个问题（自我超越 / 坚持不懈 / 人中翘楚），
     *    合成一个数就没人解释得清它是怎么来的。
     */
    growthTotal: r.growth.self + r.growth.diligence + r.growth.standout,
    growthText:
      '自我 ' + r.growth.self + ' · 坚持 ' + r.growth.diligence + ' · 翘楚 ' + r.growth.standout,
    words: r.words.map((w) => ({
      text: w.text,
      ipa: (w.ipa ?? '').trim(),
      meaning: (w.meaning ?? '').trim(),
    })),
  }
}

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',
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
