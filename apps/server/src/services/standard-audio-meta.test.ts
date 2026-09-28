import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { scheduleAudioOf, standardAudioMs } from './standard-audio-meta'

/**
 * ⚠️⚠️ 这条用例的唯一目的：**守住那段路径**。
 *
 *    第一版把 readStaticFile 的路径写成了 'audio/{id}.mp3'，
 *    而静态资源的根是仓库根 / /app（content/ 这一段要在路径里）——
 *    结果是**永远读不到文件、时长永远不显示，而且不报错**：
 *    首页上只是「少了那个 0:03」，没有任何东西会提醒你。
 *
 *    所以这里直接从**仓库里真实的标准音**读一次：路径错了它必然是 null。
 */
describe('标准音时长', () => {
  it('能算出仓库里那几条标准音的时长（路径与解析一起守住）', async () => {
    // ⚠️ 标准音文件名现在是**内容 hash**，不能再写死 '1' —— 取仓库里第一个
    const dir = fileURLToPath(new URL('../../../../content/audio', import.meta.url))
    const file = readdirSync(dir).find((f) => f.endsWith('.mp3'))
    expect(file, 'content/audio 下没有标准音').toBeTruthy()
    const ms = await standardAudioMs((file as string).replace(/\.mp3$/, ''))
    expect(ms, '读不到 content/audio/' + file + ' —— 先检查 readStaticFile 的路径基准').not.toBeNull()
    expect(ms as number).toBeGreaterThan(1000)
    expect(ms as number).toBeLessThan(60000)
  })

  it('没有这篇音频时返回 null（而不是 0）', async () => {
    expect(await standardAudioMs('99999')).toBeNull()
  })
})

/**
 * ⭐ `scheduleAudioOf` —— 列表接口与**详情接口**共用它。
 *
 * ⚠️ 朗读页顶行的 `▶ 00:23` 就靠它带出来的 durationMs：
 *    之前详情接口只给 `{ full, kind }`（AudioRef），于是那个时长永远空着
 *    （界面上是"少了 00:23"，不报错、也不明显）。两个接口必须同一个形状。
 */
describe('scheduleAudioOf —— 可播引用 + 时长（阅读页顶行那个 00:23）', () => {
  it('有标准音时带上 durationMs（形状与列表接口一致）', async () => {
    const dir = fileURLToPath(new URL('../../../../content/audio', import.meta.url))
    const file = readdirSync(dir).find((f) => f.endsWith('.mp3')) as string
    const id = file.replace(/\.mp3$/, '')

    const audio = await scheduleAudioOf({ id, standardAudio: `content/audio/${id}.mp3` })
    expect(audio, '标准音列有值却拿不到引用 —— 先看 audioRefOf 的判据').not.toBeNull()
    expect(typeof audio?.full).toBe('string')
    expect(['cloud', 'http']).toContain(audio?.kind)
    // ⭐ 这一条就是"阅读页顶行那个 00:23"的契约
    expect(audio?.durationMs, '详情接口拿不到时长 ⇒ 朗读页顶行的 00:23 会永远空着').toBeGreaterThan(1000)
  })

  it('没有标准音时是 null（客户端据此隐藏播放入口，而不是给个点了 404 的按钮）', async () => {
    expect(await scheduleAudioOf({ id: '99999', standardAudio: null })).toBeNull()
  })
})
