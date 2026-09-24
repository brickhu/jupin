/**
 * ④ 标准音（fish-audio）。
 *
 * 这一步**只产一样东西**：`content/audio/{id}.mp3`（整句标准音）。
 *
 * ⚠️⚠️ 它**曾经还写正文 JSON 的 words[]（逐词播放区间 + 预切切片）**，已删除（2026-09）：
 *    点词播放改走微信 TTS ⇒ 没有逐词音频、也没有时间戳需要落盘。
 *    **词表（words / links）属于内容，由 meta 那一步产出**（lib/word-info.ts，
 *    调用方是 tools/regrade-content.ts 与 tools/admin 的生成任务）——
 *    这一步碰都不碰它，免得同一份数据有两个写入方。
 *
 * ⚠️ 这一步和 `pnpm admin`（tools/admin，加句子）走的是**同一段代码**
 *    （produceStandardAudio）—— 不要在这里另写一套。
 *    两边一旦分叉，就会出现「后台加的句子音频参数不一样」这种
 *    只有到客户端播出来才发现（或根本发现不了）的漂移。
 *
 * ⚠️ 与 spec 的一处偏差，**是有意的**：spec 写「整篇一份 + 每个竞技场各一份」，
 *    但竞技场切分（②步）还没实现，而当前句库的粒度就是「一句 = 一个朗读单元」
 *    （articles 表注释：文章 = 句子）。所以现在按**句**生产。
 */

import { listArticleIdsOnDisk, produceStandardAudio, readArticleText } from '../lib/audio-assets'
import type { Step } from './index'

export const step04: Step = {
  id: '04',
  title: '标准音（整句）',
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
        // ⚠️ 音频已存在时 produceStandardAudio 直接复用缓存里的对齐，**不再调引擎** ——
        //    所以重跑这一步是安全的（也是音频坏掉时的修复手段）。
        const r = await produceStandardAudio(id, text, { force: ctx.force })
        if (r.skipped) reused++
        console.log(
          `  ✓ #${id}  ${r.wordCount} 个词  ${r.alignment.audioDuration.toFixed(2)}s` +
            `${r.skipped ? '（复用已有音频）' : ''}`,
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
