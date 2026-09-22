/**
 * ⭐ 虚拟支付的**错误码 → 人话**。
 *
 * ⚠️ 为什么放在 shared 而不是服务端：这些码**两端都会拿到** ——
 *    · 服务端：调 /xpay/* 时（查单、退款）
 *    · 端侧：wx.requestVirtualPayment 的 fail 回调（errCode）
 *    而用户看到的是端侧那一句。两边各维护一份，迟早出现「同一个码两种说法」。
 *
 * ⚠️ 这些码值得**逐条翻译**：它们几乎都指向「配置/发布流程没走完」而不是代码 bug ——
 *    直接甩一个 -15013 给用户，等于什么也没说。
 *
 * 来源：https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
 */
export const XPAY_ERROR: Record<string, string> = {
  '-1': '支付失败，请重试',
  '-2': '你取消了支付',
  '-4': '支付被风控拦截',
  '-15002': '这笔订单号已经用过了，请重新发起',
  '-15005': '登录态签名失效，请重新进入小程序再试',
  '-15006': '支付签名不对（检查 AppKey 与签名算法）',
  '-15007': '登录态已过期，请重新进入小程序再试',
  '-15008': '虚拟支付二级商户进件还没完成',
  '-15009': '代币还没发布',
  '-15010': '这个道具还没发布（去「道具管理」发布到现网）',
  '-15011': '现网版本不能用沙箱环境（env 必须为 0）',
  '-15012': '微信侧关单了，请重新发起',
  '-15013': '订单金额与微信侧道具价格不一致（改价后两边要对齐）',
  '-15014': '道具刚发布，大约 10 分钟后才能下单',
  '-15016': 'signData 格式有问题',
  '-15017': '商户收款功能被限制（去微信支付商户平台看原因）',
  '-15018': '道具审核没通过',
  '-15019': '商户受限，去微信支付商户平台看原因',
  '-15020': '操作过快，稍后再试',
  '-15021': '小程序交易被限频',
}

/** 把错误码翻成人话；认不出来就原样带上，别丢信息 */
export function explainXpayError(errCode: number | undefined, errMsg?: string): string {
  if (errCode === undefined || errCode === 0) return errMsg ?? '支付失败'
  const known = XPAY_ERROR[String(errCode)]
  return known ? known + '（' + errCode + '）' : (errMsg ?? '支付失败') + '（' + errCode + '）'
}
