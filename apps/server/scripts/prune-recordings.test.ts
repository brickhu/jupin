import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = readFileSync(new URL('./prune-recordings.ts', import.meta.url), 'utf-8')
const LOCAL = readFileSync(new URL('../src/storage/local.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**清孤儿录音时的两条硬约束**（plan B86）。
 *
 * ⚠️⚠️ ① **只碰 `audio/` 前缀** —— 标准音在 `content/audio/` 下，
 *    卷进来的后果是**全站标准音被删**（而且删完才知道）。
 * ② **默认根必须与 `storage/local.ts` 的一致** —— 我这里就写错过一级目录，
 *    表现是"盘上一个文件都没有 ⇒ 显示已清干净"，**看起来像成功了**。
 *
 * ⚠️ 这是**静态**检查（读源码文本）：它守的是"写法"。
 */
describe('清孤儿录音（工具）', () => {
  it('⭐⭐ 只删 `audio/` 前缀下的（标准音在 content/audio/，绝不能卷进来）', () => {
    expect(SCRIPT.includes("const RECORDING_PREFIX = 'audio/'"), '前缀常量变了').toBe(true)
    /** 有一处硬断言：孤儿里出现非该前缀的文件就拒绝执行 */
    expect(
      SCRIPT.includes('o.key.startsWith(RECORDING_PREFIX)'),
      '少了"前缀不对就拒绝执行"的断言 ⇒ 手一抖就删标准音',
    ).toBe(true)
  })

  it('⭐⭐ 默认根与 storage/local.ts 同源（差一级目录会"看起来已清干净"）', () => {
    expect(SCRIPT.includes("join(import.meta.dirname, '../../../.uploads')"), '脚本的默认根变了').toBe(true)
    /** local.ts 那边是 resolve(SERVER_ROOT, '../../.uploads') —— 两者都指向 <仓库根>/.uploads */
    expect(LOCAL.includes("'../../.uploads'"), 'local.ts 的默认根变了 ⇒ 两边要一起改').toBe(true)
  })

  it('⚠️ 云端要**明说清不了**（那三个 /tcb/* 接口没有列举），不许假装清过', () => {
    expect(SCRIPT.includes("storage !== 'local'"), '没拦住非 local 的存储').toBe(true)
    expect(SCRIPT.includes('process.exit(2)'), '拦住了但没退出 ⇒ 后面还会往下走').toBe(true)
  })

  it('⚠️ `--yes` 必须被认（只认 WIPE_APPLY 的话，命令行加 --yes 会被静默忽略）', () => {
    expect(SCRIPT.includes("process.argv.includes('--yes')"), '--yes 没被认 ⇒ 看起来跑过了其实没删').toBe(true)
  })
})
