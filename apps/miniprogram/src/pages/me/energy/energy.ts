import { AD_REWARD_ENERGY, COOKIES_PER_ENERGY, energyFromCookies } from '@jushuo/shared'
import type { AdEnergyResponse, EnergyLedgerItem, ShopGoodsItem } from '@jushuo/shared'
import { explainXpayError } from '@jushuo/shared'

import {
  checkShopOrder,
  claimAdEnergy,
  createShopOrder,
  exchangeCookies,
  fetchEnergy,
  fetchShopGoods,
} from '../../../lib/api/client'
import {
  adClaimFailedText,
  adErrorText,
  adRewardPromiseText,
  adRewardToast,
  forgetPendingClaim,
  readPendingClaims,
  rememberPendingClaim,
} from '../../../lib/ad-energy'
import { AD_UNIT_ID } from '../../../config'
import { refreshMe } from '../../../lib/join'
import { getState } from '../../../lib/store'
import { newRequestId } from '../../../lib/request-id'
import { navPadTop, notifyNavScroll } from '../../../lib/nav'
import { agoText } from '../../../lib/time'

/**
 * ⭐ 「能量」—— 余额 + 充值 + 流水。
 *
 * ⚠️⚠️ 三条不变量（都来自 docs/design/payment-and-purchase.md）：
 *
 * 1. **价格只从服务端拿**，端侧一份都不写死 —— 小程序审核 1–3 天，
 *    价格绑在发版上就等于不能调价。
 * 2. **发货不认这里的 success 回调**：支付成功后余额是靠**平台推送**到账的，
 *    端侧只负责「提示 + 刷新」。所以这里要**等一会儿**再看余额，而不是直接 +N。
 * 3. **文案由 reason 映射**（服务端只给原文）—— 加一个 reason 不用改接口。
 */

/**
 * reason → 文案。
 * ⚠️ 只映射**固定的几个**；奖励规则的 code 不在这里硬编码（那会随规则表变），
 *    统一落到「奖励」—— 用户关心的是「多了点数」，不是哪条规则发的。
 */
const REASON_TEXT: Record<string, string> = {
  purchase: '充值',
  daily_topup: '每日补足',
  challenge_hold: '挑战消耗',
  challenge_release: '挑战失败退回',
  admin: '运营调整',
  /** ⭐ 看激励视频广告补的能量（prd §7.7）—— 用户要认得出"这笔是看广告来的" */
  ad_reward: '看视频',
}

/** 一位小数都不留的角标数：价格统一用「元」显示，整数元就不带小数点 */
function yuanText(fen: number): string {
  const yuan = fen / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
}

/**
 * ⭐ 商品码 → 道具图（**打包在小程序里**的静态资源）。
 *
 * ⚠️ 为什么图片可以写死在端侧、而价格不行：
 *    图片是随版本发布的资源，改它本来就要发版；
 *    价格是运营要随时能调的东西（见 docs/design/payment-and-purchase.md §2.4）。
 * ⚠️ 认不出来的商品码**不给图**（留空即可），绝不让它把整张卡片搞坏 ——
 *    以后加一档商品时，服务端先上、端侧图后补，中间这段时间是能用的。
 */
const GOODS_IMAGE: Record<string, string> = {
  energy_10: '/assets/energy/e10.png',
  energy_300: '/assets/energy/e300.png',
  energy_3000: '/assets/energy/e3000.png',
}

/** 单价（元 / 点）—— 阶梯定价的说服力全在这个数上，所以固定三位小数 */
function unitText(item: ShopGoodsItem): string {
  return '¥' + (item.priceFen / item.amount / 100).toFixed(3) + ' / 点'
}

interface LedgerRow {
  id: number
  label: string
  deltaText: string
  timeText: string
  /** 入账（绿）还是出账（灰）—— 颜色由它决定，不由 delta 正负现算 */
  income: boolean
}

