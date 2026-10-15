import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = new URL('./', import.meta.url)
/** 剥注释 —— 否则"解释为什么不用某个名字"的注释会自己触发断言 */
const code = (f: string) =>
  readFileSync(new URL(f, DIR), 'utf-8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')

const COACH = code('coach.ts')

/**
 * ⭐⭐ 守的是**模型名必须是官方清单里还在的那个**。
 *
 * ⚠️⚠️ 为什么值得单独守：模型名写错时，我们的失败是**静默**的 ——
 *    调用被拒 ⇒ 锐评整块不渲染、**不报错**，看起来就像"这次没生成"。
 *    2026-10-15 查官方文档时发现：默认值还写着 `deepseek-chat`（**已不在模型清单里**），
 *    而 `.env.local` 用的是 `deepseek-v4-flash`（官方标注**已退役**，会被 V4.1-Flash 接走）。
 */
describe('LLM 配置', () => {
  it('⭐⭐ 默认模型是 deepseek-flash（官方清单里在的那个）', () => {
    expect(COACH.includes("LLM_MODEL_DEFAULT = 'deepseek-flash'"), '默认模型又不是清单里的名字了').toBe(true)
    expect(COACH.includes("'deepseek-chat'"), '默认值又写回已下线的名字了').toBe(false)
  })

  it('⭐⭐ 配置只有一处来源（调用方不许自己拼 key/baseUrl/model）', () => {
    for (const f of ['scoring.ts', 'summary.ts']) {
      const src = code(f)
      expect(src.includes('llmConfigOf(env)'), f + ' 没走唯一的配置构造函数').toBe(true)
      expect(src.includes("?? 'deepseek-"), f + ' 又自己写了一份默认模型').toBe(false)
      expect(src.includes("'https://api.deepseek.com'"), f + ' 又自己写了一份默认基址').toBe(false)
    }
  })
})
