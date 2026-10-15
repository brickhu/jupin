import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RAW = readFileSync(new URL('./participate-flow.ts', import.meta.url), 'utf-8')

/**
 * ⚠️ **剥掉注释再判** —— 否则守门会被"解释这条规则的注释"自己触发
 *    （本文件的注释里就写着「原来这里写死 status: 'scored'」，第一版就是这么误报的）。
 */
const SRC = RAW.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

/**
 * ⭐⭐ 守的是**「没出分之前不许显示分数」**这条纪律（2026-10-15 真实 bug）。
 *
 * ## 出事的样子（用户原话）
 *
 *   「你能量扣除确认后，直接把历史最高分展示出来了 —— 应该是 loading 状态啊」
 *
 * 两层错叠在一起：
 *   ① `restore()` 把缓存里的 submissionId **写死成 `status: 'scored'`** ⇒
 *      点完能量确认、id 刚落库的那一刻，状态机就判成 `scored`；
 *   ② `displayScoreOf('scored', …)` 在"这一把的分还没到"时**退回战绩** ⇒
 *      于是显示出来的正是**历史最高分**。
 *
 * ⇒ 只要有一层错，"一个不属于这一次的分数"就会被显示得像真的一样。**两处都堵死**。
 *
 * ⚠️ 这是**静态**检查（读源码文本），与 wxss-guard / participation-scope 同一种风格：
 *    它守的是"写法"，而不是跑一遍时序（时序那部分由 lib/record-state.test.ts 守）。
 */
describe('参与流程 —— 没出分之前不许显示分数', () => {
  it('⭐ restore 不许把缓存的 submissionId 写死成 scored', () => {
    // 判据只看"本会话真的拿到结果了吗"（scratch.resultOf）
    expect(
      SRC.includes("status: knownResult === cache.submissionId ? 'scored' : 'scoring'"),
      'restore 没有按 resultOf 判 status ⇒ 提交后一刻会被判成 scored 并显示分数',
    ).toBe(true)

    // 反向：不许再出现写死的 status: 'scored'
    const hardCoded = /status:\s*'scored'/.test(SRC)
    expect(hardCoded, "restore 里又出现了写死的 status: 'scored' ⇒ 回归").toBe(false)
  })

  it('⭐ 提交成功之后必须把 resultOf 清空（这一把的结果是"未知"）', () => {
    const at = SRC.indexOf('const next: ParticipateCache')
    expect(at, '找不到保存缓存那一句').toBeGreaterThan(-1)
    const after = SRC.slice(at, at + 700)
    expect(
      after.includes("this.data.scratch.resultOf = ''"),
      "提交后没有清空 resultOf ⇒ restore 会以为已出分",
    ).toBe(true)
  })

  it('⚠️ 只有"用户刚提交"那一次才自动弹面板（进页面补问不弹）', () => {
    expect(
      SRC.includes('startPoll(true)'),
      '进页面补问没有走 silent ⇒ 每次进页面都会自动弹一次结果面板',
    ).toBe(true)
    expect(
      SRC.includes('!this.data.scratch.silent'),
      '轮询没有按 silent 决定弹不弹',
    ).toBe(true)
  })

  it('点了面板上的「确认」之后，四个标记都要清掉', () => {
    const at = SRC.indexOf('async onPanelConfirm()')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 1400)
    for (const k of ['clearParticipate', "resultOf = ''", "popped = ''"]) {
      expect(body.includes(k), '确认之后没清：' + k).toBe(true)
    }
  })

  /**
   * ⭐⭐ `↺` 的语义（用户 2026-10-15 定）：
   *    「点击后本质是**恢复大 try/retry 状态**，并清除掉录好的声音，
   *      建议清除前可以让用户确认下清除。」
   *
   * ⚠️ 我第一版做成了"点了就开录音面板" —— 那是错的：少一次确认（录音不可撤销），
   *    也少了一个"我不想录了"的落脚点。
   */
  it('⭐ ↺ 必须先确认，再清；且清完**不许自动开录音面板**', () => {
    const at = SRC.indexOf('onRedo()')
    expect(at, '找不到 onRedo').toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('discardRecording()', at))
    expect(body.includes('wx.showModal'), '↺ 没先问一次 ⇒ 手一抖录音就没了（不可撤销）').toBe(true)
    expect(body.indexOf('wx.showModal')).toBeLessThan(body.indexOf('r.confirm'))

    const clr = SRC.slice(SRC.indexOf('discardRecording()'))
    const clrBody = clr.slice(0, clr.indexOf('restore()'))
    expect(clrBody.includes('clearParticipate'), '没清端侧缓存').toBe(true)
    expect(
      clrBody.includes('recorderVisible: true'),
      '清完自动开了录音面板 ⇒ 那就成了"再来一遍"，不是"放弃"（用户定的语义）',
    ).toBe(false)
    expect(clrBody.includes('stopPoll'), '没停轮询 ⇒ 清完缓存后轮询回来又会写成 scored').toBe(true)
  })

  it('⚠️ checking 态不给退（那一段已经在云里算了）', () => {
    const at = SRC.indexOf('onRedo()')
    const body = SRC.slice(at, SRC.indexOf('wx.showModal', at))
    expect(body.includes("=== 'checking'"), 'checking 没有早退 ⇒ 会给出一个退不掉的按钮').toBe(true)
  })

  /**
   * ⭐⭐ 粗筛的**唯一触发点**是 `recoded` 上那颗 `✓`（用户 2026-10-15 报的错）。
   *
   *    用户原话：「结束就是结束，声音太短不符合提交**应该放到 recoded 用户点击确认后提示**」
   *
   * ⚠️⚠️ 我原来在 `onRecorderDone`（录音刚落完）里也调了一次 ⇒
   *    那句「好像没读完，建议重读」**在录音刚停的那一刻就弹出来**，而且盖在
   *    "结束录音"那条路上 —— 看起来像录音本身出了问题（其实录音一切正常，只是短）。
   */
  it('⭐⭐ 粗筛只能由 ✓ 触发，**录完那一刻不许弹**', () => {
    const doneAt = SRC.indexOf('onRecorderDone(')
    expect(doneAt, '找不到 onRecorderDone').toBeGreaterThan(-1)
    const doneBody = SRC.slice(doneAt, SRC.indexOf('onRecorderFail(', doneAt))
    expect(
      doneBody.includes('precheck('),
      '录音刚落完就调了 precheck ⇒ 提示会盖在"结束录音"那条路上（用户报过这个错）',
    ).toBe(false)
    expect(doneBody.includes('showNotice('), '录音刚落完就弹提示 ⇒ 同上').toBe(false)

    // 而 ✓ 那一条必须有
    const okAt = SRC.indexOf('onConfirm()')
    const okBody = SRC.slice(okAt, SRC.indexOf('showNotice(', okAt))
    expect(okBody.includes('precheck('), '✓ 之后没做粗筛 ⇒ 短录音会白花能量').toBe(true)
    // 顺序：粗筛必须在 energy-tips **之前**（不花能量）
    expect(okBody.indexOf('precheck(')).toBeLessThan(okBody.indexOf('openEnergy('))
  })
})
