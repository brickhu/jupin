/**
 * ⭐ **正文路径的唯一定义**：文章 id 直接决定文件名。
 *
 * ⚠️⚠️ 为什么必须只有一处：这个式子同时被三个角色使用 ——
 *    写内容的生产者（流水线 / 后台）、读内容的服务端、以及运维脚本。
 *    以前它是「每个调用方自己拼」，共 5 份；而且库里的 articles 表还存过一列
 *    content_json（已删，迁移 0030）—— 那是同一件事的第二个真相。
 *
 * ⚠️ 返回值是「相对静态根的 URL 路径」（含 content/ 这一段）：
 *    与将来 CDN 上的形状一致，换 CDN 只改**根**（STATIC_ROOT），不改每条记录的路径。
 */
export function contentPathOf(articleId: string): string {
  return '/content/articles/' + articleId + '.json'
}
