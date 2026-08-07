# 运行、恢复、观测与评测手册

## 可靠运行

Indexer 的增量写入和全量重建共享 PostgreSQL advisory lock。全量重建写入临时
Meilisearch index，成功后原子交换，失败时删除临时 index，线上 index 保持不变：

```bash
npm --prefix services/api run build
npm --prefix services/api run rebuild-index
task ops:check
```

一致性检查比较 PostgreSQL 中仍被 Star 的仓库数和当前索引文档数，结果写入
`operational_checks`。不一致返回 `consistent=false`，应先检查 dead index job，再执行重建。

## 可恢复

Search Agent 的 run、事件和答案写入 PostgreSQL。API 异常退出后，启动过程将残留的
`running` run 收敛为 `failed`，客户端可以查询已有事件和明确错误，而不会永久等待。

创建备份并在隔离临时数据库中恢复验证：

```bash
task ops:backup -- ./postgres.dump
task ops:restore-drill -- ./postgres.dump
```

恢复演练不会覆盖当前数据库。实际灾难恢复流程为：停止写入、创建目标数据库、
`pg_restore`、运行 migration 校验、启动 API、执行 `rebuild-index` 和一致性检查。

## 可观察

以下 Admin Token 接口不向公开客户端开放：

```text
GET /api/v1/admin/metrics
GET /api/v1/admin/operations/status
```

指标采用 Prometheus text format，包括 HTTP 请求、Search Agent 事件、查询反馈和一致性
检查次数。PostgreSQL 状态快照包含 starred/due repository、各状态 job、Search run 和索引
文档数。生产环境应至少对 `consistent=false`、dead job 增长、due 长期积压和连续恢复失败告警。

## 可评测

Web/API 可通过 `POST /api/v1/feedback` 记录 click/favorite/helpful/unhelpful。离线查询集使用：

```json
[{"query":"让 git diff 更好看的终端工具","expectedFullNames":["dandavison/delta"]}]
```

运行并设置发布阈值：

```bash
API_URL=http://127.0.0.1:8080 \
MIN_RECALL_AT_5=0.8 MIN_RECALL_AT_10=0.9 MIN_MRR=0.6 \
task search:evaluate -- docs/search-evaluation.json
```

输出 `Recall@5`、`Recall@10` 和 MRR，任一指标低于阈值时非零退出。示例文件只验证工具；
正式发布集应维护 30～50 条来自真实记忆方式的查询，评测集变更必须代码审查。
