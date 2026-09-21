import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { isUsable as IsUsable, recordingKeyOf as RecordingKeyOf } from './last-recording'

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

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

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
      if (!files.has(parentOf(to))) throw new Error('no such directory')
      files.add(to)
    },
    rmdirSync: (p: string) => {
      calls.push('rmdir')
      files.delete(p)
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
let recordingKeyOf: typeof RecordingKeyOf
let save: typeof import('./last-recording').saveLastRecording
let load: typeof import('./last-recording').loadLastRecording
let clear: typeof import('./last-recording').clearLastRecording
let clearAll: typeof import('./last-recording').clearAllRecordings

beforeAll(async () => {
  const m = await import('./last-recording')
  isUsable = m.isUsable
  recordingKeyOf = m.recordingKeyOf
  save = m.saveLastRecording
  load = m.loadLastRecording
  clear = m.clearLastRecording
  clearAll = m.clearAllRecordings
})

/** 让 savedAt 递增且确定 —— 淘汰规则是按时间排序的，同一毫秒会平局 */
let now = 1_700_000_000_000
beforeEach(() => {
  memory.clear()
  files.clear()
  calls = []
  now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000))
})

// 存储层的测试用**不透明的键**就够了（它们是字符串，内容无关）；
// 键本身的生成规则由 recordingKeyOf 那一组单独测。
const KEY_A = 'u7-abc12345'
const KEY_B = 'u7-def67890'
const dirOf = (k: string) => '/ud/jupin-recordings/' + k

const optsFor = (key: string) => ({
  key,
  tempFilePath: '/tmp/rec.webm',
  playPath: dirOf(key) + '/replay.wav',
  durationMs: 8200,
})

const meta = {
  key: KEY_A,
  durationMs: 8200,
  savedAt: 1_700_000_000_000,
  audioPath: dirOf(KEY_A) + '/cached-rec.webm',
}

describe('recordingKeyOf —— 键 = hash(句子原文) + uid', () => {
  it('同一句 + 同一用户 → 永远同一个键', () => {
    const s = 'The best way to predict the future is to invent it.'
    expect(recordingKeyOf(s, 7)).toBe(recordingKeyOf(s, 7))
  })

  it('⭐ 换一句就是另一个键 —— 否则会把 A 句的录音当成 B 句已录好', () => {
    expect(recordingKeyOf('Hello world', 7)).not.toBe(recordingKeyOf('Hello there', 7))
  })

  it('⚠️ 只有空白/排版差异 → 仍然是同一个键（同一句不该因为排版丢缓存）', () => {
    const a = 'The best way to predict the future is to invent it.'
    expect(recordingKeyOf('  ' + a + '\n', 7)).toBe(recordingKeyOf(a, 7))
    expect(recordingKeyOf(a.replace(/ /g, '   '), 7)).toBe(recordingKeyOf(a, 7))
  })

  it('⚠️ 换用户就是另一个键 —— 开发者工具里多个测试账号共用同一份本地存储', () => {
    expect(recordingKeyOf('Hello world', 7)).not.toBe(recordingKeyOf('Hello world', 8))
  })

  it('键的形态可读（u<uid>-<8 位十六进制>），排查时一眼能看出是谁的', () => {
    expect(recordingKeyOf('Hello world', 42)).toMatch(/^u42-[0-9a-f]{8}$/)
  })
})

describe('isUsable', () => {
  it('同一个键 → 可用', () => {
    expect(isUsable(meta, KEY_A)).toBe(true)
  })

  it('没有缓存 → 不可用', () => {
    expect(isUsable(null, KEY_A)).toBe(false)
    expect(isUsable(undefined, KEY_A)).toBe(false)
  })

  it('⚠️ 换成另一句的键就不能用 —— 否则会把 A 句的录音当成 B 句已录好', () => {
    expect(isUsable(meta, KEY_B)).toBe(false)
  })

  it('⚠️ 键是脏数据时不可用，而不是靠 == 的松散比较蒙混过去', () => {
    expect(isUsable({ ...meta, key: 3 as unknown as string }, KEY_A)).toBe(false)
  })

  it('时长不合法时不可用 —— 0 毫秒的录音恢复出来只会白等一次提交', () => {
    expect(isUsable({ ...meta, durationMs: 0 }, KEY_A)).toBe(false)
    expect(isUsable({ ...meta, durationMs: NaN }, KEY_A)).toBe(false)
  })

  it('没记路径就不可用 —— 既找不到文件也删不掉它', () => {
    expect(isUsable({ ...meta, audioPath: '' }, KEY_A)).toBe(false)
  })

  it('⭐ 刻意没有保质期：旧的录音仍然可用', () => {
    // 清除只由「重录」和「提交拿到分数」触发。
    // 再叠一条「超过 N 小时作废」只会凭空多出一个用户无法控制的失效条件。
    expect(isUsable({ ...meta, savedAt: 0 }, KEY_A)).toBe(true)
  })
})

