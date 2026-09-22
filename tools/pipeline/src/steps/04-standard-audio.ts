/**
 * ④ 标准音 + 词级时间戳（fish-audio）。
 *
 * spec 第九节：整篇一份标准音 + 词级时间戳，并按时间戳预切单词音频。
 *
 * ⚠️ 这一步和 `tools/jushuo-admin.ts add-sentence` 走的是**同一段代码**
 *    （lib/audio-assets.ts 的 produceStandardAudio）—— 不要在这里另写一套。
 *    两边一旦分叉，就会出现「CLI 加的句子有切片、跑流水线补的没有」这种
 *    只有到客户端点词没声才会发现的漂移。
 *
 * ⚠️ 与 spec 的一处偏差，**是有意的**：spec 写「整篇一份 + 每个竞技场各一份」，
 *    但竞技场切分（②步）还没实现，而当前句库的粒度就是「一句 = 一个朗读单元」
 *    （articles 表注释：文章 = 句子）。所以现在按**句**生产。
 *    ②步落地后，这里要改成对每个句群各合成一份 —— 届时 produceStandardAudio
 *    需要接受一个「子 id」来避免文件名冲突。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { ROOT } from '../../../env.mjs'
import { listArticleIdsOnDisk, produceStandardAudio, readArticleText } from '../lib/audio-assets'
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
    let skipped = 0
    let failed = 0

    for (const id of ids) {
      const text = await readArticleText(id)
      if (!text) {
        console.log(`  ⚠️ #${id} 没有正文，跳过`)
        failed++
        continue
      }

      const audioPath = resolve(ROOT, 'content/audio', `${id}.mp3`)
      if (!ctx.force && existsSync(audioPath)) {
        // 幂等：切片先留着，这里不重复烧额度
        skipped++
        continue
      }

      try {
        const r = await produceStandardAudio(id, text, { force: ctx.force })
        console.log(
          `  ✓ #${id}  ${r.wordCount} 个切片  ${r.alignment.audioDuration.toFixed(2)}s` +
            `${r.skipped ? '（跳过）' : ''}`,
        )
        done++
      } catch (err) {
        // ⚠️ 单条失败不中断整批 —— 内容流水线是长期的，一次网络抖动
        //    不该让已经跑好的部分白跑
        console.log(`  ✗ #${id} 失败：${err instanceof Error ? err.message : String(err)}`)
        failed++
      }
    }

    console.log(`  小计：新生成 ${done}，跳过 ${skipped}，失败 ${failed}`)
    if (failed > 0) throw new Error(`④ 步有 ${failed} 条没跑成`)
  },
}
