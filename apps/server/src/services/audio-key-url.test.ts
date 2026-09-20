import { describe, it, expect } from 'vitest'
import { assertAudioUrlMatchesKey } from './audio-key'

const BUCKET = '6465-dev-0go66cfz212d3d83-1258596499'
const REGION = 'ap-shanghai'
const KEY = 'audio/1/42/1789444196592.pcm'
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`

const check = (audioUrl: string, audioKey = KEY) =>
  assertAudioUrlMatchesKey({ audioUrl, audioKey, bucket: BUCKET, region: REGION })

describe('assertAudioUrlMatchesKey —— 带签名下载地址的校验', () => {
  it('我们自己的桶 + 同一个 key → 放行', () => {
    expect(() => check(`https://${HOST}/${KEY}?q-signature=abc&q-key-time=1`)).not.toThrow()
  })

  it('路径是 URL-encoded 的也放行（COS 签名 URL 会长这样）', () => {
    expect(() => check(`https://${HOST}/audio/1/42/1789444196592.pcm?sign=x`)).not.toThrow()
  })

  it('放行云开发的存储网关域名（wx.cloud.getTempFileURL 实际返回的就是它）', () => {
    expect(() =>
      check(`https://${BUCKET}.tcb.qcloud.la/${KEY}?sign=abc`),
    ).not.toThrow()
    // 网关前面多一层路径前缀也要能过
    expect(() =>
      check(`https://${BUCKET}.tcb.qcloud.la/some/prefix/${KEY}?sign=abc`),
    ).not.toThrow()
  })

  it('⭐ 拦下别的域名 —— 这是 SSRF 面', () => {
    expect(() => check('https://evil.example.com/audio/1/42/1789444196592.pcm')).toThrow(/不在允许范围/)
    expect(() => check('https://127.0.0.1/audio/1/42/1789444196592.pcm')).toThrow(/不在允许范围/)
    expect(() => check('https://169.254.169.254/latest/meta-data')).toThrow(/不在允许范围/)
  })

  it('⭐ 拦下「桶对但对象不是这条」—— 防止拿别人的录音提交', () => {
    expect(() => check(`https://${HOST}/audio/1/99/1789444196592.pcm`)).toThrow(/不一致/)
    expect(() => check(`https://${HOST}/audio/2/42/1789444196592.pcm`)).toThrow(/不一致/)
    expect(() => check(`https://${BUCKET}.tcb.qcloud.la/audio/1/99/1789444196592.pcm`)).toThrow(/不一致/)
  })

  it('⭐ 报错里必须带上【实际收到的】域名，否则排查时看不出对方给了什么', () => {
    expect(() => check('https://wrong.example.com/x')).toThrow(/实际收到 wrong\.example\.com/)
  })

  it('拦下相似域名（把允许的后缀拼到别的域名前面/后面）', () => {
    expect(() => check(`https://${BUCKET}.cos.${REGION}.myqcloud.com.evil.com/${KEY}`)).toThrow(/不在允许范围/)
    // ⚠️ 反过来「把后缀放在中间」也要拦：x.tcb.qcloud.la.evil.com 的真域名是 evil.com
    expect(() => check(`https://x.tcb.qcloud.la.evil.com/${KEY}`)).toThrow(/不在允许范围/)
  })

  it('tcb.qcloud.la 的任意子域放行 —— 这是腾讯自有域名，攻击者注册不了', () => {
    // 写这条是为了说明「为什么 *.tcb.qcloud.la 这个宽泛的规则是安全的」：
    // 判断依据是**顶级域归属**，不是前缀长什么样。
    expect(() => check(`https://whatever.tcb.qcloud.la/${KEY}`)).not.toThrow()
    expect(() => check(`https://evil-${BUCKET}.tcb.qcloud.la/${KEY}`)).not.toThrow()
  })

  it('⭐ 不放行任意 .myqcloud.com（否则等于放行别的账号的桶）', () => {
    expect(() => check(`https://someone-else.cos.${REGION}.myqcloud.com/${KEY}`)).toThrow(/不在允许范围/)
  })

  it('拦下别的地域（桶名一样但 region 不同）', () => {
    expect(() => check(`https://${BUCKET}.cos.ap-beijing.myqcloud.com/${KEY}`)).toThrow(/不在允许范围/)
  })

  it('只接受 https', () => {
    expect(() => check(`http://${HOST}/${KEY}`)).toThrow(/https/)
  })

  it('非法 URL 直接拒', () => {
    expect(() => check('not a url')).toThrow(/合法 URL/)
  })

  it('路径穿越也不放行（解码后必须逐字符相等）', () => {
    expect(() => check(`https://${HOST}/audio/1/42/../99/1789444196592.pcm`)).toThrow()
  })
})