describe('保存与恢复', () => {
  it('⭐ 先清目录、后拷贝 —— 顺序反了会把刚写进去的文件一起删掉', () => {
    // 这条是**真实事故**的回归测试：原来 removeDir() 写在 copyFileSync() 之后，
    // 于是每次录完都「写进去 → 立刻被自己删掉」，缓存永远读不回来。
    // 单看任何一行代码都没毛病，只有钉住调用顺序才拦得住。
    save(optsFor(KEY_A))
    expect(calls.indexOf('rmdir')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('copy')).toBeGreaterThan(calls.indexOf('rmdir'))
  })

  it('保存之后立刻能读回来（这是「缓存有没有真的生效」的最小判据）', () => {
    save(optsFor(KEY_A))
    const got = load(KEY_A)
    expect(got).not.toBeNull()
    expect(got?.durationMs).toBe(8200)
    // ⚠️ 文件必须真的还在 —— 只查元信息会漏掉「元信息指向一个被删掉的文件」
    expect(files.has(got?.audioPath ?? '')).toBe(true)
  })

  it('⚠️ 文件名沿用原件 —— 扩展名丢了播放器会按错的解码器去解', () => {
    save(optsFor(KEY_A))
    expect(load(KEY_A)?.audioPath.endsWith('cached-rec.webm')).toBe(true)
  })

  it('⭐ 两句各留各的 —— 按内容寻址之后多留几件才有意义', () => {
    save(optsFor(KEY_A))
    save(optsFor(KEY_B))
    expect(load(KEY_A)?.durationMs).toBe(8200)
    expect(load(KEY_B)?.durationMs).toBe(8200)
    // 两个槽位各自一个目录，互不覆盖
    expect([...files].filter((f) => f.endsWith('.webm')).length).toBe(2)
  })

  it('读一个没存过的键 → null，而且不会误删别人的', () => {
    save(optsFor(KEY_A))
    expect(load(KEY_B)).toBeNull()
    expect(load(KEY_A)).not.toBeNull()
  })

  it('重录（clear）之后读不回来，文件也真的被删了', () => {
    save(optsFor(KEY_A))
    const p = load(KEY_A)?.audioPath ?? ''
    clear(KEY_A)
    expect(load(KEY_A)).toBeNull()
    expect(files.has(p)).toBe(false)
  })

  it('⚠️ clear 只清这一句 —— 别的句子的录音不该被连坐', () => {
    save(optsFor(KEY_A))
    save(optsFor(KEY_B))
    clear(KEY_A)
    expect(load(KEY_A)).toBeNull()
    expect(load(KEY_B)).not.toBeNull()
  })

  it('⚠️ 临时文件名里的非法字符要被净化，否则目标文件根本写不出来', () => {
    save({ ...optsFor(KEY_A), tempFilePath: 'http://tmp/a:b*c?.webm' })
    const p = load(KEY_A)?.audioPath ?? ''
    expect(p).not.toBe('')
    expect(new RegExp('^' + dirOf(KEY_A) + '/cached-[A-Za-z0-9._-]+$').test(p)).toBe(true)
  })

  it('⭐ copyFileSync 失败时退回「读+写」—— 开发者工具的路径可能是 http 形态', () => {
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

    save(optsFor(KEY_A))
    expect(calls).toContain('write')
    expect(load(KEY_A)).not.toBeNull()

    warn.mockRestore()
    vi.stubGlobal('wx', { ...(wx as object), getFileSystemManager: realFsm })
  })

  it('同一句连录两次：第二次覆盖第一次，不会两份并存', () => {
    save(optsFor(KEY_A))
    save({ ...optsFor(KEY_A), tempFilePath: '/tmp/again.webm', durationMs: 9000 })
    expect(load(KEY_A)?.durationMs).toBe(9000)
    expect([...files].filter((f) => f.startsWith(dirOf(KEY_A) + '/')).length).toBe(1)
  })

  it('⚠️ 槽位有上限：超过之后淘汰最旧的那条（连同文件一起删）', () => {
    // 本地文件总量只有 10MB，而真机上一段 20 秒录音（原件 + 试听 WAV）约 1.3MB。
    const keys = ['u7-00000001', 'u7-00000002', 'u7-00000003', 'u7-00000004']
    for (const k of keys) save(optsFor(k))

    const oldest = keys[0] as string
    expect(load(oldest)).toBeNull() // 最旧的被淘汰
    expect(load('u7-00000002')).not.toBeNull()
    expect(load('u7-00000004')).not.toBeNull()
    // 文件也一起走了 —— 只删元信息的话，本地空间照样被占满
    expect([...files].some((f) => f.startsWith(dirOf(oldest) + '/'))).toBe(false)
  })

  it('退出登录/换账号：clearAll 把全部槽位连文件一起清掉', () => {
    save(optsFor(KEY_A))
    save(optsFor(KEY_B))
    clearAll()
    expect(load(KEY_A)).toBeNull()
    expect(load(KEY_B)).toBeNull()
    expect([...files].some((f) => f.startsWith('/ud/jupin-recordings/'))).toBe(false)
  })
})
