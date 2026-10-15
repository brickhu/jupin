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
 * 两层错会**叠在一起**（任一层单独出错就够显错分数了）：
 *   ① `restore()` 把缓存里的 submissionId 当成"已出分" ⇒ 提交后一刻就判成 `scored`；
 *   ② `displayScoreOf('scored', …)` 在"这一把的分还没到"时**退回战绩** ⇒ 显示出来的是历史最高分。
 *
 * ⇒ 判据是：**没拿到这一把的结果之前，`scored` 不成立、也没有分可显示**。
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
   * ⚠️ 点 ↺ 是"**放弃**"，不是"再来一遍"：先确认（清掉不可撤销），
   *    清完回 `try`/`retry` 而**不是**自动开录音面板。
   */
  it('⭐ ↺ 必须先确认，再清；且清完**不许自动开录音面板**', () => {
    const at = SRC.indexOf('onRedo()')
    expect(at, '找不到 onRedo').toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('discardRecording()', at))
    expect(body.includes('wx.showModal'), '↺ 没先问一次 ⇒ 手一抖录音就没了（不可撤销）').toBe(true)
    /** ⚠️ 文案由产品定死（见 prd §7.2）—— 钉住，别在重构时被顺手改掉 */
    expect(body, '弹窗标题/正文/按钮文案与 prd 不一致').toContain('抹除录音')
    expect(body).toContain('你确认抹除掉刚才录制的这一段语音吗？')
    expect(body).toContain("confirmText: '确认'")
    expect(body).toContain("cancelText: '取消'")
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

  it('⚠️ `↺` 只在 recoded 态成立（其余态一律早退）', () => {
    const at = SRC.indexOf('onRedo()')
    const body = SRC.slice(at, SRC.indexOf('wx.showModal', at))
    expect(
      body.includes("!== 'recoded'"),
      '没有"只认 recoded"的早退 ⇒ checking/scored 也能把已提交的那一把丢掉',
    ).toBe(true)
  })

  /**
   * ⭐⭐ 粗筛的**唯一触发点**是 `recoded` 上那颗 `✓`。
   *
   *    "录完"那一刻**不许**弹任何判定 —— 结束就是结束。
   *
   * ⚠️ 在"录音刚落完"那一刻判，提示会盖在"结束录音"那条路上 ⇒
   *    看起来像录音本身出了问题（其实录音正常，只是短）。
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

  /**
   * ⭐⭐ 试听「我自己的录音」（参与区中间那格 `▶ 00:33`）。
   *
   * ⚠️ 两段音频**取哪一份，看这一把走到哪一步**：
   *    · 还没提交（recoded）⇒ 播**本机**那一段（不必去服务端转一圈）
   *    · 已提交（checking / scored）⇒ 播**服务端存档**的那一份（本机那份可能已被清掉）
   * ⚠️ 播之前必须先 `stopAudio()`：它与**标准音**是两路声音，同时响用户分不清在放哪一段。
   */
  it('⭐⭐ playRecording：先停标准音，再按"提交没提交"选那一份', () => {
    const at = SRC.indexOf('async playRecording()')
    expect(at, '找不到 playRecording').toBeGreaterThan(-1)
    const body = SRC.slice(at, SRC.indexOf('// ── ② 录完', at))

    expect(body.includes('stopAudio()'), '播之前没停标准音 ⇒ 两路声音一起响').toBe(true)
    expect(body.indexOf('stopAudio()'), '先播后停等于没停').toBeLessThan(body.indexOf('playAudioUrl'))

    /** 未提交走本机文件 */
    expect(body.includes('cache.audioPath && !cache.submissionId'), '没走"本机那一份"').toBe(true)
    /** 已提交走服务端存档 */
    expect(body.includes('fetchSubmissionAudio'), '没走"服务端存档那一份"').toBe(true)
  })

  it('⭐ 试听是通的：btn-record → 卡片 → 宿主 → 流程（这条链断过）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url))
    // 卡片把 btn-record 的 play 转成 playRecord
    const card = readFileSync(SRC_DIR + 'components/arena-card/arena-card.wxml', 'utf-8')
    expect(card.includes('bind:play="onPlayRecord"'), '卡片没接 btn-record 的 play').toBe(true)
    // 两个宿主都把 playRecord 接到流程上
    for (const host of ['pages/index/index.wxml', 'pages/arena/arena.wxml']) {
      const wxml = readFileSync(SRC_DIR + host, 'utf-8')
      expect(wxml.includes('bind:playRecord="onCardPlay"'), host + ' 没绑 playRecord ⇒ 点了没反应').toBe(true)
    }
  })

  /**
   * ⭐ 点「波形 + 战绩分」（`retry` 态）→ **进竞技档案页**。
   *
   * ⚠️⚠️ 这条链跨四个文件（组件 → 卡片 → 宿主 → 导航），**断一节就点了没反应**，
   *    而编译/测试全绿 —— 试听那条就是这么断过一次的（B77）。
   * ⚠️ 落点必须是 `pages/participation`（**独立**的档案页），
   *    不是个人主页：主页回答"这个人积累了什么"，档案回答"他在这**一句**上表现如何"。
   */
  it('⭐⭐ 战绩那一组能点进竞技档案（四个文件一条链）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const DIR = fileURLToPath(new URL('../../', import.meta.url))

    // ① btn-record：那一组可点，且报出 record
    const btn = readFileSync(DIR + 'components/btn-record/btn-record.wxml', 'utf-8')
    expect(/class="br-score"[^>]*bindtap="onOpenRecord"/.test(btn), 'btn-record 里那组不可点').toBe(true)
    expect(
      readFileSync(DIR + 'components/btn-record/btn-record.ts', 'utf-8').includes("triggerEvent('record')"),
      'btn-record 没报 record 事件',
    ).toBe(true)

    // ② 卡片：接住并转发
    const card = readFileSync(DIR + 'components/arena-card/arena-card.wxml', 'utf-8')
    expect(card.includes('bind:record="onOpenRecord"'), '卡片没接 btn-record 的 record').toBe(true)

    // ③ 两个宿主：绑定 + 落点是档案页
    for (const host of ['pages/index/index.wxml', 'pages/arena/arena.wxml']) {
      const wxml = readFileSync(DIR + host, 'utf-8')
      expect(wxml.includes('bind:record="onCardRecord"'), host + ' 没绑 record ⇒ 点了没反应').toBe(true)
    }
    for (const host of ['pages/index/index.ts', 'pages/arena/arena.ts']) {
      const ts = readFileSync(DIR + host, 'utf-8')
      expect(ts.includes('ROUTES.participationDetail.url'), host + ' 的落点不是竞技档案页').toBe(true)
      expect(ts.includes('goPublic('), host + ' 没走公开页通道（档案页是公开的）').toBe(true)
    }
  })

  /**
   * ⭐⭐ **战绩刷新时的数字滚动**（用户 2026-10-15 定：点更新、弹窗关掉之后，
   *     卡片上那个战绩数字要有数字动画）。
   *
   * ⚠️ 触发条件必须**同时**满足两条，少一条就会出"假喜报"：
   *    ① `awaitRoll` 只由 `onPanelConfirm` 置上（换页 / 普通广播都不该滚）；
   *    ② 新的 bestScore **必须高于**上次那个（记录只增不减；没超越 ⇒ 值不变 ⇒ 不滚）。
   */
  it('⭐⭐ 只有"确认之后、战绩真的涨了"才跳数字', () => {
    expect(SRC.includes('awaitRoll = true'), '没人置 awaitRoll ⇒ 永远不会动').toBe(true)
    expect(SRC.includes('awaitRoll && prev !== null && next > prev'), '触发判据不完整 ⇒ 没破纪录也会动').toBe(true)
    /** ⚠️ 置位必须在 `settled` **之前**：事件同步派发，晚了就错过那一次 */
    const i = SRC.indexOf('awaitRoll = true')
    const j = SRC.indexOf("triggerEvent('settled'", i)
    expect(j, 'awaitRoll 不是设置在 settled 之前那次').toBeGreaterThan(i)
    /** 最后一帧要**精确落在目标值**上（不能停在 84.7）—— 见下面那条更细的守门 */
    expect(SRC.includes('done ? to :'), '最后一帧没落在目标值上').toBe(true)
  })

  it('⭐⭐ 数字动画照搬朗读页那份调过的实现（从 0 滚、末帧精确、1 位小数）', () => {
    /**
     * ⚠️⚠️ 形态与常数都是**别人调过的**，不许自己编：
     *    · **从 0 滚到最终值** —— 不是"从旧战绩过渡到新战绩"（用户 2026-10-15 否掉了后者）；
     *    · `ROLL_MS = 600` / `ROLL_FRAME_MS = 16` —— 600ms 是产品给的区间（500–700），
     *      16ms ≈ 60fps；`pages/reading` 那份实现里写着这两条的理由。
     *    · **末帧无条件写精确值** —— 缓动算出来的近似值会让 89.46 停在 89.4，
     *      而服务端给的是 89.5（"动画结束时差 0.1"）。
     */
    expect(/const ROLL_MS = 600\b/.test(SRC), '时长常数被改了（它是产品调过的）').toBe(true)
    expect(/const ROLL_FRAME_MS = 16\b/.test(SRC), '帧间隔被改了').toBe(true)
    expect(SRC.includes('1 - Math.pow(1 - t, 3)'), 'ease-out cubic 没了').toBe(true)
    expect(SRC.includes('done ? to :'), '末帧没无条件写精确值').toBe(true)
    expect(SRC.includes('to * k'), '不是从 0 滚到最终值').toBe(true)
    expect(SRC.includes('round1('), '每一帧没收成 1 位小数 ⇒ 卡片上会出现 79.43333333').toBe(true)
    /** 反向：不许再出现"从旧值补间"（那是被否掉的那版） */
    expect(/from \+ \(to - from\) \*/.test(SRC), '又写回"从旧值补间"了').toBe(false)
    /** 也不许退化成"随机跳"（我中途编过的那版，同样被否） */
    expect(SRC.includes('Math.random()'), '又变成随机数字了 —— 要的是照搬那份滚动').toBe(false)
  })

  it('⭐⭐ 卡片画的是格式化后的文本（不许直接画原始数字）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const DIR = fileURLToPath(new URL('../../', import.meta.url))
    const wxml = readFileSync(DIR + 'components/btn-record/btn-record.wxml', 'utf-8')
    expect(/\{\{score\}\}/.test(wxml), 'wxml 里又直接画 {{score}} 了 ⇒ 浮点会原样显示').toBe(false)
    expect(wxml.includes('{{scoreText}}'), 'wxml 没走格式化后的文本').toBe(true)
  })

  /**
   * ⭐⭐ **点能量面板的「确认」⇒ 立刻切 `checking`，不许等上传**（用户 2026-10-15 报的）。
   *
   * ⚠️⚠️ 上传是**几秒级**的（音频进对象存储）。原来是在 `submit()` 里等"上传 + 受理"
   *    都回来了才切状态 ⇒ 那几秒卡片**还停在 `recoded`**：不像在处理，
   *    而且 **✓ 还在** ⇒ 用户可以再点一次 = **重复提交同一段音频**。
   *    ⭐ 切成 `checking` 之后那颗 ✓ 不再渲染（设计稿：`checking` = 试听 + 转圈）
   *      ⇒ 重复提交**结构上**就不可能，不需要另加锁。
   */
  it('⭐⭐ 确认能量后立刻切 checking（在调 submit 之前）', () => {
    const i = SRC.indexOf('async onEnergyConfirm()')
    expect(i, '找不到 onEnergyConfirm').toBeGreaterThan(-1)
    /**
     * ⚠️⚠️ **取方法体要按同缩进的结尾 `},` 收**，不能 `slice(i, indexOf('async submit()'))` ——
     *    `submit()` 在文件里排在 `onEnergyConfirm()` **前面**，那个 indexOf 会命中**别处**
     *    （或 -1 ⇒ 一路切到文件尾）⇒ 守门恒过（我第一版就是这样，注入验证时才发现）。
     */
    const body = SRC.slice(i, SRC.indexOf('\n    },', i))
    const setChecking = body.indexOf("state: 'checking'")
    const callSubmit = body.indexOf('await this.submit()')
    expect(setChecking, '没先切 checking').toBeGreaterThan(-1)
    expect(callSubmit).toBeGreaterThan(-1)
    expect(setChecking, '还是等 submit 回来才切 ⇒ 上传那几秒会停在 recoded（✓ 还在）').toBeLessThan(callSubmit)
  })

  it('⭐⭐ 提交失败必须退回（否则永远停在转圈上，而录音还在本地）', () => {
    const i = SRC.indexOf('async submit()')
    const body = SRC.slice(i, SRC.indexOf('\n    },\n', i))
    const at = body.indexOf('} catch (err)')
    expect(at, 'submit 没有 catch？').toBeGreaterThan(-1)
    expect(
      body.slice(at).includes('this.restore()'),
      '失败没退回 ⇒ 状态留在 checking，用户看不到"可以重试"',
    ).toBe(true)
  })
})
