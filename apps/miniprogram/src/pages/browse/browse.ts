import { LEVEL_LABEL, LEVEL_ORDER } from '@jushuo/shared'
import type { ArticleCard, ArticleLevel, TagCount } from '@jushuo/shared'

import { fetchArticleLibrary, fetchTags } from '../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, goPublic } from '../../lib/route'

/**
 * ⭐ **浏览句库**（`pages/browse`）—— 顶部切标签 / 难度，下面无限滚动的句子列表。
 *
 * ⚠️ 筛选**单选**（标签一个、难度一档）：这一页要的是"切换"，不是条件编辑器。
 *    服务端支持多选（OR），要开放多选时改这一处即可（queryArticleCards 那边不用动）。
 *
 * ⚠️⚠️ **翻页靠 `offset` + 响应里的 `total`**：
 *    服务端是"先全局排序、再切页"（见 services/article-list.ts），所以翻页不会串页。
 *    判据固定用 `已加载条数 < total`，**不要**拿"这一页是否满"当判据 ——
 *    最后一页刚好满的时候会多打一次空请求。
 *
 * ⚠️ 列表卡片用 `arena-card` 的 list 形态，但**不给 `header`**：
 *    header 里有播放钮与参与人数，而"点进那一页"该有的都有（那边才是听 + 读的地方）。
 *    列表这一屏只管"有哪些句子"，少一层交互就少一处误触。
 *
 * ⚠️ 公开页：句库本来就是公开的（`/api/articles` 没有鉴权），所以走 `goPublic`。
 */

/** 每页几条（服务端上限 100；50 与它的默认值一致） */
const PAGE_SIZE = 20
/** 顶部标签条最多显示几个（剩下的去 tags 页看） */
const TOP_TAGS = 12

Page({
  data: {
    navTop: 0,
    /** 顶部标签条（只放前 N 个 + 「全部标签」） */
    tagChips: [] as TagCount[],
    /** 当前选中的标签（'' = 全部） */
    tag: '',
    /** 难度档位的中文标签（与 LEVEL_ORDER 一一对应，来自 shared，不另写映射） */
    levels: LEVEL_ORDER.map((d) => ({ level: d, label: LEVEL_LABEL[d] })),
    /** 当前选中的难度（null = 全部） */
    level: null as ArticleLevel | null,

    items: [] as ArticleCard[],
    /** 命中总数（服务端给的；判"还有没有下一页"） */
    total: 0,
    /** 第一页还没回来 */
    loading: true,
    /** 正在追加下一页 */
    loadingMore: false,
    error: '',
  },

  /** 已加载到第几条（下一页的 offset） */
  offset: 0,

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ navPadTop: undefined, navTop: navPadTop() })
    /**
     * ⭐ 参数从 URL 来（tags 页点标签进来、或分享出去的链接）：
     *    `?tag=` 与 `?difficulty=` 都是可选的。
     */
    const tag = query.tag ?? ''
    const levelRaw = query.difficulty ?? ''
    const level =
      levelRaw !== '' && LEVEL_ORDER.includes(Number(levelRaw) as ArticleLevel)
        ? (Number(levelRaw) as ArticleLevel)
        : null
    this.setData({ tag, level })
    void this.loadTags()
    void this.reload()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  /**
   * ⭐ 触底加载下一页。
   * ⚠️ 判据是 `已加载 < total`（见文件头）；`loadingMore` 挡并发。
   */
  onReachBottom() {
    if (this.data.loading || this.data.loadingMore) return
    if (this.data.items.length >= this.data.total) return
    void this.loadPage(false)
  },

  /** 下拉刷新 = 回到第一页（筛选条件保留） */
  async onPullDownRefresh() {
    try {
      await this.reload()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  /** 顶部标签条：取全部标签的前 N 个（顺序由服务端定，端侧不重排） */
  async loadTags() {
    try {
      const res = await fetchTags()
      this.setData({ tagChips: res.items.slice(0, TOP_TAGS) })
    } catch {
      /**
       * ⚠️ 标签条取不到**不算错误**：列表本身照常可用（只是少了几个快捷筛选）——
       *    为它弹一个错误块，会把"能用的页面"变成"看起来坏了"。
       */
      this.setData({ tagChips: [] })
    }
  },

  /** 重来一页：切筛选 / 下拉刷新 / 重试都走它 */
  async reload() {
    this.offset = 0
    this.setData({ items: [], total: 0, error: '' })
    await this.loadPage(true)
  },

  /**
   * 取一页。
   * @param first true = 第一页（要显示整页 loading），false = 追加（显示"正在加载更多"）
   */
  async loadPage(first: boolean) {
    if (first) this.setData({ loading: true, error: '' })
    else this.setData({ loadingMore: true })
    try {
      const res = await fetchArticleLibrary({
        // ⚠️ 空字符串要当"不筛"（服务端把空 tags 当不筛；difficulty 同理）
        tags: this.data.tag === '' ? undefined : this.data.tag,
        difficulty: this.data.level === null ? undefined : this.data.level,
        limit: PAGE_SIZE,
        offset: this.offset,
      })
      const items = first ? res.items : this.data.items.concat(res.items)
      this.offset = items.length
      this.setData({ loading: false, loadingMore: false, items, total: res.total })
    } catch (err) {
      const message = (err as Error).message || '句库取不到'
      if (first) this.setData({ loading: false, loadingMore: false, error: message })
      /**
       * ⚠️ 追加失败**不清空已经拿到的那些**，只把错误说出来 ——
       *    否则用户滑到第 3 页断网，前两页也跟着没了。
       */
      else this.setData({ loadingMore: false, error: message })
    }
  },

  /** 切标签（再点一次当前标签 = 取消筛选） */
  onPickTag(e: WechatMiniprogram.BaseEvent) {
    const tag = String((e.currentTarget.dataset as { tag?: string }).tag ?? '')
    const next = tag === this.data.tag ? '' : tag
    if (next === this.data.tag) return
    this.setData({ tag: next })
    void this.reload()
  },

  /** 切难度（再点一次当前档位 = 取消筛选） */
  onPickLevel(e: WechatMiniprogram.BaseEvent) {
    const raw = (e.currentTarget.dataset as { level?: number | string }).level
    const picked = Number(raw)
    const next = picked === this.data.level ? null : (picked as ArticleLevel)
    this.setData({ level: next })
    void this.reload()
  },

  /** 去标签名录（顶部的「全部标签」） */
  onOpenTags() {
    goPublic(ROUTES.tags.url)
  },

  /** 点一张卡 = 去那一句的竞技场（听标准音 / 看榜 / 开始挑战都在那边） */
  onOpenArticle(e: WechatMiniprogram.CustomEvent<{ articleId?: string }>) {
    const articleId = e.detail.articleId ?? ''
    if (!articleId) return
    goPublic(ROUTES.arena.url + '?article=' + encodeURIComponent(articleId))
  },

  onRetry() {
    void this.reload()
  },
})
