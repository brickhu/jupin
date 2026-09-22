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
 */

/** 拿不到 onPlay / onError 时的兜底：不能让调用方永远挂着 */
const PLAY_TIMEOUT_MS = 4_000

/** 唯一那个播放器实例 —— 模块级，跨页面复用 */
let audio: WechatMiniprogram.InnerAudioContext | null = null

function context(): WechatMiniprogram.InnerAudioContext {
  if (!audio) {
    audio = wx.createInnerAudioContext()
    audio.volume = 1
  }
  return audio
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
 */
export function playAudioUrl(src: string, what: string, onEnded?: () => void): Promise<void> {
  if (!src) return Promise.reject(new Error('没有音频源'))
  const a = context()

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
    a.onPlay(() =>
      settle(() => {
        resolve()
      }),
    )
    a.onError((err) =>
      settle(() => {
        // ⚠️ 把 errCode 也带上 —— errMsg 有时很含糊，errCode 才分得清
        //    是「文件不存在」「格式不支持」还是「解码失败」
        console.error('[audio] ' + what + ' 播放失败', err)
        reject(new Error(what + '失败（' + err.errCode + '）：' + err.errMsg))
      }),
    )
    a.onEnded(() => onEnded?.())

    a.stop()
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
 * 停下当前播放。
 *
 * ⚠️ 页面 onHide / onUnload 要调：不调的话用户翻到下一页，上一段还在响。
 * ⚠️ 不 destroy 实例：留着下次直接复用（反复 create 正是上面说的那个坑）。
 */
export function stopAudio(): void {
  try {
    audio?.stop()
  } catch {
    /* 没在播时 stop 也可能抛，忽略 */
  }
}