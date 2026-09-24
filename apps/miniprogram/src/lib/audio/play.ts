/**
 * ⭐ 全站**共用一个**音频播放器。
 *
 * ⚠️⚠️ 为什么必须共用而不是各处 new 一个：
 *    小程序对同时存在的 InnerAudioContext 数量有限制，
 *    反复建而不 destroy，点到第七八个就会**静默不播**。
 *    共用一个、播前先 stop，天然只有一个。
 *
 * ⚠️ 这段逻辑原本写在朗读页里（playUrl）。搬到 lib 是因为
 *    「我的挑战」列表也要播自己以前的录音 —— 抄一份出去的话，
 *    两处迟早各自演化：一处的「canplay 再播」被改掉，
 *    症状就是那条路径在某些机型上「点了没反应、也不报错」。
 *
 * ⚠️⚠️ 既然是共用一个实例，**任何一次播放之前都要把上一次留下的东西清掉**。
 *    目前有两样：
 *      · 回调 —— offXxx 重挂，否则上一次的失败提示会再弹一次
 *      · 「到点停」的定时器（见 startSegment）—— 不清的话，
 *        上一次点词设的定时器会在下一次播放中途把声音**直接掐断**
 *    第二样更阴：症状出现在**另一次播放**上，而原因在上一次。
 */

/** 拿不到 onPlay / onError 时的兜底：不能让调用方永远挂着 */
const PLAY_TIMEOUT_MS = 4_000

/** 唯一那个播放器实例 —— 模块级，跨页面复用 */
let audio: WechatMiniprogram.InnerAudioContext | null = null

/**
 * ⭐ 「播到第 N 毫秒就停」的定时器 —— **模块级**，理由见文件头。
 * ⚠️ 每次播放开始前都必须清掉它。
 */
let stopTimer: ReturnType<typeof setTimeout> | null = null

function clearStopTimer(): void {
  if (stopTimer !== null) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
}

function context(): WechatMiniprogram.InnerAudioContext {
  if (!audio) {
    audio = wx.createInnerAudioContext()
    audio.volume = 1
  }
  return audio
}

/** 只播音频里的一段（毫秒）—— 不传就是从整条的开头播到尾 */
export interface PlaySegment {
  startMs: number
  endMs: number
}

/**
 * 播一个音频地址。
 *
 * ⚠️ 成功以 **onPlay** 为准，不是「设了 src」—— 设 src 只是告诉播放器「有这么个东西」。
 *    调用方（试听的备用音源逻辑）完全依赖「到底播出来了没有」这个事实。
 * ⚠️ 不上来就 play()：某些机型上 src 还没就绪，play() 会被静默忽略，
 *    表现是「点了没反应、也不报错」。等 canplay 再播（另有一条 300ms 的兜底）。
 *
 * @param what  出错时写进提示里的名字（「试听」「标准音」「单词发音」）
 * @param onEnded 播完的回调 —— 页面用它把「正在播」的标记清掉
 * @param segment 只播其中一段（点词听发音用）—— ⚠️ 区间播到点会自己调 onEnded
 */
export function playAudioUrl(
  src: string,
  what: string,
  onEnded?: () => void,
  segment?: PlaySegment,
): Promise<void> {
  if (!src) return Promise.reject(new Error('没有音频源'))
  const a = context()
  // ⚠️ 先清上一次的「到点停」（见文件头：不清会掐断**这次**播放）
  clearStopTimer()

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    // ⚠️ 每次播放都重挂：这些回调捕获的是**这一次**的状态，
    //    不换掉的话上一次的闭包还会继续跑（表现为「上一次的失败提示又弹出来」）
    a.offCanplay?.()
    a.offPlay?.()
    a.offError?.()
    a.offEnded?.()

    a.onCanplay(() => {
      try {
        a.play()
      } catch {
        // 交给下面的超时兜底
      }
    })
    a.onPlay(() => {
      // ⭐ 真的出声了 —— 区间播放从这里开始计时
      if (segment) startSegment(a, segment, onEnded)
      settle(() => {
        resolve()
      })
    })
    a.onError((err) => {
      clearStopTimer()
      settle(() => {
        // ⚠️ 把 errCode 也带上 —— errMsg 有时很含糊，errCode 才分得清
        //    是「文件不存在」「格式不支持」还是「解码失败」
        console.error('[audio] ' + what + ' 播放失败', err)
        reject(new Error(what + '失败（' + err.errCode + '）：' + err.errMsg))
      })
    })
    a.onEnded(() => {
      clearStopTimer()
      onEnded?.()
    })

    a.stop()
    /**
     * ⚠️ 区间播放的起点用 **startTime**，不是「先播再 seek」：
     *    先播的话会**先响一下句子开头**再跳过去 ——
     *    点中间那个词时能听到一段明显的前缀（"She sells…" 里点 "shells" 会先听到 She）。
     * ⚠️ 不播时也要复位成 0，否则会沿用上一次的起点。
     */
    a.startTime = segment ? segment.startMs / 1000 : 0
    a.src = src
    // ⚠️ 兜底：部分机型不触发 canplay
    setTimeout(() => {
      try {
        a.play()
      } catch {
        /* ignore */
      }
    }, 300)
    // ⚠️ 兜底：万一 onPlay / onError 都不来，别让调用方永远挂着
    setTimeout(() => settle(resolve), PLAY_TIMEOUT_MS)
  })
}

/**
 * ⭐ 区间播放：确认真的从 startMs 起来了，并定好到 endMs 就停。
 *
 * ⚠️ startTime 万一被某个机型忽略，这里会**再补一次 seek** ——
 *    不补的话听到的是**句子开头**而不是那个词。那是「错的」，比「不准」更糟。
 * ⚠️ 到点用 stop() 而不是 pause()：stop 会把位置复位。
 *    ⚠️⚠️ 但 stop() **不会触发 onEnded**，所以这里必须自己把 onEnded 调一次 ——
 *       否则界面上「正在播这个词」的高亮永远清不掉。
 */
function startSegment(
  a: WechatMiniprogram.InnerAudioContext,
  seg: PlaySegment,
  onEnded?: () => void,
): void {
  const fromSec = seg.startMs / 1000
  // ⚠️ 至少给 20ms：区间算成 0 的话 setTimeout(fn, 0) 会立刻停，等于没播
  const holdMs = Math.max(20, seg.endMs - seg.startMs)
  try {
    if (Math.abs(a.currentTime - fromSec) > 0.05) a.seek(fromSec)
  } catch {
    /* 不认 seek 就按 startTime 走 */
  }
  clearStopTimer()
  stopTimer = setTimeout(() => {
    stopTimer = null
    try {
      a.stop()
    } catch {
      /* 已经不在播了 */
    }
    onEnded?.()
  }, holdMs)
}

/**
 * 停下当前播放。
 *
 * ⚠️ 页面 onHide / onUnload 要调：不调的话用户翻到下一页，上一段还在响。
 * ⚠️ 不 destroy 实例：留着下次直接复用（反复 create 正是上面说的那个坑）。
 * ⚠️ 顺手清掉「到点停」的定时器 —— 不然它等会儿还会来 stop 一次。
 */
export function stopAudio(): void {
  clearStopTimer()
  try {
    audio?.stop()
  } catch {
    /* 没在播时 stop 也可能抛，忽略 */
  }
}
