import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RAW = readFileSync(new URL('./recorder.ts', import.meta.url), 'utf-8')
/** 剥掉注释再判 —— 否则会被"解释这条规则的注释"自己触发 */
const TS = RAW.split('\n').filter((l) => {
  const t = l.trim()
  return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
}).join('\n')
const WXML = readFileSync(new URL('./recorder.wxml', import.meta.url), 'utf-8')
const WXSS = readFileSync(new URL('./recorder.wxss', import.meta.url), 'utf-8')

/**
 * 取一个方法体：⚠️ 必须按 **4 空格缩进的方法声明**去找 ——
 * 直接 `indexOf('onDone(')` 会先命中回调对象里的 `onDone: (r) => …`。
 */
function methodBody(name: string): string {
  const at = TS.indexOf('\n    ' + name + '(')
  expect(at, '找不到方法 ' + name + '（它是不是被改名了？）').toBeGreaterThan(-1)
  const end = TS.indexOf('\n    },', at)
  return TS.slice(at, end === -1 ? undefined : end)
}

/**
 * ⭐⭐ 守的是**「麦克风开着的时候不许放任何声音」**这条纪律 —— 两个方向各有一条实测依据：
 *
 * ① **开录前**：先把正在响的（标准音 / 试听 / 提示音两套播放器）**全停掉**，再"嘟"，**最后**才开麦。
 *    反过来的话那段声音会被**原样录进去**（转写全对、用户却没出声）。
 * ② **说"停"之后**：⚠️⚠️ **不能在那一刻放"叮"** ——
 *    说"停"只是发出请求，**麦克风这时还在收**（要等录音器把文件落完才真的关），
 *    那声"叮"会被录进用户这一段的**尾巴**（听着就是"我读完了，结尾还带一声叮"）。
 *    ⇒ "叮"必须放在**录音落地**的回调里（`onDone`）。
 *
 * ⚠️ 这是**静态**检查（读源码文本）：它守的是"写法"。
 */
describe('录音与提示音的顺序（麦克风开着时不放声音）', () => {
  it('⭐⭐ "叮"在**录音落地**的回调里，不在"说停"那一刻', () => {
    expect(methodBody('onDone').includes('playDing()'), 'onDone 里没有"叮" ⇒ 用户按结束没有任何听觉确认').toBe(true)
    expect(
      methodBody('requestStop').includes('playDing()'),
      '"说停"那一刻就放了"叮" ⇒ 麦克风还在收，会被录进用户这段录音的尾巴',
    ).toBe(false)
  })

  it('⭐⭐ 开始录音前：先停所有声音 → 再"嘟" → 最后开麦', () => {
    const body = methodBody('begin')
    const stop = body.indexOf('stopAllAudio()')
    const beep = body.indexOf('playBeep()')
    const start = body.indexOf('session.start()')
    expect(stop, 'begin 里没先停声音').toBeGreaterThan(-1)
    expect(beep, 'begin 里没有"嘟"').toBeGreaterThan(stop)
    expect(start, '开麦没有排在"嘟"之后').toBeGreaterThan(beep)
  })

  it('⭐ 全文件只放两次提示音（开录前的"嘟" + 落地后的"叮"）', () => {
    const plays = [...TS.matchAll(/\bplay(?:Beep|Ding)\w*\(/g)].map((m) => m[0])
    expect(plays.sort()).toEqual(['playBeep(', 'playDing('])
  })

  it('录音面板上不写任何判定性文案（"太短/没读完"那种归 ✓ 之后）', () => {
    for (const bad of ['太短', '没读完']) {
      expect(WXML.includes(bad), '录音面板上出现了"' + bad + '" ⇒ 结束就是结束，判定归 ✓ 之后').toBe(false)
    }
  })

  /**
   * ⭐ 录音面板的**结构与尺寸**（稿 `583:1727`）—— 这里是白底 + 红系，
   *   纵向：句子 → 红点+「录音中，请朗读」→ 胶囊[计时 ｜ 波形 ｜ 停止]。
   */
  it('⭐ 白底面板 + 红色胶囊 + 胶囊贴底（稿的结构）', () => {
    expect(WXSS.includes('background: #ffffff'), '面板不是白底（稿是白的）').toBe(true)
    const pill = /\.rc-pill\s*\{([^}]*)\}/.exec(WXSS)?.[1] ?? ''
    expect(pill, '找不到 .rc-pill').not.toBe('')
    expect(pill.includes('height: 96rpx'), '胶囊不是稿里的 48（96rpx）').toBe(true)
    expect(pill.includes('justify-content: space-between'), '胶囊里三组没贴两边').toBe(true)
    expect(pill.includes('margin-top: auto'), '胶囊没贴到面板底部（稿里句子与它之间是空白）').toBe(true)
    expect(pill.includes('var(--tk-error'), '胶囊描边不是红系（稿里是红的）').toBe(true)
    // 白底 + 红字：句子是 ink（我们的 primary）
    expect(WXSS).toContain('var(--tk-primary')
  })

  it('⭐ 停止钮走 ui-button（不自画），且定稿窗口禁用', () => {
    const at = WXML.indexOf('onStopTap')
    expect(at, '找不到停止钮').toBeGreaterThan(-1)
    const tag = WXML.slice(WXML.lastIndexOf('<ui-button', at), WXML.indexOf('/>', at))
    expect(tag.includes('ui-button'), '停止钮不是 ui-button（自己画 = 把圆角/禁用态/按压反馈再实现一次）').toBe(true)
    expect(tag.includes('disabled="{{finishing}}"'), '定稿窗口里没禁用 ⇒ "看起来能按、按了没反应"').toBe(true)
  })
})
