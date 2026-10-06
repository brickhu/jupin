import { describe, expect, it } from 'vitest'
import { gateMessage } from './gate-message'

describe('gateMessage —— 提交前提示的正文', () => {
  it('⭐ 两种分开说，各占一行', () => {
    const msg = gateMessage(['simple', 'as'], [{ ref: 'simpler', heard: 'similar' }])
    expect(msg).toBe('没读到 2 个：simple、as\n没读准 1 个：simpler（识别成 similar）')
  })

  it('⭐ 没读准时**必须**写成「识别成 X」——这是陈述机器听到了什么，不是判定用户读错', () => {
    const msg = gateMessage([], [{ ref: 'simpler', heard: 'similar' }])
    expect(msg).toContain('识别成 similar')
    // ⚠️ 绝不能出现"读错"这种把机器的错算到用户头上的措辞
    expect(msg).not.toContain('读错')
  })

  it('只有没读到时，不提没读准那一行', () => {
    expect(gateMessage(['a', 'b'], [])).toBe('没读到 2 个：a、b')
  })

  it('只有没读准时也一样（那种情况不拦提交，但文案本身要成立）', () => {
    expect(gateMessage([], [{ ref: 'cat', heard: 'cats' }])).toBe('没读准 1 个：cat（识别成 cats）')
  })

  it('⚠️ 两个都空 ⇒ 空串（没有可说的就不该弹窗）', () => {
    expect(gateMessage([], [])).toBe('')
  })

  it('太多词时不铺满弹窗 —— 超出只说个数', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const msg = gateMessage(many, [])
    expect(msg).toContain('等 8 个')
    expect(msg).toContain('a、b、c、d、e、f')
    expect(msg).not.toContain('g、')
  })
})
