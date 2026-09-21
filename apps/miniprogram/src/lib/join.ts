import { fetchMe } from './api/client'
import * as me from './store'

/** 「加入句拼」页（wx.navigateTo 用的带斜杠形式） */
export const JOIN_PAGE = '/pages/join/join'
/** 页面栈里那一页的 route 写法（无斜杠）—— 用来判断"是不是已经在这一页了" */
const JOIN_ROUTE = 'pages/join/join'
/** 兜底回首页 —— 与 lib/nav.ts 里那份保持一致 */
export const HOME_PAGE = '/pages/index/index'

/**
 * ⭐ 「加入句拼」这件事的**唯一入口** —— 所有需要"榜上有名"的地方都调它。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它回答的是**两个不同的问题**，而这两件事必须分开处理：
 *
 *   ① 我已经**加入过了**（服务端有我的昵称）→ 直接放行，什么都别问。
 *   ② 我**还没加入**（服务端那边我还没有名字）→ 才谈得上「加入」这一步。
 *
 * ⚠️⚠️ 为什么不能只看本地：换手机、删了小程序、清了缓存之后，
 *    本地什么都没有，但**账号其实一直在服务端**（身份是 openid，不是这台设备）。
 *    这时候直接要他"加入"，等于让一个老用户重新认领一次自己 ——
 *    他会以为「我的成绩没了」。
 *    所以判定顺序永远是：**先问服务端，再决定要不要问用户**。
 * ══════════════════════════════════════════════════════════════════
 *
 * 「加入过了」的判据仍然只有一条：**昵称非空**（见 store 的 hasJoined）。
 * 那正好就是服务端「这个 openid 认领过名字没有」的答案。
 *
 * @returns true = 现在可以继续；false = 已经跳去加入页，等用户弄完回来
 */
export async function ensureJoined(): Promise<boolean> {
  if (me.hasJoined()) return true

  try {
    const profile = await fetchMe()
    // ⭐ 服务端认识我（有昵称）→ 把资料写回本地就算「加入过了」，不必打扰用户
    if ((profile.nickname ?? '').trim()) {
      me.applyProfile(profile)
      return true
    }
  } catch (err) {
    /**
     * ⚠️ 取不到 ≠ 还没加入。
     *
     *    但这里**不能**选择「放行」：没有昵称就没有账号，挑战的成绩无处可挂。
     *    也**不能**选择「静默失败」：用户点了按钮却什么都没发生，比多问一步更糟。
     *    ⇒ 退回「让他去加入页」这条路 —— 它至少把话说清楚了，
     *      而且真的填完提交时，网络错误会**在加入页上**当场报出来。
     */
    console.warn('[join] 取用户资料失败，退回加入流程：' + (err as Error).message)
  }

  openJoinPage()
  return false
}

/**
 * 跳到「加入句拼」页。
 *
 * ⚠️ 这一页是 navigateTo 压上去的，所以「确认加入」能 navigateBack 回原页。
 * ⚠️ 已经在那一页上就不要再压一层（导航栏、用户面板、挑战入口都可能调它）——
 *    否则会叠出两三个一样的页面，返回要按好几次。
 */
export function openJoinPage(): void {
  const stack = getCurrentPages()
  const current = stack[stack.length - 1] as { route?: string } | undefined
  if (current?.route === JOIN_ROUTE) return
  wx.navigateTo({ url: JOIN_PAGE, fail: () => wx.reLaunch({ url: JOIN_PAGE }) })
}
