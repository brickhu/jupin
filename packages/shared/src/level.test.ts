import { describe, expect, it } from 'vitest'
import { LEVEL_LABEL, LEVEL_ORDER, normalizeLevel } from './level'

describe('档位（四档：0 初级 / 1 中级 / 2 高级 / 3 专家）—— 词汇轴与发音轴共用', () => {
  it('四档都认得出来，中文标签与顺序对得上', () => {
    for (const d of LEVEL_ORDER) expect(normalizeLevel(d)).toBe(d)
    expect(LEVEL_ORDER).toEqual([0, 1, 2, 3])
    expect(LEVEL_ORDER.map((d) => LEVEL_LABEL[d])).toEqual(['初级', '中级', '高级', '专家'])
  })

  it('数字字符串也认 —— JSON 被人手改过之后很容易变成字符串形式的档位', () => {
    expect(normalizeLevel('0')).toBe(0)
    expect(normalizeLevel('3')).toBe(3)
  })

  it('旧正文里的 easy/medium/hard 走显式映射（老内容还在 CDN 上）', () => {
    expect(normalizeLevel('easy')).toBe(0)
    expect(normalizeLevel('medium')).toBe(1)
    // ⚠️ hard → 2（高级）而不是 3（专家）：专家是新开的档，不替老内容升格
    expect(normalizeLevel('hard')).toBe(2)
  })

  // ⚠️ 刻意钉死：认不出时补一个默认值，会让**没评过级**的句子看起来评过级
  it('认不出的一律 null，绝不补默认档位', () => {
    for (const v of [undefined, null, '', 'EASY', 'easy ', 'Hard', 4, -1, 1.5, '10', '-1', {}, [], 'medium2', '初', true]) {
      expect(normalizeLevel(v)).toBeNull()
    }
  })
})
