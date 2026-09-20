/**
 * 自定义导航栏的尺寸 —— 全局只有这一处算。
 *
 * ⚠️⚠️ 为什么必须自定义导航栏（navigationStyle: custom）：
 *    原生导航栏左侧**永远是返回箭头**，没有任何配置能把它换成一个头像；
 *    标题也只能是页面 *.json 里的静态字符串。
 *    要做「左头像 / 中间标题 / 点头像拉开用户面板」，只有这一条路。
 *
 * ⚠️⚠️ 代价：原生导航栏原本替我们让开的那块高度**没有了**，
 *    页面内容会直接顶到屏幕最上沿（首页那个大字会压在状态栏的时间上）。
 *    所以每个页面的根节点都必须自己让出 navPadTop() 那么高：
 *
 *        <view class="..." style="padding-top:{{navTop}}px">
 *
 *    这件事**不报错**，只在真机上看着不对 ——
 *    表现就是「那一页的标题和时间重叠了」。所以高度一律从这里取，
 *    页面里不要再出现 44 / 88 这类魔法数字。
 *
 * ⚠️ 导航栏高度**不能写死**：它由胶囊按钮的位置决定，而胶囊在
 *    刘海机 / 灵动岛 / 安卓各厂商 / iPad 上的位置都不一样。
 *    写死一个值的后果是标题和胶囊不在同一条水平线上，一眼就能看出来。
 */

/** 兜底：状态栏高度（iPhone 6/7/8 是 20；刘海机普遍 44+） */
const FALLBACK_STATUS_BAR = 20
/** 兜底：导航栏内容区高度（拿不到胶囊位置时用） */
const FALLBACK_BAR_HEIGHT = 44
/** 兜底：胶囊按钮宽度 —— 标题要居中就必须让开它 */
const FALLBACK_SIDE_WIDTH = 87
/**
 * ⚠️ 导航栏高度的合法区间。
 *    getMenuButtonBoundingClientRect() 在开发者工具刚启动、或低版本基础库上
 *    会返回**全 0**，拿它算出来的是负的留白 —— 不夹一下就会得到负高度，
 *    表现是整页内容往上窜、标题压进状态栏。
 */
const MIN_BAR_HEIGHT = 28
const MAX_BAR_HEIGHT = 96
/** 胶囊宽度超过这个值一定是异常数据（正常 ~87，iPad 也不会超过 200） */
const MAX_SIDE_WIDTH = 200

/** 胶囊按钮的位置（wx.getMenuButtonBoundingClientRect 的子集） */
export interface CapsuleRect {
  top?: number
  height?: number
  width?: number
}

export interface NavMetrics {
  /** 状态栏高度（刘海 / 灵动岛那一条） */
  statusBarHeight: number
  /** 导航栏内容区高度（不含状态栏）—— 左中右三个控件都在这一条带子里 */
  navBarHeight: number
  /** 状态栏 + 导航栏 = 页面内容必须让开的净高 */
  totalHeight: number
  /** 左侧控件与右侧留白的宽度：取胶囊宽度，标题才是**真正**居中的 */
  sideWidth: number
}

/**
 * 纯函数：由「状态栏高度 + 胶囊位置」算出导航栏尺寸。
 *
 * ⚠️ 抽出来是为了能单测 —— 它全是边界（胶囊缺失、全 0、负数、超大值），
 *    而这些边界在真机上都会变成「位置不对」，却没有任何报错。
 */
export function computeNavMetrics(input: {
  statusBarHeight?: number | null
  capsule?: CapsuleRect | null
}): NavMetrics {
  const rawStatus = Number(input.statusBarHeight)
  const statusBarHeight =
    Number.isFinite(rawStatus) && rawStatus > 0 && rawStatus <= 100 ? rawStatus : FALLBACK_STATUS_BAR

  const cap = input.capsule ?? {}
  const top = Number(cap.top)
  const height = Number(cap.height)
  const width = Number(cap.width)

  // ⚠️ 判据是「胶囊整体落在状态栏**下方**」。
  //    正常设备上胶囊上沿比状态栏下沿还低几个像素，而且上下留白相等 ——
  //    导航栏的内容区高度就是「胶囊高 + 上下留白」。
  //    全 0 的异常返回值不满足这一条，会被兜底接住。
  const usable =
    Number.isFinite(height) && height > 0 && Number.isFinite(top) && top >= statusBarHeight
  const raw = usable ? height + (top - statusBarHeight) * 2 : FALLBACK_BAR_HEIGHT
  const navBarHeight = Math.min(MAX_BAR_HEIGHT, Math.max(MIN_BAR_HEIGHT, Math.round(raw)))

  const sideWidth =
    Number.isFinite(width) && width > 0 && width <= MAX_SIDE_WIDTH ? width : FALLBACK_SIDE_WIDTH

  return {
    statusBarHeight,
    navBarHeight,
    totalHeight: statusBarHeight + navBarHeight,
    sideWidth,
  }
}

