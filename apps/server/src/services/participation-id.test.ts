import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * ⚠️ 服务端这边只钉**一件事**：迁移里的回填公式与 shared 的派生函数**逐字符一致**。
 *
 * 派生函数本身（纯函数、与 node:crypto 对拍、真实向量）在 shared 里测
 * （`packages/shared/src/participation-id.test.ts`）—— 那是"只允许一处实现"的规矩。
 * 之所以还要这条：**SQL 与 TS 是两份实现**，不一致时没有任何运行时报错能发现，
 * 只会让老行与新行分成两套地址。
 */
describe('迁移 0057 的回填公式', () => {
  it('LEFT(SHA2(CONCAT(user_id, \':\', article_id), 256), 24) —— 与 shared 的 participationIdOf 同形', () => {
    const sql = readFileSync(new URL('../../drizzle/0057_hard_warhawk.sql', import.meta.url), 'utf8')
    expect(sql).toContain("LEFT(SHA2(CONCAT(`user_id`, ':', `article_id`), 256), 24)")
  })
})
