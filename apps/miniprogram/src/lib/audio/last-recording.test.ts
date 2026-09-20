import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { isUsable as IsUsable } from './last-recording'

/**
 * ⚠️ 这个模块在**顶层**就读了 wx.env.USER_DATA_PATH（固定路径要在模块加载时定下来），
 *    所以必须先打桩再 import —— 否则整个文件在 Node 里一加载就抛。
 *
 * ⚠️ 桩要连**文件系统**一起打：只在纯函数上做测试，就抓不到
 *    「先写后删」这类**顺序**问题 —— 而正是它让上次录音一直被丢掉。
 */
const memory = new Map<string, unknown>()
const files = new Set<string>()
/** 记录调用顺序，用来断言「先清、后写」 */
let calls: string[] = []

vi.stubGlobal('wx', {
  env: { USER_DATA_PATH: '/ud' },
  setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  getStorageSync: (k: string) => memory.get(k) ?? '',
  removeStorageSync: (k: string) => memory.delete(k),
  getFileSystemManager: () => ({
    mkdirSync: (p: string) => {
      calls.push('mkdir')
      files.add(p)
    },
    copyFileSync: (from: string, to: string) => {
      calls.push('copy')
      // ⚠️ 目录不存在就失败 —— 真实实现就是这样的，模拟出来才有意义
      if (!files.has('/ud/jushuo-last')) throw new Error('no such directory')
      files.add(to)
    },
    rmdirSync: (p: string) => {
      calls.push('rmdir')
      for (const f of [...files]) if (f.startsWith(p + '/')) files.delete(f)
    },
    unlinkSync: (p: string) => {
      calls.push('unlink')
      files.delete(p)
    },
    accessSync: (p: string) => {
      if (!files.has(p)) throw new Error('no such file')
    },
  }),
})

let isUsable: typeof IsUsable
let save: typeof import('./last-recording').saveLastRecording
let load: typeof import('./last-recording').loadLastRecording
let clear: typeof import('./last-recording').clearLastRecording

beforeAll(async () => {
  const m = await import('./last-recording')
  isUsable = m.isUsable
  save = m.saveLastRecording
  load = m.loadLastRecording
  clear = m.clearLastRecording
})

beforeEach(() => {
  memory.clear()
  files.clear()
  calls = []
})

const saveOpts = { articleId: 3, tempFilePath: '/tmp/rec.webm', playPath: '/ud/jushuo-replay.wav', durationMs: 8200 }

const meta = {
  articleId: 3,
  durationMs: 8200,
  savedAt: 1_700_000_000_000,
  audioPath: '/tmp/jushuo-test/jushuo-last.webm',
}

describe('isUsable', () => {
  it('同一句 → 可用', () => {
    expect(isUsable(meta, 3)).toBe(true)
  })

  it('没有缓存 → 不可用', () => {
    expect(isUsable(null, 3)).toBe(false)
    expect(isUsable(undefined, 3)).toBe(false)
  })

  it('⚠️ 换一句就不能用 —— 否则会把 A 题的录音当成 B 题已录好', () => {
    expect(isUsable(meta, 4)).toBe(false)
  })

  it('⚠️ articleId 是脏数据时不可用，而不是靠 == 的松散比较蒙混过去', () => {
    expect(isUsable({ ...meta, articleId: Number('x') }, 3)).toBe(false)
  })

  it('时长不合法时不可用 —— 0 毫秒的录音恢复出来只会白等一次提交', () => {
    expect(isUsable({ ...meta, durationMs: 0 }, 3)).toBe(false)
    expect(isUsable({ ...meta, durationMs: NaN }, 3)).toBe(false)
  })

  it('没记路径就不可用 —— 既找不到文件也删不掉它', () => {
    expect(isUsable({ ...meta, audioPath: '' }, 3)).toBe(false)
  })

  it('⭐ 刻意没有保质期：旧的录音仍然可用', () => {
    // 槽位只有一个，点重录会清、提交成功会清，它天然只装「录了但还没交的那一段」。
    // 再叠一条「超过 N 小时作废」只会凭空多出一个用户无法控制的失效条件。
    expect(isUsable({ ...meta, savedAt: 0 }, 3)).toBe(true)
  })
})

describe('保存与恢复', () => {
  it('⭐ 先清目录、后拷贝 —— 顺序反了会把刚写进去的文件一起删掉', () => {
    // 这条是**真实事故**的回归测试：原来 removeDir() 写在 copyFileSync() 之后，
    // 于是每次录完都「写进去 → 立刻被自己删掉」，缓存永远读不回来。
    // 单看任何一行代码都没毛病，只有钉住调用顺序才拦得住。
    save(saveOpts)
    expect(calls.indexOf('rmdir')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('copy')).toBeGreaterThan(calls.indexOf('rmdir'))
  })

  it('保存之后立刻能读回来（这是「缓存有没有真的生效」的最小判据）', () => {
    save(saveOpts)
    const got = load(3)
    expect(got).not.toBeNull()
    expect(got?.durationMs).toBe(8200)
    // ⚠️ 文件必须真的还在 —— 只查元信息会漏掉「元信息指向一个被删掉的文件」
    expect(files.has(got?.audioPath ?? '')).toBe(true)
  })

  it('⚠️ 文件名沿用原件 —— 扩展名丢了播放器会按错的解码器去解', () => {
    save(saveOpts)
    expect(load(3)?.audioPath.endsWith('cached-rec.webm')).toBe(true)
  })

  it('换一句之后读不回来（而且顺手清掉）', () => {
    save(saveOpts)
    expect(load(4)).toBeNull()
    expect(load(3)).toBeNull()
  })

  it('重录（clear）之后读不回来，文件也真的被删了', () => {
    save(saveOpts)
    const p = load(3)?.audioPath ?? ''
    clear()
    expect(load(3)).toBeNull()
    expect(files.has(p)).toBe(false)
  })

  it('⚠️ 临时文件名里的非法字符要被净化，否则目标文件根本写不出来', () => {
    save({ ...saveOpts, tempFilePath: 'http://tmp/a:b*c?.webm' })
    const p = load(3)?.audioPath ?? ''
    expect(p).not.toBe('')
    expect(/^\/ud\/jushuo-last\/cached-[A-Za-z0-9._-]+$/.test(p)).toBe(true)
  })

  it('⭐ copyFileSync 失败时退回「读+写」—— 开发者工具的路径可能是 http 形态', () => {
    // 把 copy 打坏，模拟「只认本地路径」的真实行为
    const realFsm = wx.getFileSystemManager
    const broken = {
      ...realFsm(),
      copyFileSync: () => {
        throw new Error('copyFileSync:fail not a local path')
      },
      readFileSync: () => new ArrayBuffer(8),
      writeFileSync: (p: string) => {
        calls.push('write')
        files.add(p)
      },
    }
    vi.stubGlobal('wx', { ...(wx as object), getFileSystemManager: () => broken })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    save(saveOpts)
    expect(calls).toContain('write')
    expect(load(3)).not.toBeNull()

    warn.mockRestore()
    vi.stubGlobal('wx', { ...(wx as object), getFileSystemManager: realFsm })
  })

  it('连续录两次：第二次覆盖第一次，不会两份并存', () => {
    save(saveOpts)
    save({ ...saveOpts, tempFilePath: '/tmp/again.webm', durationMs: 9000 })
    const got = load(3)
    expect(got?.durationMs).toBe(9000)
    expect([...files].filter((f) => f.startsWith('/ud/jushuo-last/')).length).toBe(1)
  })
})
