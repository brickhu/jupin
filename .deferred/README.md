# .deferred —— 推迟到**下一次**部署的迁移

## 0043_misty_mathemanic.sql（`DROP TABLE article_tags`）

**为什么推迟**：删表与"不再引用它的代码"如果落在同一个部署里，会有这么一段窗口 ——
新容器的启动迁移把表删了，而**旧容器还在启动期灌种子**（旧版本的
`services/article-index.ts` 会 `delete/insert article_tags`），那一步会失败，
连带 `seedArticles` 整个 try 块中断。

⇒ 拆成两个版本发：
1. **本次**：只上"加 `articles.tags` 列 + 不再引用那张表"的代码（这一步是纯加法，旧版本照跑）；
2. **下一次**：把 `0043_*.sql` 放回 `apps/server/drizzle/`、把它的条目加回
   `meta/_journal.json`（按 `when` 排序放回 0043 的位置），再部署一次。

**怎么放回去**（别手抄 SQL，也别重新 `drizzle-kit generate` —— 那会造一个新 tag）：
把本目录的 `0043_misty_mathemanic.sql` 移回 `apps/server/drizzle/`，
并在 `_journal.json` 的 entries 里按 idx/when 顺序插回这一条：

```json
{ "idx": 43, "version": "5", "when": <原值>, "tag": "0043_misty_mathemanic", "breakpoints": true }
```
