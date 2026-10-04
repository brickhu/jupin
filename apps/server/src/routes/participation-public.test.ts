import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * ⭐ 公开接口 `GET /api/participation/{id}` 的**形状**钉在这里。
 *
 * ⚠️⚠️ 它存在的理由：`{id}` 曾经被想成"用户 id + ?articleId="，其实这一行的身份是
 *    `participations.id` —— 一个**派生**地址：`sha256(userId + ':' + articleId)` 的前 24 位
 *    （见 db/schema.ts 与迁移 0057）。
 *    为什么非要派生、不能自增：这张表是**重算式**的（rebuildParticipations 整表重建），
 *    自增 id 一重建就换号 ⇒ 发出去的链接指到别人。哈希出来的值重建前后不变。
 */
const SRC = fs.readFileSync(new URL('./participation.ts', import.meta.url), 'utf8')

describe('公开的参与详情 —— GET /api/participation/{id}（id = participations.id）', () => {
  it('一个地址定位一行：路径参数就是 id，**没有**别的查询参数', () => {
    expect(SRC).toContain("path: '/{id}'")
    expect(SRC).not.toContain('query: z.object')
    // ⚠️ 注释里会提到 articleId（地址是它派生出来的），所以只钉"没有把它当参数收"
    expect(SRC).not.toContain('articleId: z.string()')
  })

  it('⭐ 是公开的：不声明 security（真挂了 authMiddleware 的话，鉴权覆盖那条测试会红）', () => {
    expect(SRC).not.toContain('security:')
  })

  it('⚠️ 地址先按形状挡一道（24 位十六进制）再去查库', () => {
    expect(SRC).toContain('/^[0-9a-f]{24}$/')
  })

  it('⚠️ 取数只走 participationRecordById —— 别在这里另写一条查询', () => {
    // 「从 participations 取数必须能说清作用域」由 participation-scope.test.ts 静态守着；
    // 这里自己写查询就等于把那道守卫绕开了，所以直接钉死写法。
    expect(SRC).toContain('participationRecordById(')
    expect(SRC).not.toContain('.from(participations)')
  })

  it('⚠️ 没有这一行 ⇒ data 为 null（不是 404、也不是一条全 0 的假记录）', () => {
    expect(SRC).toContain('ParticipationRecordResponseSchema')
    // 0 分是合法成绩：绝不能在这里造一条"没有记录但最高 0 分"
    expect(SRC).not.toContain('bestScore: 0')
  })
})
