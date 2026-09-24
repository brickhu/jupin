/**
 * ④ 标准音 + 词级时间戳（fish-audio）。
 *
 * 这一步产出**两样**东西，别只记得第一样：
 *   ① content/audio/{id}.mp3 —— 整句标准音
 *   ② 正文 JSON 的 words[] —— 每个词的**播放区间**（startMs/endMs）
 * ② 就是客户端「点词定位播放」用的那份数据；它的区间与预切切片同源
 * （见 lib/audio-assets.ts 的 wordRangesOf）。
 *
 * ⚠️ 这一步和 `pnpm admin`（tools/admin，加句子）走的是**同一段代码**
 *    （produceStandardAudio + writeWordTimestamps）—— 不要在这里另写一套。
 *    两边一旦分叉，就会出现「后台加的句子有时间戳、跑流水线补的没有」这种
 *    只有到客户端点词没反应才会发现的漂移。
 *
 * ⚠️ 与 spec 的一处偏差，**是有意的**：spec 写「整篇一份 + 每个竞技场各一份」，
 *    但竞技场切分（②步）还没实现，而当前句库的粒度就是「一句 = 一个朗读单元」
 *    （articles 表注释：文章 = 句子）。所以现在按**句**生产。
 */

import { listArticleIdsOnDisk, produceStandardAudio, readArticleText, writeWordTimestamps } from '../lib/audio-assets'
import type { Step } from './index'

export const step04: Step = {
  id: '04',
  title: '标准音 + 词级时间戳',
  async run(ctx) {
    const ids = await listArticleIdsOnDisk()
    if (ids.length === 0) {
      console.log('  ⚠️ content/articles/ 下没有句子，先跑 ① 选文')
      return
    }

    let done = 0
    let reused = 0
    let failed = 0

    for (const id of ids) {
      const text = await readArticleText(id)
      if (!text) {
        console.log(`  ⚠️ #${id} 没有正文，跳过`)
        failed++
        continue
      }

      try {
        /**
         * ⚠️ 刻意**不在这里**按「音频已存在」跳过：时间戳也要写，它是本步的产物之一。
         *    音频已存在时 produceStandardAudio 会直接复用缓存里的对齐，**不再调引擎**
         *    —— 所以重跑这一步是安全的、也是补时间戳的正确方式。
         */
        const r = await produceStandardAudio(id, text, { force: ctx.force })
        const n = await writeWordTimestamps(id, r.alignment)
        if (r.skipped) reused++
        console.log(
          `  ✓ #${id}  ${r.wordCount} 个切片  ${r.alignment.audioDuration.toFixed(2)}s` +
            `  时间戳 ${n} 条${r.skipped ? '（复用已有音频）' : ''}`,
        )
        done++
      } catch (err) {
        // ⚠️ 单条失败不中断整批 —— 内容流水线是长期的，一次网络抖动
        //    不该让已经跑好的部分白跑
        console.log(`  ✗ #${id} 失败：${err instanceof Error ? err.message : String(err)}`)
        failed++
      }
    }

    console.log(`  小计：处理 ${done}（其中复用已有音频 ${reused}），失败 ${failed}`)
    if (failed > 0) throw new Error(`④ 步有 ${failed} 条没跑成`)
  },
}
