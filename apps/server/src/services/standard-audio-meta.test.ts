import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { standardAudioOf, standardAudioMs } from './standard-audio-meta'

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
/**
 * ⚠️⚠️ `content/` **不在 git 里**（用户明确要求 ✓ 内容产物不是源码 ✓）
 *    ⇒ **CI 的干净 checkout 里没有 `content/audio/`** ✗ ⇒ 这两组在 CI 里跳过 ✓
 * ⭐ 用 `skipIf` 而**不是**"提前 return"：后者会**显示为通过** ✗ 那是最坏的一种绿 ✓
 *    要在有内容的地方跑：本机 ✓ 或内容流水线 ✓
 */
const AUDIO_DIR = fileURLToPath(new URL('../../../../content/audio', import.meta.url))
const hasAudio = existsSync(AUDIO_DIR)

describe.skipIf(!hasAudio)('标准音时长', () => {
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
 * ⭐ `standardAudioOf` —— 列表接口与**详情接口**共用它。
 *
 * ⚠️ 朗读页顶行的 `▶ 00:23` 就靠它带出来的 durationMs：
 *    之前详情接口只给 `{ full, kind }`（AudioRef），于是那个时长永远空着
 *    （界面上是"少了 00:23"，不报错、也不明显）。两个接口必须同一个形状。
 */
describe.skipIf(!hasAudio)('standardAudioOf —— 可播引用 + 时长（阅读页顶行那个 00:23）', () => {
  it('有标准音时带上 durationMs（形状与列表接口一致）', async () => {
    const dir = fileURLToPath(new URL('../../../../content/audio', import.meta.url))
    const file = readdirSync(dir).find((f) => f.endsWith('.mp3')) as string
    const id = file.replace(/\.mp3$/, '')

    const audio = await standardAudioOf({ id, standardAudio: `content/audio/${id}.mp3` })
    expect(audio, '标准音列有值却拿不到引用 —— 先看 audioRefOf 的判据').not.toBeNull()
    expect(typeof audio?.full).toBe('string')
    expect(['cloud', 'http']).toContain(audio?.kind)
    // ⭐ 这一条就是"阅读页顶行那个 00:23"的契约
    expect(audio?.durationMs, '详情接口拿不到时长 ⇒ 朗读页顶行的 00:23 会永远空着').toBeGreaterThan(1000)
  })

  it('没有标准音时是 null（客户端据此隐藏播放入口，而不是给个点了 404 的按钮）', async () => {
    expect(await standardAudioOf({ id: '99999', standardAudio: null })).toBeNull()
  })
})

describe('⭐ standardAudioOf：优先用库里的时长（0063 之后）', () => {
  /**
   * ⚠️⚠️ 这一组**不需要 content/** —— 它正是在钉"content/ 退出生产运行时"这件事 ✓
   *    （上面那两组要真音频才能测 ✓ 所以 skipIf ✓ 而这一组不能再依赖它 ✗）
   */
  it('⭐ 库里有时长 ⇒ 直接用，不去碰文件', async () => {
    const a = await standardAudioOf({ id: 'deadbeefdeadbeef', standardAudio: 'cloud://x/y.mp3', standardAudioMs: 23_400 })
    expect(a).not.toBeNull()
    expect(a!.durationMs).toBe(23_400)
  })

  it('⚠️ 库里是 0 ⇒ 当成"不知道"，**不要**原样显示成 0 毫秒', async () => {
    // ⚠️ 0 和"不知道"是两件事（迁移把没回填的行留成 NULL ✓ 但防一手 0 ✓）
    const a = await standardAudioOf({ id: 'deadbeefdeadbeef', standardAudio: 'cloud://x/y.mp3', standardAudioMs: 0 })
    // 库里是 0 ⇒ 退回读文件 ⇒ 这个 id 没有音频文件 ⇒ null（而不是 0 ✓）
    expect(a!.durationMs).not.toBe(0)
  })

  it('⚠️ 库里没有这一列（老行）⇒ 退回读文件；文件也没有 ⇒ null', async () => {
    const a = await standardAudioOf({ id: 'deadbeefdeadbeef', standardAudio: 'cloud://x/y.mp3' })
    expect(a!.durationMs).toBeNull()
  })

  it('没有标准音时整体返回 null（客户端据此不渲染播放入口 ✓）', async () => {
    expect(await standardAudioOf({ id: 'x', standardAudio: null, standardAudioMs: 1000 })).toBeNull()
  })
})