function toRow(item: EnergyLedgerItem): LedgerRow {
  const income = item.delta > 0
  return {
    id: item.id,
    /** ⚠️ 认不出来的一律叫「奖励」：奖励规则的 code 会变，不该硬编码在端侧 */
    label: REASON_TEXT[item.reason] ?? '奖励',
    deltaText: (income ? '+' : '−') + Math.abs(item.delta),
    timeText: agoText(item.createdAt),
    income,
  }
}

/** 支付成功后等余额「涨上来」—— 最多试 3 次。⚠️ 推送可能有几秒延迟，不是失败 */
async function waitArrival(prevEnergy: number, outTradeNo: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    /**
     * ⭐⭐ **每轮先让服务端去微信查一次单**（⭐ 用户 2026-10-09 报的 ✓）
     *
     * ⚠️ 没有这一步，本机 / 推送丢了的情况下这一笔**永远不会到账** ✗ ——
     *    因为发货原来只等微信推送，而推送地址只有一个 ✓
     * ⚠️ 失败**不影响**轮询 ✗：⭐ 查单只是"顺手推一把" ✓
     *    真的到账了，下面那次 fetchEnergy 照样能看到 ✓
     */
    await checkShopOrder(outTradeNo).catch(() => {
      /* ⚠️ 查不动就算了 —— 别让一次外部失败把"等货"这件事本身搞挂 ✗ */
    })
    try {
      const res = await fetchEnergy()
      if (res.energy > prevEnergy) return true
    } catch {
      /* 拉不到就再试一次；真的拉不到由调用方兜底提示 */
    }
  }
  return false
}

/**
 * ⭐⭐ **激励视频广告实例 —— 模块级单例**（规格 prd §7.7）。
 *
 * ⚠️ 为什么放模块级而不是 `data`：广告对象是**原生对象**，塞进 `data` 会被序列化；
 *    而且官方说明它**默认就是单例**、且**仅当前页面有效** ⇒ 每次进页面重新
 *    `createRewardedVideoAd` 拿到的还是同一个，`data` 里存一份没有任何意义。
 *
 * ⚠️⚠️ 每次进页面必须**先摘掉上一轮的回调再注册**（见 `bindAd`）：
 *    `onClose` 是**可叠加**的 —— 来回进几次能量页就会挂上 N 份，
 *    看一次广告被回调 N 次，而每次用的都是**新生成的 requestId**
 *    ⇒ 服务端幂等键挡不住（id 不同），一次广告发 N 点。这是本功能最容易出事的地方。
 */
let videoAd: WechatMiniprogram.RewardedVideoAd | null = null

/** 拿到（必要时创建）广告实例。⚠️ 基础库过老时 `createRewardedVideoAd` 不存在 → null */
function ensureRewardedAd(): WechatMiniprogram.RewardedVideoAd | null {
  if (videoAd) return videoAd
  if (!wx.createRewardedVideoAd) return null
  videoAd = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_ID })
  return videoAd
}

/** 发奖重试的间隔（毫秒）—— 退避，别把刚抖一下的网又打满 */
const AD_CLAIM_RETRY_DELAYS = [800, 1600]

