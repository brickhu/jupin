import { env } from '../env'

/**
 * ⭐ auth.code2Session：wx.login 的 code → openid + **session_key**。
 *
 * ⚠️ 为什么要单独一个模块，而不是散在路由里：
 *    这个接口现在有两个调用者（登录换 token、下单前刷新 session_key），
 *    而它涉及 AppSecret —— 两处各写一遍，迟早有一处漏掉错误分支。
 *
 * ⚠️ 线上主通道是 callContainer：openid 由网关注入，**根本不需要这条路**。
 *    但虚拟支付的**用户态签名**需要 session_key，而那个东西只有这条路能给 ——
 *    这就是它必须存在的原因（见 docs/design/payment-and-purchase.md §5.2）。
 */

export interface WxSessionResult {
  openid: string
  sessionKey: string
  unionid?: string
}

/** 换不到身份时抛这个 —— 调用方据此决定「报错」还是「本地兜底合成身份」 */
export class WxLoginError extends Error {}

export async function code2session(code: string): Promise<WxSessionResult> {
  const appId = process.env.WX_APPID
  const secret = process.env.WX_SECRET
  if (!appId || !secret) throw new WxLoginError('服务端未配置 WX_APPID / WX_SECRET')

  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', secret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  const res = await fetch(url)
  const data = (await res.json()) as {
    openid?: string
    session_key?: string
    unionid?: string
    errmsg?: string
  }
  if (!data.openid) {
    throw new WxLoginError('微信登录失败: ' + (data.errmsg ?? '没有返回 openid'))
  }
  /**
   * ⚠️ session_key 缺失**不算登录失败**（openid 拿到了就说明身份没问题），
   *    但虚拟支付会走不下去 —— 所以返回空串，由调用方决定怎么处理，
   *    而不是在这里把整次登录判死（那会让用户连小程序都进不来）。
   */
  return { openid: data.openid, sessionKey: data.session_key ?? '', unionid: data.unionid }
}

/** AppSecret 配没配 —— 决定走真实路径还是本地合成的兜底身份 */
export function hasAppSecret(): boolean {
  return Boolean(process.env.WX_APPID && process.env.WX_SECRET)
}

/** ⚠️ 只在本地/非生产用；线上没配密钥应该直接失败，而不是给所有人一个共享账号 */
export function syntheticIdentity(as?: string): WxSessionResult {
  const name = typeof as === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(as) ? as : (process.env.DEV_OPENID ?? 'local')
  return { openid: 'dev_' + name, sessionKey: 'dev_session_' + name }
}

/** env 在这里只用来判生产环境，import 保持可见，避免被误删 */
export const IS_PRODUCTION = env.NODE_ENV === 'production'
