import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ **身份要传到该到的地方** —— 由机器守（2026-09 定）。
 *
 * 这一类缺陷很难在测试里跑出来（都要并发/多用户/公开链接才能看见），
 * 但它们在源码里各有**一个必须成立的形状**。三条都是真实发生过的：
 *
 *   ① 分享页把**拥有者**当观众传给 describe ⇒ 任何访客看到的榜上都有一行写着「你」
 *      （那是别人的成绩）。「按谁算名次」与「谁是观众」必须是两个参数。
 *   ② 成长榜挂在公开前缀上，却读 `c.get('userId')` ⇒ 拿到的一直是 undefined
 *      ⇒ 首页三块榜里自己那一行永远不高亮、昵称永远不是「你」。
 *   ③ 榜单里 `nickname`（谁是「你」）与 `isMe`（哪一行加粗）必须同源 ——
 *      一个用焦点用户、一个用观众的话，会出现"名字是别人、那一行却加粗"。
 */

const SRV = new URL('../', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(path.join(SRV, p), 'utf8')

describe('身份的传递', () => {
  it('① 分享页：观众不是本人时，传给 describe 的观众 id 必须是 0', () => {
    const src = read('routes/public.ts')
    expect(src, 'public.ts 必须自己认一次观众（公开路由没有鉴权中间件）').toContain('viewerIsOwner')
    // ⚠️ 关键形状：`? row.userId : 0` —— 非本人时给 0（榜单里永不自命中）
    expect(
      /viewerIsOwner\([^)]*\)\s*\?\s*row\.userId\s*:\s*0/.test(src),
      'public.ts 里没看到"是本人就传拥有者 id、否则传 0"—— 传别的值会把别人的成绩标成「你」',
    ).toBe(true)
    expect(src, 'describe 必须收到第三个参数（观众）').toMatch(/describe\(row\.userId,\s*sid,\s*viewerUserId\)/)
  })

  it('① 榜心与标签是两个参数（否则分享页必然错标「你」）', () => {
    const src = read('services/leaderboard.ts')
    expect(src, 'getLeaderboardAround 必须有 labelUserId 参数').toContain('labelUserId: number = userId')
  })

  it('③ 榜单的「你」与 isMe 必须同源', () => {
    const src = read('services/leaderboard.ts')
    const label = /nickname: row\.userId === (\w+) \? '你'/.exec(src)
    const isMe = /isMe: row\.userId === (\w+)/.exec(src)
    expect(label?.[1], '读不到 nickname 的判据').toBeTruthy()
    expect(isMe?.[1], '读不到 isMe 的判据').toBeTruthy()
    expect(
      label?.[1],
      `nickname 用的是 ${label?.[1]}、isMe 用的是 ${isMe?.[1]} —— 两者必须同一个变量，` +
        '否则会出现"名字显示别人、那一行却被加粗"',
    ).toBe(isMe?.[1])
  })

  it('② 成长榜挂可选身份，且认不出时按 0（不是 undefined）', () => {
    const idx = read('index.ts')
    expect(idx, '成长榜必须挂 optionalAuthMiddleware（认不出按 0，绝不 401）').toMatch(
      /app\.use\('\/api\/leaderboards\/\*',\s*optionalAuthMiddleware\)/,
    )
    const mw = read('middleware/auth.ts')
    expect(mw, 'optionalAuthMiddleware 认不出时必须 set userId = 0').toMatch(
      /optionalAuthMiddleware[\s\S]{0,900}c\.set\('userId', 0\)/,
    )
    // ⚠️ 两条中间件都必须走同一个 resolveUser：认身份的规则只能有一处（安全边界）
    const occurrences = (mw.match(/await resolveUser\(c\)/g) ?? []).length
    expect(occurrences, 'resolveUser 的调用点变多了？认身份的规则必须只有一处').toBe(2)
  })

  it('③ 401 必须带 code（否则客户端"明确认不出我"那条分支是死代码）', () => {
    const mw = read('middleware/auth.ts')
    expect(mw, '401 响应里必须有 code 字段').toMatch(/return c\.json\(\s*\{[\s\S]{0,200}code:/)
    const client = read('../../miniprogram/src/lib/api/client.ts')
    expect(client, 'AuthExpiredError 必须带 code 字段').toMatch(/class AuthExpiredError[\s\S]{0,400}code = 'AUTH_EXPIRED'/)
  })
})
