import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { PARTICIPATION_ID_LENGTH } from './constants/index'
import { participationIdOf } from './participation-id'

/**
 * ⭐⭐ `participations.id`（参与记录的对外地址）的规矩钉在这里。
 *
 * ⚠️⚠️ 为什么值得单独测：它是**派生值**，算错了没有任何东西会报错 ——
 *    照样能查、能显示，只是老行与新行悄悄分成两套地址（链接指错人）。
 *    而这张表是重算式派生索引，重建会重写所有行 —— 所以地址必须是输入的纯函数。
 */
describe('participationIdOf —— 参与记录的地址', () => {
  it(`${PARTICIPATION_ID_LENGTH} 位十六进制，且是输入的纯函数`, () => {
    const id = participationIdOf(315, '28def7d9ace2cb10')
    expect(id).toMatch(new RegExp(`^[0-9a-f]{${PARTICIPATION_ID_LENGTH}}$`))
    expect(participationIdOf(315, '28def7d9ace2cb10')).toBe(id)
  })

  it('⭐ 与 node:crypto 逐字节一致（shared 里那份是纯实现，见 article-id.ts 的说明）', () => {
    const want = createHash('sha256')
      .update('315:28def7d9ace2cb10')
      .digest('hex')
      .slice(0, PARTICIPATION_ID_LENGTH)
    expect(participationIdOf(315, '28def7d9ace2cb10')).toBe(want)
  })

  it('⭐ 一个真实向量（与开发库里那一行相同，也是迁移 0057 回填的结果）', () => {
    expect(participationIdOf(315, '28def7d9ace2cb10')).toBe('8c361c9e9c73cf07ef4b2235')
  })

  it('⚠️ 必须带分隔符：直接拼接会让 (12, "3x") 与 (123, "x") 撞成同一个地址', () => {
    expect(participationIdOf(12, '3x')).not.toBe(participationIdOf(123, 'x'))
  })
})
