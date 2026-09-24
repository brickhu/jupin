import { describe, expect, it } from 'vitest'
import { contentPathOf } from './content-path'

describe('contentPathOf', () => {
  it('路径由 id 推导，且带 content/ 这一段（相对静态根）', () => {
    expect(contentPathOf('e258e487277a99cd')).toBe('/content/articles/e258e487277a99cd.json')
  })

  it('不碰 id 本身：它同时是文件名与主键（改口径 = 重新编号，不是改这里）', () => {
    expect(contentPathOf('abc')).toBe('/content/articles/abc.json')
  })
})
