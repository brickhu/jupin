import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⚠️⚠️ **这一组守的是一个反复出现的真机 bug** ✗：
 *    用户点"开始朗读"时，正在试听的音频**没有被停掉**，
 *    于是一边从喇叭出声、一边被麦克风录进这一遍朗读。
 *
 *    根因是 `playAudioUrl` 的**异步窗口** ✓：它设了 `src` 之后要
 *    **等 `onCanplay` 才 `play()`**（某些机型 src 没就绪就 play 会被静默忽略）。
 *    而 `stopAudio()` 只 `stop()`，**不摘那个已挂上的 `onCanplay` 回调** ✗
 *    ⇒ src 一就绪，它照样播出来 ✓
 *
 *    ⭐ 解法是**代次**：`stopAudio()` 把代次 +1，回调里对不上号就不出声 ✓
 */

/** 一个够用的 InnerAudioContext 假件：手动触发 canplay / play */
function fakeCtx() {
  const handlers: Record<string, Array<() => void>> = {}
  const ctx = {
    src: '',
    stop: vi.fn(),
    play: vi.fn(),
    onCanplay: (fn: () => void) => void (handlers.canplay ??= []).push(fn),
    onPlay: (fn: () => void) => void (handlers.play ??= []).push(fn),
    onError: (fn: () => void) => void (handlers.error ??= []).push(fn),
    onEnded: (fn: () => void) => void (handlers.ended ??= []).push(fn),
    offCanplay: () => void (handlers.canplay = []),
    offPlay: () => void (handlers.play = []),
    offError: () => void (handlers.error = []),
    offEnded: () => void (handlers.ended = []),
    seek: vi.fn(),
    /** ⭐ 测试用：模拟"取音完成、可以播了" */
    fireCanplay: () => {
      for (const f of handlers.canplay ?? []) f()
    },
  }
  return ctx
}

let ctx: ReturnType<typeof fakeCtx>

beforeEach(() => {
  vi.resetModules()
  ctx = fakeCtx()
  ;(globalThis as unknown as { wx: unknown }).wx = {
    createInnerAudioContext: () => ctx,
  }
})

describe('playAudioUrl 的代次守卫 —— 停掉之后不许再出声', () => {
  it('⭐ 取音期间被停掉 ⇒ canplay 来了也不播（这就是用户报的那个 bug）', async () => {
    const { playAudioUrl, stopAudio } = await import('./play')
    // ⭐ 点了试听：设了 src，但还没 canplay
    void playAudioUrl('https://x/a.mp3', '试听')
    // ⭐ 用户这时点了"开始朗读" ⇒ stopAudio
    stopAudio()
    // ⭐ 取音完成 —— 旧实现会在这里播出来
    ctx.fireCanplay()
    expect(ctx.play).not.toHaveBeenCalled()
  })

  it('⚠️ 反面对照：没被停掉时，canplay 来了【要】播（别把正常路径堵死）', async () => {
    const { playAudioUrl } = await import('./play')
    void playAudioUrl('https://x/a.mp3', '试听')
    ctx.fireCanplay()
    expect(ctx.play).toHaveBeenCalledTimes(1)
  })

  it('⭐ stopAudio 之后【新】的一次播放不受影响', async () => {
    const { playAudioUrl, stopAudio } = await import('./play')
    stopAudio() // ⭐ 先停一次（代次 +1）
    void playAudioUrl('https://x/b.mp3', '标准音')
    ctx.fireCanplay()
    expect(ctx.play).toHaveBeenCalledTimes(1)
  })

  it('stopAudio 会 stop 掉播放器', async () => {
    const { playAudioUrl, stopAudio } = await import('./play')
    void playAudioUrl('https://x/a.mp3', '试听')
    stopAudio()
    expect(ctx.stop).toHaveBeenCalled()
  })
})

describe('stopCues —— 提示音也得停', () => {
  it('⭐ 所有音效播放器都被 stop（stopAudio 管不到它们）', async () => {
    const { playBeep, stopCues } = await import('./play')
    // ⚠️ 音效是**包内资源**，play.ts 内部自己拼路径，这里只管它建了播放器
    playBeep()
    stopCues()
    expect(ctx.stop).toHaveBeenCalled()
  })
})
