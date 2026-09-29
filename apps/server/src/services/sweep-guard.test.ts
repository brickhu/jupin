import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ **兜底清扫这件事必须一直挂着** —— 由机器守（2026-09 定）。
 *
 * ⚠️ 它修的缺陷不会在开发时暴露，只会在"用户提交完就退出、容器又被回收"时出现：
 *    那条 submission 永远停在 scoring、2 点能量永远回不来、
 *    "我的挑战"永远显示「还在检测中」。⇒ 如果哪天 sweepStaleSubmissions
 *    被从启动钩子或惰性触发点上摘掉，**没有任何测试会红**，而这正是它存在的意义。
 *
 * 两件事在这里钉死：
 *   ① 必须**真的被调用**（启动时一次 + 读接口时惰性一次）；
 *   ② 退能量**只能有一个入口**（scoring 的 fail()）—— 兜底不许再写第二份，
 *      两份一旦分叉就会变成"判了失败却没退钱"或"退了两次"。
 */

const SRV = new URL('../', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(path.join(SRV, p), 'utf8')

describe('兜底清扫（sweep）的接线', () => {
  it('启动钩子会跑一次（db/index.ts → sweepStaleSubmissions(true)）', () => {
    const src = read('db/index.ts')
    expect(src, 'db/index.ts 里找不到 sweepStaleSubmissions —— 启动兜底被摘了？').toContain(
      'sweepStaleSubmissions(true)',
    )
  })

  it('读 /api/user/* 时会惰性触发一次（index.ts 的中间件）', () => {
    const src = read('index.ts')
    expect(src, 'index.ts 里找不到 sweepStaleSubmissions —— 惰性兜底被摘了？').toContain(
      'sweepStaleSubmissions()',
    )
    // ⚠️ 必须是 await next() 之后（不能拖慢本次响应）
    const i = src.indexOf('sweepStaleSubmissions()')
    expect(src.slice(Math.max(0, i - 600), i)).toContain('await next()')
  })

  it('⚠️ 兜底里不许自己退能量：那件事的唯一入口是 scoring 的 fail()', () => {
    const src = read('services/sweep.ts')
    expect(
      src.includes('releaseChallengeEnergy'),
      'sweep.ts 里出现了 releaseChallengeEnergy —— 退能量必须只由 markScoringFailed → fail() 做，' +
        '两份实现一旦分叉，症状是"判了失败却没退钱"或"退了两次"。',
    ).toBe(false)
    expect(src, 'sweep.ts 必须通过 markScoringFailed 判失败（它内部才会退能量）').toContain(
      'markScoringFailed',
    )
  })

  it('⚠️ 阈值必须**大于**打分接管阈值，否则会把活着的任务判死', () => {
    const sweep = read('services/sweep.ts')
    const scoring = read('services/scoring.ts')
    /**
     * ⚠️ 阈值写成表达式（`3 * 60_000`）而不是一个字面量，所以这里要**求值**：
     *    直接 Number() 会得到 NaN，于是断言会以一个看不懂的方式红（本测试第一版就是这样）。
     *    安全：只对"数字、下划线、空格、乘号"求值，源码是我们自己的。
     */
    const grab = (src: string, re: RegExp) => {
      const m = re.exec(src)
      expect(m, '读不到阈值定义').not.toBeNull()
      const expr = (m as RegExpExecArray)[1].replace(/_/g, '')
      expect(/^[0-9 *]+$/.test(expr), `阈值表达式不可求值：${expr}`).toBe(true)
      return expr.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1)
    }
    // ⚠️ 必须锚在行首的 const：注释里也写着"30 秒"，不锚就会被注释骗到（本测试第一版就是这么错的）
    const sweepMs = grab(sweep, /^const STALE_MS = ([0-9_ *]+)/m)
    const heartbeatMs = grab(scoring, /^const HEARTBEAT_TIMEOUT_MS = ([0-9_ *]+)/m)
    expect(
      sweepMs,
      `兜底阈值 ${sweepMs}ms 必须大于心跳超时 ${heartbeatMs}ms —— 否则会把"还在正常打分但心跳稍慢"的任务判成失败`,
    ).toBeGreaterThan(heartbeatMs)
  })
})
