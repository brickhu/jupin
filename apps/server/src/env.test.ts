import { describe, expect, it } from 'vitest'

import { parseEnvLine } from './env'

/**
 * ⚠️⚠️ 这些用例存在的唯一理由：**行内注释曾经静默毁掉过一次支付签名**。
 *
 *    `.env` 里写 `XPAY_APP_KEY=abc123  # 现网` 时，值原样进 process.env，
 *    于是签名算出来是错的，而报错是 -15006（支付签名错）——
 *    排查会先怀疑算法、再怀疑拿错环境，绝不会想到「值尾多了一段注释」。
 *
 *    这一条同时适用于两个解析器（这里的 parseEnvLine 与 tools/env.mjs 的 parseEnvFile），
 *    它们的规则必须一致。
 */
describe('解析 .env 的一行', () => {
  it('⭐ 剥掉行内注释', () => {
    expect(parseEnvLine('XPAY_APP_KEY=abc123  # 现网')).toEqual(['XPAY_APP_KEY', 'abc123'])
    expect(parseEnvLine('K=v# 前面没空白，算值的一部分')).toEqual(['K', 'v# 前面没空白，算值的一部分'])
  })

  it('值内部的 # 不动（密码里可能有）', () => {
    expect(parseEnvLine('K=a#b')).toEqual(['K', 'a#b'])
    expect(parseEnvLine('K=a#b c')).toEqual(['K', 'a#b c'])
  })

  it('值两边的空白不要（手抄配置最容易带进来）', () => {
    expect(parseEnvLine('K=  abc  ')).toEqual(['K', 'abc'])
  })

  it('空值是合法的（有些键就是留空）', () => {
    expect(parseEnvLine('K=')).toEqual(['K', ''])
    expect(parseEnvLine('K=   # 说明')).toEqual(['K', ''])
  })

  it('值里可以有 =（连接串就是这样）', () => {
    expect(parseEnvLine('DATABASE_URL=mysql://a:b@c/d?x=1')).toEqual([
      'DATABASE_URL',
      'mysql://a:b@c/d?x=1',
    ])
  })

  it('整行注释、空行、非法行都返回 null（不写进 process.env）', () => {
    expect(parseEnvLine('# 说明')).toBeNull()
    expect(parseEnvLine('')).toBeNull()
    expect(parseEnvLine('   ')).toBeNull()
    expect(parseEnvLine('不是 KEY=VALUE')).toBeNull()
    expect(parseEnvLine('小写键=1')).toBeNull()
  })
})
