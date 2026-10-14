import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(new URL('./submissions.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是「**能量预扣不能泄漏**」这条纪律（2026-10 实际踩到的 bug）。
 *
 * ## 出事的样子
 *
 * 受理提交的顺序是 ① 锁能量 → ② 落 submissions 那一行。
 * ② 有两条失败路径，而**只有一条**被兜住了：
 *
 *   · `affectedRows === 0`（没报错但没写进去）→ 有 `releaseChallengeEnergy` ✓
 *   · **抛异常**（例如 schema 少一列 ⇒ `ER_BAD_FIELD_ERROR`）→ 直接冒到 Hono 的 onError ⇒ 500，
 *     而那笔 `challenge_hold` **永远留在账本里** ✗
 *
 * ⚠️ 真实症状：一次 schema 没迁移上去的部署里，每次提交都 500，而**每次仍然扣 2 点** ——
 *    用户看到的是"提交失败"，账上却一路在掉。这种"失败还扣钱"最难被发现。
 *
 * ⚠️ 这是**静态**检查（读源码文本），不连库 —— 与 routes/participation-scope.test.ts 同一种风格。
 */
describe('受理提交的能量锁 —— 抛异常也必须退能量', () => {
  it('落库那一段被 try/catch 包住，且 catch 里退了能量', () => {
    // ① 找到"把结果赋给 inserted"的那次插入（这是**落库**这一步，不是幂等查询）
    const insertAt = SRC.indexOf('inserted = await db')
    expect(insertAt, '找不到落库那一句 —— 它是不是被改名/重构了？').toBeGreaterThan(-1)

    // ② 它必须在某个 try 里
    const tryAt = SRC.lastIndexOf('try {', insertAt)
    expect(tryAt, '落库没有被 try 包住 ⇒ 抛异常时能量预扣会泄漏').toBeGreaterThan(-1)

    // ③ 而且这个 try 有一个带 err 的 catch，里面退了能量
    const catchAt = SRC.indexOf('} catch (err) {', insertAt)
    expect(catchAt, 'try 后面没有 catch (err) ⇒ 异常没有被兜住').toBeGreaterThan(-1)
    expect(catchAt - insertAt, 'catch 离落库太远，可能不是同一个 try').toBeLessThan(6000)

    const catchBody = SRC.slice(catchAt, SRC.indexOf('\n    }', catchAt))
    expect(
      catchBody.includes('releaseChallengeEnergy'),
      'catch 里没有 releaseChallengeEnergy ⇒ 提交失败却照样扣能量',
    ).toBe(true)
  })

  it('两条失败路径（affectedRows=0 / 抛异常）都退能量 —— 谁都不许漏', () => {
    // ⚠️ 全文里 release 的次数：`affectedRows === 0` 那条 + catch 那条 = 至少 2
    const n = (SRC.match(/releaseChallengeEnergy\(/g) ?? []).length
    expect(n, '退能量的出口少于 2 个 ⇒ 有一条失败路径会把能量吞掉').toBeGreaterThanOrEqual(2)
  })
})
