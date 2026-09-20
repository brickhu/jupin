/**
 * ⭐ 打分成功后，**直接让上一页重新拉一次数据**。
 *
 * ⚠️⚠️ 这是**第三道**保障，而且是最笨、最不可能失效的一道：
 *
 *    ① store 订阅 —— 不发请求就立刻更新，但它依赖回调真的跑通；
 *    ② onShow 重拉 —— 回到页面时数据一定是服务端的，但它依赖页面在栈里、
 *       而且依赖 onShow 真的触发；
 *    ③ **这一条** —— 直接拿到上一页的实例，调它的 load()。
 *
 *    ①②都出过问题（订阅回调抛异常被吞、朗读页是栈里唯一一页），
 *    而这一条不看生命周期、不看订阅、不看时序 —— 只问「上一页是谁」。
 *
 * ⚠️ 隐藏的页面调 setData 是允许的，小程序不报错；
 *    等用户返回时数据早就到位了，连骨架屏都不用闪。
 *
 * ⚠️ 必须按 route 分派，不能一律调 load()：
 *    竞技场页的 load 需要日期参数，调错会把页面刷成空。
 */
export function refreshPreviousPage(): void {
  try {
    const pages = getCurrentPages()
    const prev = pages[pages.length - 2] as
      | { route?: string; load?: (arg?: string) => unknown; data?: { date?: string } }
      | undefined
    if (!prev?.route || typeof prev.load !== 'function') return

    if (prev.route === 'pages/index/index') {
      void prev.load()
      return
    }
    if (prev.route === 'pages/arena/arena') {
      void prev.load(prev.data?.date)
    }
  } catch (err) {
    // ⚠️ 兜底本身不该反过来把主流程弄崩
    console.warn('[refresh] 刷新上一页失败：' + (err as Error).message)
  }
}