Page({
  data: {
    navTop: 0,
    loading: true,
    error: '',

    energy: 0,
    perChallenge: 2,
    dailyFloor: 3,

    /**
     * ⭐ 吃饼干换能量（prd §7.7）：手上多少块、能换几点。
     * ⚠️ 余额取自全局 store（它在 refreshMe 之后广播），端侧**不自己算余额**。
     */
    cookieBalance: 0,
    /** 这些饼干能换几点（= floor(余额 / 40)，shared 的纯函数算的） */
    cookieEnergy: 0,
    /** 换 1 点要几块 —— 从 shared 拿，端侧不写死 40 */
    cookiesPerEnergy: COOKIES_PER_ENERGY,
    exchanging: false,

    goods: [] as (ShopGoodsItem & { priceText: string; unitText: string; image: string })[],
    /** 0 现网 / 1 沙箱 —— 沙箱时页面上要标出来，免得测试时以为花的是真钱 */
    payEnv: 0,

    rows: [] as LedgerRow[],
    /** 还有没有更早的流水 */
    hasMore: false,
    loadingMore: false,

    paying: false,
    /** 正在买的商品码 —— 只让那一张卡片转圈 */
    payingCode: '',

    /**
     * ⭐ 看激励视频补能量（prd §7.7）。
     * ⚠️ 承诺文案来自 shared 常量（`adRewardPromiseText`）—— 承诺与实发必须同源，
     *    否则就是官方明禁的「播放后未下发所承诺的奖励」。
     */
    adNote: adRewardPromiseText(),
    /**
     * 按钮上的点数 —— ⚠️ 同样来自 shared 常量（**不写死 1**）：按钮是承诺最显眼的地方，
     *    它和实发不一致就是那条二级违规（见 ad-energy.ts 的文件头）。
     */
    adPoints: AD_REWARD_ENERGY,
    /** 正在看 / 正在发奖 —— 两个阶段都要禁用按钮（防连点） */
    adRewarding: false,
    /**
     * 本次观看的幂等键。
     * ⚠️ 放在 `data` 里是因为它要与页面同生命周期：`onClose` 回来时要用**同一个** id，
     *    重试也用它（换个 id 服务端就会再发一次）。
     */
    adRequestId: '',
  },

  onLoad() {
    this.setData({ navTop: navPadTop() })
    this.bindAd()
    void this.load()
    /** ⚠️ 上一轮"看完了没到账"的那几笔，进来先补 —— 见 lib/ad-energy.ts 的队列说明 */
    void this.retryPendingClaims()
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    notifyNavScroll(this, e.scrollTop)
  },

  onPullDownRefresh() {
    void this.load().finally(() => wx.stopPullDownRefresh())
  },

  /** 商品 + 余额 + 第一页流水。品牌页面的「一次拉完」——不要拆成三个先后到达的空白 */
  async load() {
    this.setData({ error: '' })
    try {
      const [energy, shop] = await Promise.all([fetchEnergy(), fetchShopGoods()])
      this.setData({
        loading: false,
        ...this.cookieData(),
        energy: energy.energy,
        perChallenge: energy.perChallenge,
        dailyFloor: energy.dailyFloor,
        rows: energy.items.map(toRow),
        hasMore: energy.nextBefore !== null,
        goods: shop.items.map((g) => ({
          ...g,
          priceText: '¥' + yuanText(g.priceFen),
          unitText: unitText(g),
          image: GOODS_IMAGE[g.code] ?? '',
        })),
        payEnv: shop.payEnv,
      })
    } catch (err) {
      // ⚠️ 失败时保留已经画出来的内容 —— 拉不到新的不该把看到的也清掉
      this.setData({ loading: false, error: (err as Error).message || '加载失败' })
    }
  },

  /**
   * ⭐ 从全局 store 读饼干余额并算「能换几点」。
   *
   * ⚠️ 端侧**不自己记余额**：`/me` 是唯一的来源（兑换成功后 refreshMe 会广播，
   *    这里重算一遍就自动跟上了）。自己维护一份必然漂移。
   */
  cookieData() {
    const balance = getState().userInfo?.cookies?.balance ?? 0
    return { cookieBalance: balance, cookieEnergy: energyFromCookies(balance) }
  },

  /**
   * ⭐⭐ **吃饼干换能量** —— 一次换完（服务端不接受数量）。
   *
   * ⚠️⚠️ `requestId` **按一次动作生成一个**，并在这次动作里复用：
   *    服务端拿它当两个账本的幂等键。随手写 Date.now() 的话，
   *    连点两下就是两个 id ⇒ 白扣 40 块（见 lib/request-id.ts 的说明）。
   *
   * ⚠️ 换不成服务端也回 200，所以这里要自己看 `ok` 再说人话 —— 不会抛。
   */
  async onExchange() {
    if (this.data.exchanging || this.data.cookieEnergy <= 0) return
    this.setData({ exchanging: true })
    // ⚠️ 在动作开始时就定下来，之后的重试都用它（幂等的前提）
    const requestId = newRequestId('exchange')
    try {
      const r = await exchangeCookies(requestId)
      if (r.ok) {
        wx.showToast({ title: '换到 ' + r.energyGained + ' 点能量', icon: 'none' })
        /**
         * ⚠️ 余额变了（饼干变少、能量变多）⇒ 刷新全局那份 ——
         *    导航栏 / 用户面板 / 连战页都读它，只刷本页会出现两处数字不一样。
         */
        await refreshMe()
      } else {
        wx.showToast({ title: '饼干不够换 1 点（要 ' + this.data.cookiesPerEnergy + ' 块）', icon: 'none' })
      }
      await this.load()
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '兑换失败', icon: 'none' })
    } finally {
      this.setData({ exchanging: false })
    }
  },

  /* ------------------------------------------------------------------ */
  /* ⭐ 看激励视频补能量（prd §7.7 / 调研 docs/research/rewarded-ad-channel.md） */
  /* ------------------------------------------------------------------ */

  /**
   * ⭐⭐ **绑定广告回调** —— 每次进页面都要重新绑，而且要**先摘干净**。
   *
   * ⚠️⚠️ 这是本功能最容易出事的地方：`RewardedVideoAd` 是**单例**、`onClose` **可叠加**。
   *    不先 `offClose()` 就直接 `onClose()` 的话，来回进几次能量页会挂上 N 份回调，
   *    看一次广告被回调 N 次 —— 而每次 onClose 里我们都会**新生成一个 requestId**
   *    ⇒ 服务端幂等键（同一个 id 只发一次）**挡不住**，一次观看发 N 点能量。
   *    `offClose()` 不传参 = 移除该事件**所有**监听函数（官方 API），所以这里最省事也最安全。
   */
  bindAd() {
    const ad = ensureRewardedAd()
    if (!ad) {
      /**
       * ⚠️ 基础库太老（没有 `createRewardedVideoAd`）：说清楚是"版本问题"，
       *    否则用户会以为是我们坏了。
       */
      this.setData({ adNote: '当前微信版本暂不支持广告，升级微信后再试' })
      return
    }
    ad.offClose()
    ad.offError()
    ad.offLoad()

    ad.onClose((res) => {
      void this.onAdClosed(res.isEnded)
    })
    /** 拉到了 → 面板回到"承诺文案"（上一次的错误提示该消失） */
    ad.onLoad(() => {
      if (!this.data.adRewarding) this.setData({ adNote: adRewardPromiseText() })
    })
    /**
     * ⚠️ 加载失败**不算发奖失败**（用户还没看）—— 只把面板文案换成原因。
     *    ⚠️ 同时要把"等待态"清掉：`onError` 之后 `onClose` 不会来，
     *    不清的话按钮会永久卡在"播放中…"。
     */
    ad.onError((err) => {
      this.setData({
        adRewarding: false,
        adRequestId: '',
        adNote: adErrorText((err as { errCode?: number } | undefined)?.errCode),
      })
    })
  },

  /**
   * ⭐⭐ **点「看视频补能量」** —— 拉起激励视频。
   *
   * ⚠️ 幂等键在**动作开始时就定下来**（`adRequestId`），`onClose` 回来时用同一个 ——
   *    连点两下 / 响应丢包重试都只会发一次。随手写 Date.now() 就等于放弃了这道保护。
   */
  onAdReward() {
    if (this.data.adRewarding) return
    const ad = ensureRewardedAd()
    if (!ad) {
      wx.showToast({ title: '当前微信版本暂不支持广告，升级微信后再试', icon: 'none' })
      return
    }
    this.setData({ adRewarding: true, adRequestId: newRequestId('ad'), adNote: '广告播放中…' })

    /**
     * ⚠️ 官方推荐写法：`show()` 失败先 `load()` 再 `show()` 一次。
     *    ⚠️ 两次都失败 ⇒ **什么都没发生**（没进入播放 ⇒ `onClose` 不会来），
     *    所以这里必须自己把等待态清掉，并把原因写到面板上。
     */
    ad.show()
      .catch(() => ad.load().then(() => ad.show()))
      .catch((err: { errCode?: number } | undefined) => {
        this.setData({
          adRewarding: false,
          adRequestId: '',
          adNote: adErrorText(err?.errCode),
        })
        wx.showToast({ title: adErrorText(err?.errCode), icon: 'none' })
      })
  },

  /**
   * 广告关闭回调。
   *
   * ⚠️⚠️ **只有 `isEnded === true` 才发**（中途关掉不发）——
   *    《小程序流量主行为规范》把「激励视频广告未完全播放（提前关闭），流量主照常下发奖励」
   *    列为**二级违规**（可冻结权限并扣当月收入）。这条不能"通融一下"。
   */
  async onAdClosed(isEnded: boolean) {
    const requestId = this.data.adRequestId
    this.setData({ adRewarding: false, adRequestId: '' })
    if (!isEnded) {
      wx.showToast({ title: '要看完整个视频才有能量哦', icon: 'none' })
      return
    }
    /** ⚠️ 理论到不了：不是我们拉起的那次关闭。真到了也只能什么都不做（没有幂等键） */
    if (!requestId) return
    await this.deliverAdReward(requestId)
  },

  /**
   * ⭐ **把一次观看兑现成能量** —— 失败要重试，重试要用**同一个 requestId**。
   *
   * ⚠️⚠️ 为什么必须重试：官方把「激励视频广告**播放后未下发所承诺的奖励**」也列为二级违规。
   *    用户看完了、我们却没发，是**我们违规**，不是"网络不好"。
   *    ⭐ 而重试之所以安全，正是因为 requestId 是幂等键：重复提交最多多发一次"空请求"，
   *    绝不会多发点数。
   *
   * ⚠️ 三种落点分得很清楚（见 `AdEnergyResponse`）：
   *    · 真发了 → 报 +N，并刷新全局余额；
   *    · 重放（ok 但没发）→ **不弹**：点数早在账上，说 +1 是假的；
   *    · 没发 → 记进待补发队列，并如实告诉用户"稍后补"。
   */
  async deliverAdReward(requestId: string) {
    const res = await this.claimWithRetry(requestId)

    if (res.ok) {
      /** ⚠️ 成功就把它从待补队列里摘掉（也可能本来就不在里面，摘是幂等的） */
      forgetPendingClaim(requestId)
      const toast = adRewardToast(res)
      if (toast) wx.showToast({ title: toast, icon: 'none' })
      /**
       * ⚠️ 余额变了 ⇒ 刷新全局那份（导航栏 / 用户面板都读它），
       *    只刷本页会让两处数字不一样。
       */
      if (res.energyGained > 0) await refreshMe()
      await this.load()
      return
    }

    /**
     * ⚠️ `too-soon` 只有脚本会撞上，但它**不能算丢**：这是同一笔该发的奖，
     *    留着下次进来补（面板上照实说"稍后再试"）。
     */
    rememberPendingClaim(requestId)
    wx.showToast({
      title: res.reason === 'too-soon' ? (adRewardToast(res) ?? '稍后再试') : adClaimFailedText(),
      icon: 'none',
      duration: res.reason === 'too-soon' ? 2000 : 3200,
    })
  },

  /**
   * ⭐ **发奖请求（带退避重试）**。
   *
   * ⚠️ 只对**网络/超时**重试；服务端明确回的 `ok:false`（too-soon / unavailable）**不重试** ——
   *    立刻重试只会得到同一个答案，白打两次请求。
   * ⚠️ 三次都用**同一个** requestId（调用方传进来的那个）。
   */
  async claimWithRetry(requestId: string): Promise<AdEnergyResponse> {
    for (let i = 0; ; i++) {
      try {
        /**
         * ⚠️ 拿到 HTTP 响应就**直接返回**，不管 `ok` 是 true 还是 false：
         *    服务端明确回的 too-soon / unavailable 立刻重试只会得到同一个答案。
         */
        return await claimAdEnergy(requestId)
      } catch {
        if (i >= AD_CLAIM_RETRY_DELAYS.length) {
          return { ok: false, energyGained: 0, energy: this.data.energy, reason: 'unavailable' }
        }
        await new Promise((resolve) => setTimeout(resolve, AD_CLAIM_RETRY_DELAYS[i]))
      }
    }
  },

  /**
   * ⭐ **补发上一次没到账的那几笔**（进页面就跑一次）。
   *
   * ⚠️ 这是「承诺了必须发」的**兜底闭环**：上一条 `adClaimFailedText()` 里那句
   *    "稍后会补给你"指的就是这里 —— 文案与机制必须成对存在。
   * ⚠️ 每笔都用它**原来那个** requestId（幂等），所以补发绝不会变成发两次。
   */
  async retryPendingClaims() {
    const ids = readPendingClaims()
    if (ids.length === 0) return
    let gained = 0
    for (const id of ids) {
      try {
        const res = await claimAdEnergy(id)
        if (res.ok) {
          forgetPendingClaim(id)
          gained += res.energyGained
        }
      } catch {
        /* 还是不行就留着，下次进页面再补 */
      }
    }
    if (gained > 0) {
      wx.showToast({ title: '补发了 ' + gained + ' 点能量', icon: 'none' })
      await refreshMe()
      await this.load()
    }
  },

  /** 翻更早的流水（游标：拿最后一条的 id 当 before） */
  async onMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    const last = this.data.rows[this.data.rows.length - 1]
    if (!last) return
    this.setData({ loadingMore: true })
    try {
      const res = await fetchEnergy(last.id)
      this.setData({
        rows: this.data.rows.concat(res.items.map(toRow)),
        hasMore: res.nextBefore !== null,
      })
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  /**
   * ⭐ 充值：下单 → 拉起虚拟支付 → 刷新。
   *
   * ⚠️ 支付成功后**不能直接给余额加 N** —— 到账是平台推送驱动的，
   *    端侧只是「等它到账，然后显示」。直接加会造出第二份真相：
   *    推送失败时用户以为到账了，刷新一下就没了。
   */
  async onBuy(e: WechatMiniprogram.BaseEvent) {
    const code = (e.currentTarget.dataset as { code?: string }).code
    if (!code || this.data.paying) return
    const item = this.data.goods.find((g) => g.code === code)
    if (!item) return
    if (!item.sellable) {
      wx.showToast({ title: '这个档位暂时买不了', icon: 'none' })
      return
    }

    this.setData({ paying: true, payingCode: code })
    const before = this.data.energy
    try {
      const order = await createShopOrder(code)

      /** mock 通道（本地）：服务端已经替我们把货发了，不用拉起支付 */
      if (!order.mockPaid) {
        await new Promise<void>((resolve, reject) => {
          /**
           * ⚠️⚠️ 必须**原样传服务端签好的 signData 字符串**，而且要绕过 typings：
           *
           *    基础库的 d.ts 把 signData 标成了对象（SignData 接口），
           *    但官方文档写得很清楚「该参数需以 **string** 形式传递」。
           *
           *    ⚠️ 千万别为了迁就类型去 JSON.parse 成对象 —— 那等于让平台**重新序列化**一次，
           *       键顺序或空格一变，签名就对不上，报 -15006（支付签名错），
           *       而排查方向会先去怀疑算法和 AppKey。
           *       服务端签的就是这个字符串，必须逐字节一致。
           */
          const payOption = order.payData as unknown as WechatMiniprogram.RequestVirtualPaymentOption
          wx.requestVirtualPayment({
            ...payOption,
            success: () => resolve(),
            fail: (err) =>
              reject(new Error(explainXpayError((err as { errCode?: number }).errCode, err.errMsg))),
          })
        })
      }

      const arrived = await waitArrival(before, order.outTradeNo)
      await this.load()
      void refreshMe()
      if (!arrived) {
        /** ⚠️ 支付成功但余额还没动：说清是「到账延迟」，而不是「失败」 */
        wx.showToast({ title: '支付成功，到账可能要几秒 —— 下拉刷新看看', icon: 'none', duration: 2600 })
      } else {
        wx.showToast({ title: '已到账 +' + order.points + ' 点', icon: 'none' })
      }
    } catch (err) {
      wx.showToast({ title: (err as Error).message || '支付失败', icon: 'none', duration: 2600 })
    } finally {
      this.setData({ paying: false, payingCode: '' })
    }
  },

  onRetry() {
    void this.load()
  },
})
