import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { XPAY_MODE, XPAY_URI, buildSignData, calcPaySig, calcSignature } from './xpay'

/**
 * ⭐⭐ 这里有一条**官方测试向量**（微信支付文档《签名详解》里给的断言值）。
 *
 * ⚠️ 它为什么值得单独立一个用例：签名是整套支付里**唯一无法靠读代码发现错误**的一环 ——
 *    算错了不会崩、不会报类型错，只会在真机上以「-15005 / -15006 签名错误」的形式出现，
 *    而那时你会去怀疑 AppKey、怀疑配置，不会想到是算法本身。
 *
 *    有了这条向量，算法本身就被钉死了：只要它绿，签名不一致就只可能是
 *    「signData 与实际发出的内容不一致」或「AppKey 拿错环境」。
 */
describe('虚拟支付签名 —— 官方测试向量', () => {
  // 文档原文的输入（注意 JSON 里的空格是**故意**的：它要的就是逐字节一致）
  const body = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'
  const appKey = '12345'
  const sessionKey = '9hAb/NEYUlkaMBEsmFgzig=='

  it('paySig = hex(hmac_sha256(appKey, uri + & + signData))', () => {
    expect(calcPaySig('/xpay/query_user_balance', body, appKey)).toBe(
      'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5',
    )
  })

  it('signature = hex(hmac_sha256(sessionKey, signData))', () => {
    expect(calcSignature(body, sessionKey)).toBe(
      '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7',
    )
  })

  /** ⚠️ 分隔符是 & —— 少写或多加都会让签名错，而错了也看不出来 */
  it('paySig 的原文是 uri + & + signData', () => {
    const mac = (msg: string) => createHmac('sha256', 'k').update(msg).digest('hex')
    expect(calcPaySig('uri', 'body', 'k')).toBe(mac('uri&body'))
    expect(calcPaySig('uri', 'body', 'k')).not.toBe(mac('uribody'))
    expect(calcPaySig('uri', 'body', 'k')).not.toBe(mac('uri body'))
  })

  it('基础库接口的 uri 是固定字符串，不是路径', () => {
    expect(XPAY_URI.requestVirtualPayment).toBe('requestVirtualPayment')
    expect(XPAY_MODE.goods).toBe('short_series_goods')
  })
})

describe('signData 构造', () => {
  const input = {
    outTradeNo: 'JP1758500000000abcdef',
    productId: 'prod_energy_300',
    goodsPriceFen: 2000,
    attach: 'u:42',
  }

  it('能原样解回来，且关键字段都对', () => {
    const parsed = JSON.parse(buildSignData(input)) as Record<string, unknown>
    expect(parsed.outTradeNo).toBe(input.outTradeNo)
    expect(parsed.productId).toBe(input.productId)
    expect(parsed.goodsPrice).toBe(2000)
    expect(parsed.buyQuantity).toBe(1)
    expect(parsed.currencyType).toBe('CNY')
  })

  /**
   * ⚠️⚠️ 这条是**整个支付里最容易犯的错**：
   *    签名的原文和发出去的 signData 必须是**同一个字符串**。
   *    重新 JSON.stringify 一次（哪怕字段完全一样）也可能因为键顺序/空格不同而对不上，
   *    报出来的是「签名错误」，方向完全跑偏。
   */
  it('⭐ 同一个输入产出的字符串是稳定的（键顺序不能变）', () => {
    expect(buildSignData(input)).toBe(buildSignData(input))
    expect(buildSignData(input).indexOf('offerId')).toBeLessThan(buildSignData(input).indexOf('outTradeNo'))
  })

  it('金额是整数分（不是元，也不能是小数）', () => {
    const parsed = JSON.parse(buildSignData(input)) as { goodsPrice: number }
    expect(Number.isInteger(parsed.goodsPrice)).toBe(true)
  })
})

/** ⚠️ 错误码翻译的用例搬去了 packages/shared/src/xpay.test.ts —— 那张表在 shared 里，
 *    因为端侧同样要用它（wx.requestVirtualPayment 的 fail 会拿到 errCode）。 */