let cached: NavMetrics | null = null

/**
 * 取当前设备的导航栏尺寸（只算一次并缓存）。
 *
 * ⚠️ 缓存是安全的：小程序没有横竖屏切换，窗口尺寸在生命周期里不会变，
 *    而每个页面的 nav-bar 组件都会问一次。
 */
export function getNavMetrics(): NavMetrics {
  if (cached) return cached

  let statusBarHeight: number | undefined
  try {
    // ⚠️ 优先 getWindowInfo（2.20.1+），它没被废弃；
    //    getSystemInfoSync 仍然可用但会打废弃警告，只当兜底。
    //    用 as 是因为这两个 API 在 typings 版本不同的情况下不一定都存在。
    const w = wx as unknown as {
      getWindowInfo?: () => { statusBarHeight?: number }
      getSystemInfoSync?: () => { statusBarHeight?: number }
    }
    const info = typeof w.getWindowInfo === 'function' ? w.getWindowInfo() : w.getSystemInfoSync?.()
    statusBarHeight = info?.statusBarHeight
  } catch {
    // 拿不到就交给 computeNavMetrics 兜底
  }

  let capsule: CapsuleRect | null = null
  try {
    capsule = wx.getMenuButtonBoundingClientRect()
  } catch {
    // 同上
  }

  cached = computeNavMetrics({ statusBarHeight, capsule })
  return cached
}

/**
 * 导航栏下沿与页面内容上沿之间的留白（px）—— 页面原本的 pt-3。
 *
 * ⚠️ navPadTop() 和 navSolidFrom() 都从它算，**必须同一个常量**：
 *    两者回答的是同一个问题（内容的上沿在哪），差 1px 就会出现
 *    「内容已经压到导航栏底下了，白底还没出来」这种说不清的瑕疵。
 */
const CONTENT_GAP = 12

/**
 * 页面根节点要让开的上边距（px）。
 *
 * ⚠️ 页面里写 style="padding-top:{{navTop}}px" 时**不要**再留 pt-3，
 *    两者相加会多出 12px（看不出来，但每一页都会矮一截）。
 */
export function navPadTop(): number {
  return getNavMetrics().totalHeight + CONTENT_GAP
}

/**
 * ⭐ 页面内容**刚好与导航栏下沿相交**时的 scrollTop —— 导航栏的白底从这一刻开始出现。
 *
 * ⚠️ 不是 0：内容本来就在导航栏下面 CONTENT_GAP 处，
 *    scrollTop 走到 CONTENT_GAP 时它的上沿才真正贴上导航栏底边。
 */
export function navSolidFrom(): number {
  return CONTENT_GAP
}

/** 导航栏组件上，本模块要调的那个方法 */
interface NavLike {
  applyScrollTop?: (scrollTop: number) => void
}

/**
 * 页面对象 → 导航栏组件实例。
 *
 * ⚠️ 缓存是因为 onPageScroll **每帧**都触发，而 selectComponent 每次都真的要
 *    去组件树里找一个来回 —— 每帧找一次纯属白烧。
 *    用 WeakMap 挂在页面对象上，页面销毁即回收，不会漏。
 * ⚠️ 本模块是被**内联**进各个页面包的（它没有状态），
 *    所以每个页面用的是自己那份缓存，正好只装自己那个页面。
 */
const navRefs = new WeakMap<object, NavLike>()

/**
 * 页面 `onPageScroll` 里调它，把滚动位置递给本页的导航栏。
 *
 * ⚠️⚠️ 为什么非得由页面转这一手：小程序里**只有页面**有 onPageScroll 生命周期，
 *    组件没有；而导航栏是 fixed 的，它自己不动，也就永远观察不到页面在滚。
 *    「页面正在滚」这件事只能由页面主动说出去。
 *
 * ⚠️ 页面里的导航栏要写 id="nav" —— 三个页面统一这么写，别只改其中一个。
 */
export function notifyNavScroll(page: unknown, scrollTop: number): void {
  const key = page as object
  let nav = navRefs.get(key)
  if (!nav) {
    const select = (key as { selectComponent?: (s: string) => unknown }).selectComponent
    const found = typeof select === 'function' ? (select.call(key, '#nav') as NavLike | null) : null
    // ⚠️ 找不到就**不缓存**：导航栏可能还没挂上去，下一次滚动再找一遍。
    //    把 null 缓存下来的话它会永远找不到，症状是「白底再也不出现」，
    //    而那是静默的 —— 没有任何东西会报错。
    if (found) {
      nav = found
      navRefs.set(key, found)
    }
  }
  nav?.applyScrollTop?.(scrollTop)
}
