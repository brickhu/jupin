import type { TagCount } from '@jushuo/shared'

import { fetchTags } from '../../lib/api/client'
import { navPadTop, notifyNavScroll } from '../../lib/nav'
import { ROUTES, goPublic } from '../../lib/route'

/**
 * ⭐ **标签名录**（`pages/tags`）—— 句库里所有标签 + 各有多少篇，按篇数降序。
 *
 * ⚠️ 排序与计数都来自服务端（`GET /api/tags`）：**文章数降序 → 标签升序**。
 *    端侧**不要再排** —— 两处各排一次，早晚会不一样。
 *
 * ⚠️ **搜索在端侧本地过滤**（tabs 只有几十个）：输入框每敲一下都发一次请求既慢又费，
 *    而且服务端那条接口本来就没有查询参数（见 routes/tags.ts 的说明）。
 *    ⚠️ 过滤用**纯小写比较**：标签里有中文也有英文（励志 / travel），
 *      中文没有大小写、英文用户不会在乎大小写 —— 这样两种都搜得到。
 *
 * ⚠️ 点标签去 `pages/browse?tag=…`（浏览页顶部会把当前标签高亮出来）——
 *    这也是这个页面存在的意义：句库的**目录**。
 */
Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',
    /** 全部标签（服务端顺序，原样保留） */
    items: [] as TagCount[],
    /** 搜索后展示的那些 */
    shown: [] as TagCount[],
    /** 搜索词（输入框绑定） */
    query: '',
    /** 标签总数 —— 顶部那句「共 N 个标签」 */
    total: 0,
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
  },

  /** ⚠️ 每次进来都重拉：标签分布跟着句库更新走（新上线一篇就可能多一个标签） */
  onShow() {
    void this.load()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const res = await fetchTags()
      this.setData({
        loading: false,
        items: res.items,
        total: res.items.length,
        shown: this.filter(res.items, this.data.query),
      })
    } catch (err) {
      this.setData({ loading: false, error: (err as Error).message || '标签取不到' })
    }
  },

  /** 输入框每敲一下 → 本地过滤（见文件头：不发请求） */
  onSearch(e: WechatMiniprogram.Input) {
    const query = String(e.detail.value ?? '')
    this.setData({ query, shown: this.filter(this.data.items, query) })
  },

  /** 清空搜索（输入框右侧那个 ×） */
  onClearSearch() {
    this.setData({ query: '', shown: this.data.items })
  },

  /** 过滤：大小写不敏感的子串匹配（理由见文件头） */
  filter(items: TagCount[], query: string): TagCount[] {
    const q = query.trim().toLowerCase()
    if (q === '') return items
    return items.filter((t) => t.tag.toLowerCase().includes(q))
  },

  /** 点一个标签 → 浏览页（带上它） */
  onOpenTag(e: WechatMiniprogram.BaseEvent) {
    const tag = String((e.currentTarget.dataset as { tag?: string }).tag ?? '')
    if (!tag) return
    goPublic(ROUTES.browse.url + '?tag=' + encodeURIComponent(tag))
  },

  /** 「随便看看」—— 不带任何筛选进浏览页 */
  onOpenBrowse() {
    goPublic(ROUTES.browse.url)
  },

  onRetry() {
    void this.load()
  },
})
