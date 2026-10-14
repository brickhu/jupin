import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCORING = readFileSync(new URL('./scoring.ts', import.meta.url), 'utf-8')
const XFYUN = readFileSync(new URL('../engines/xfyun.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是「**成功调用即计费**」这条分界（用户 2026-10-15 定）。
 *
 * ## 规矩
 *
 * | 引擎那边发生了什么 | kind | 能量 |
 * |---|---|---|
 * | **答了**，但判这段音频无效（`is_rejected`） | `invalid` | **扣**（我们真的调了、也真的付了钱） |
 * | **没触达到**（音频读不出来 / 网络 / 解析异常） | `infra` | **退回**（这一把等于没发生） |
 *
 * ## ⚠️ 为什么必须用**类型**而不是匹配 reason 文案
 *
 * 判"扣"还是"退"挂钩在**同一个 catch** 里的两种异常上 ——
 * 按文案匹配的话，改一个字（比如去掉"请"）规则就**静默失效**，
 * 而且没有任何测试会发现（这条纪律在 `fail()` 的防刷计数上已经写过一次）。
 *
 * ⚠️ 这是**静态**检查（读源码文本），不连库。
 */
describe('能量计费分界 —— 引擎答了扣、没触达退', () => {
  it('讯飞判无效抛的是 EngineRejectedError（不是普通 Error）', () => {
    const at = XFYUN.indexOf('is_rejected')
    expect(at, '找不到 is_rejected 的判据').toBeGreaterThan(-1)
    const near = XFYUN.slice(at, at + 400)
    expect(
      near.includes('EngineRejectedError'),
      '判无效抛了普通 Error ⇒ 它与"网络失败"在 catch 里分不开 ⇒ 计费分界失效',
    ).toBe(true)
  })

  it('scoring 用 instanceof 分流，且只退 infra', () => {
    // ① catch 里必须按类型分流
    expect(
      SCORING.includes("err instanceof EngineRejectedError ? 'invalid' : 'infra'"),
      '引擎那个 catch 没有按 EngineRejectedError 分流',
    ).toBe(true)

    // ② 退能量的判据必须是 kind === 'infra'
    const relAt = SCORING.indexOf('releaseChallengeEnergy(failed.userId')
    expect(relAt, '找不到退回能量那一句').toBeGreaterThan(-1)
    const before = SCORING.slice(Math.max(0, relAt - 900), relAt)
    expect(
      before.includes("if (kind === 'infra')"),
      "退回能量的判据不是 kind === 'infra' ⇒ invalid 也会被退（与'调用成功即计费'相反）",
    ).toBe(true)

    // ③ 另一条路上必须把 energyState 记成 charged
    expect(
      SCORING.includes("energyState: 'charged'"),
      'invalid 那一支没有记 energyState=charged ⇒ 事后读不出这一把的能量怎么了',
    ).toBe(true)
  })

  it('受理那一步是**一个事务**（锁能量 + 落行原子）', () => {
    const ROUTE = readFileSync(new URL('../routes/submissions.ts', import.meta.url), 'utf-8')
    const txAt = ROUTE.indexOf('db.transaction(async (tx) => {')
    expect(txAt, '受理没有事务').toBeGreaterThan(-1)
    const body = ROUTE.slice(txAt, txAt + 700)
    expect(body.includes('holdChallengeEnergyIn(tx'), '锁能量没走事务内的版本').toBe(true)
    expect(body.includes('.insert(submissions)'), '落行不在同一个事务里').toBe(true)
  })
})
