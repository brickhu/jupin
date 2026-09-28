import { fetchSubmissionAudio } from '../../lib/api/client'
import { playAudioUrl, stopAudio } from '../../lib/audio/play'
import { ensureLocalAudio } from '../../lib/audio/standard'

/**
 * ⭐⭐ 一次挑战的**录音播放钮** —— 取音 / 落盘 / 播 / 停 / 失败说法，全在这里。
 *
 * ⚠️⚠️ 为什么必须有这个组件（而不是各列表各写一段）：
 *    录音的地址是**按需向服务端要**的（`/api/challenge/:sid/audio`，
 *    每条单独授权、会过期）⇒ 不能提前批量取、也不能长期缓存。
 *    这套流程在「我的挑战」和「朗读页的历史行」里各手写过一份，
 *    两份的边界已经开始分叉（一处判了 `audio 为 null`、另一处忘了）——
 *    分叉的症状是"同一个录音，在这个列表里能播、在那个列表里点了没反应"。
 *
 * ⚠️ 组件只负责**这一颗钮**的三态；页面**不再需要**存 playing / loading 两个下标
 *    （那是它内部的事）。同时只可能播一段：全站共用一个播放器（见 lib/audio/play.ts）。
 *
 * 事件：
 *   · `error`（detail.message）—— 取不到 / 播放失败 / 录音不在了。
 *     ⚠️ 组件**不弹 toast**：怎么说是宿主的界面语言（这一页用 toast、别处可能用红条）。
 */
Component({
  properties: {
    /** 哪一次提交（submissions.id）—— 地址按它去要 */
    submissionId: { type: String, value: '' },
    /** 圆钮尺寸：'sm' | 'md' | 'lg'（同 audio-button） */
    size: { type: String, value: 'sm' },
    /** 右侧跟不跟时长（列表里通常不跟：那一行已经有"什么时候"了） */
    showDuration: { type: Boolean, value: false },
    /** 时长（毫秒）—— showDuration 为真时才有意义 */
    durationMs: { type: Number, value: 0 },
    /** 主题卡上要反色，宿主把卡片的前景/底色传下来（同 audio-button 的约定） */
    fill: { type: String, value: '' },
    ink: { type: String, value: '' },
  },

  data: {
    /** 'unplay' | 'loading' | 'playing' */
    state: 'unplay' as 'unplay' | 'loading' | 'playing',
  },

  lifetimes: {
    /**
     * ⚠️ 组件被销毁（页面翻走 / 列表整块换掉）时必须停掉这一段：
     *    不停的话用户已经离开这一屏了，声音还在响 —— 而他找不到"停"的钮。
     */
    detached() {
      this.stop()
    },
  },

  methods: {
    /** 宿主可以调它来停（比如"点这一行进详情了，别把声音带过去"） */
    stop() {
      stopAudio()
      if (this.data.state !== 'unplay') this.setData({ state: 'unplay' })
    },

    async onTap() {
      // 再点一次 = 停（与卡片、结果页的播放钮同一套手感）
      if (this.data.state === 'playing') {
        this.stop()
        return
      }
      // ⚠️ 取音途中再点 = 忽略：还没出声，再发一次只会让两段音频抢同一个播放器
      if (this.data.state === 'loading') return
      const id = this.data.submissionId
      if (!id) return

      // 先切 loading 再等网络：没有即时反馈的话，用户会以为没点上而连点几次
      this.setData({ state: 'loading' })

      try {
        const { audio } = await fetchSubmissionAudio(id)
        // ⚠️ audio 为 null = 那段录音已经不在了（失败的提交会被服务端删掉音频）
        if (!audio) throw new Error('这段录音已经不在了')
        // ⚠️ 先落盘再播：同一个地址反复听时不必每次重下（见 lib/audio/standard.ts）
        const path = await ensureLocalAudio(audio.src, audio.kind)
        if (!path) throw new Error('取不到这段录音')
        /**
         * ⚠️ 等待期间用户可能已经点了别的（或这一行被换掉）—— 那就别再出声。
         * ⚠️ `as string` 不是装饰：TS 会把 `this.data.state` 按上面那次赋值窄化成
         *    `'loading'`，于是这句判断被当成"恒假"而报错。运行时它当然会变
         *    （用户点了第二次 = stop() 把它设回 'unplay'）。
         */
        if ((this.data.state as string) !== 'loading') return
        this.setData({ state: 'playing' })
        await playAudioUrl(path, '录音', () => {
          // ⚠️ 播完清标记：只在"还是我在播"时清，别把新点的那一颗带掉
          if (this.data.state === 'playing') this.setData({ state: 'unplay' })
        })
      } catch (err) {
        const message = (err as Error).message || '播放失败'
        this.setData({ state: 'unplay' })
        this.triggerEvent('error', { message })
      }
    },
  },
})
