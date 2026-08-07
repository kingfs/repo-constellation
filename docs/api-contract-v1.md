# Platform Internal API v1

本文冻结 Phase 1 中 Agent、API、Worker 之间的最小契约。字段只允许向后兼容增加；破坏性修改必须升级版本。

## 通用约定

- Base URL：`PLATFORM_API_URL`，默认 `http://api:8080`。
- Agent 写接口使用 `Authorization: Bearer <PLATFORM_AGENT_TOKEN>`。
- JSON 时间使用 RFC 3339 UTC；ID 使用 UUID；GitHub ID 以字符串传输，避免 JavaScript 精度问题。
- 所有写操作接受 `Idempotency-Key`。
- 错误：`{"error":{"code":"...","message":"...","retryable":false}}`。

## 健康检查

```text
GET /healthz
GET /readyz
```

## Collector

### 完整同步运行状态

Collector 每次完整运行必须先创建持久化运行记录，并在退出前写入成功结果或失败原因：

```text
POST /internal/v1/github/stars/sync-runs
POST /internal/v1/github/stars/sync-runs/:id/complete
POST /internal/v1/github/stars/sync-runs/:id/fail
GET  /api/v1/admin/github-sync/status
```

运行来源为 `daily` 或 `manual`。Admin 状态分别返回最新每日运行和最近一次成功每日运行；
最近成功超过 26 小时，或最新每日运行失败时，`healthy=false`。人工运行不能刷新每日健康水位。

### Stars 对账

```text
POST /internal/v1/github/stars/reconcile
```

```json
{
  "observedAt": "2026-07-14T00:00:00Z",
  "repositories": [{
    "githubId": "123",
    "fullName": "owner/repo",
    "owner": "owner",
    "name": "repo",
    "htmlUrl": "https://github.com/owner/repo",
    "description": "...",
    "homepage": "",
    "defaultBranch": "main",
    "primaryLanguage": "Go",
    "topics": ["agent"],
    "licenseSpdx": "Apache-2.0",
    "starsCount": 10,
    "forksCount": 2,
    "openIssuesCount": 1,
    "githubCreatedAt": "...",
    "githubUpdatedAt": "...",
    "pushedAt": "...",
    "starredAt": "...",
    "archived": false,
    "disabled": false,
    "hasWiki": true
  }]
}
```

响应：`{"upserted":100,"unstarred":2}`。只有本次完整分页成功后才调用，服务端据此标记缺失项目为 unstarred。

对账时服务端按 `pushedAt` 计算 `activityClass`。新项目和 `pushedAt` 变化的项目会令
`nextCheckAt=observedAt`，未变化项目保留原调度时间。

### 查询到期项目

```text
GET /internal/v1/repositories/due?asOf=...&limit=100&cursor=123
```

该接口需要 Agent Bearer Token，按 `githubId` 游标分页，只返回仍被 Star 且
`nextCheckAt <= asOf` 的项目：

```json
{
  "items": [{
    "githubId": "123",
    "fullName": "owner/repo",
    "readmeEtag": "\"etag\"",
    "releaseEtag": null,
    "nextCheckAt": "2026-07-14T00:00:00Z"
  }],
  "nextCursor": "123"
}
```

### 条件刷新项目

```text
POST /internal/v1/repositories/:githubId/refresh
```

```json
{
  "metadata": {},
  "readme": {"status":"not_modified"},
  "release": {"status":"modified","text":"v1 notes","etag":"\"etag\""},
  "fetchedAt": "2026-07-14T00:00:00Z"
}
```

资源状态只能是：`modified`（包含新正文）、`not_modified`（服务端复用当前快照正文）或
`missing`（GitHub 返回 404）。服务端基于元数据、README 和 Release 的最终组合内容计算
hash。组合内容不变时不创建 snapshot/analysis job，但仍更新 `lastCheckedAt/nextCheckAt`。
`nextCheckAt` 使用 hot 1 天、active 7 天、quiet 30 天、stale 90 天、archived 180 天，
并加入由 GitHub ID 决定的 0～10% 稳定抖动。

响应：`{"snapshotId":"uuid","changed":false,"analysisJobId":null,"nextCheckAt":"..."}`。

### 写入内容快照

```text
POST /internal/v1/repositories/:githubId/snapshots
```

```json
{
  "contentHash": "sha256:...",
  "metadata": {},
  "readmeText": "...",
  "readmeEtag": "...",
  "releaseText": "...",
  "releaseEtag": "...",
  "fetchedAt": "..."
}
```

响应：`{"snapshotId":"uuid","changed":true,"analysisJobId":"uuid|null"}`。

## Jobs

### 领取任务

```text
POST /internal/v1/jobs/claim
```

```json
{"types":["analyze_repository"],"workerId":"curator-1","limit":1,"leaseSeconds":1800,"minPriority":-1000}
```

`minPriority` 可选，默认 `-1000`。即时分析 Worker 使用 `100`，因此只领取用户点击后提升
优先级的任务；周期 Worker 保持默认值。两类 Worker 仍受单一活动模型租约约束。

返回 `{"jobs":[...]}`。无任务返回空数组，不使用 404。`analyze_repository`
任务的稳定 shape 为：

```json
{
  "id": "uuid",
  "type": "analyze_repository",
  "repositoryId": "uuid",
  "attempts": 1,
  "payload": {
    "snapshotId": "uuid",
    "contentHash": "sha256:...",
    "fullName": "owner/repo",
    "metadata": {},
    "readmeText": "...",
    "releaseText": "..."
  }
}
```

领取请求可选携带 `runId`、`sandboxId`，用于把业务任务精确关联到 agent-compose
运行。完成和失败 body 也可选携带这两个字段；省略时保持 v1 原有行为。

### 完成或失败

```text
POST /internal/v1/jobs/:id/heartbeat
POST /internal/v1/jobs/:id/complete
POST /internal/v1/jobs/:id/fail
```

执行中的 Worker 每 30 秒发送 heartbeat：`{"workerId":"...","leaseSeconds":300}`，可选携带
`runId`、`sandboxId`。服务端仅允许当前租约持有者续租，返回
`{"leasedUntil":"..."}`。超过 2 分钟没有 heartbeat 的运行任务会在下一次 claim 时主动回收，
避免已退出 sandbox 长时间占用全局并发。

完成 body：`{"workerId":"...","result":{}}`，其中 `result` 可选。失败 body：
`{"workerId":"...","error":"...","retryable":true}`。

可重试失败采用指数退避（第 1 次失败等待 1 分钟，之后翻倍，最长 256 分钟）。每次领取增加
`attempts`，达到 `maxAttempts` 后进入 `dead`。租约过期可被其他 Worker 重新领取；已耗尽次数的
过期租约会先被收敛为 `dead`，不会突破最大尝试次数。

### Admin 任务遥测

以下只读接口使用 Admin Bearer Token：

```text
GET /api/v1/admin/jobs/active
GET /api/v1/admin/jobs/summary
GET /api/v1/admin/jobs/recent-failures?limit=30
```

任务汇总可附带 `analysisConcurrency`：`current/min/max/active`、最近 15 分钟
`successCount/failureCount/p95Seconds`、`backlog/reason/lastAdjustedAt`。分析 claim 在 PostgreSQL
事务锁内按剩余配额精确放行，单次领取不会超过 `current-active`。最近 5 分钟成功数和积压均达到
当前配额、失败率低于 5% 且 P95 低于 90 秒时，经 3 分钟冷却逐级扩容；最近 1 分钟出现 provider
pressure，或最近 5 分钟失败率超过 10%、P95 超过 120 秒时逐级缩容。默认初始 2、范围 1～4。

`active` 返回 `{ "items": [...] }`，每项包含 `id,type,status,repositoryId,fullName,priority,
attempts,maxAttempts,workerId,startedAt,lastHeartbeatAt,leasedUntil,runId,sandboxId`。
`summary` 返回按状态聚合的 `counts`、`oldestPendingAt` 和 `checkedAt`。最近失败仅返回
`failed/dead`，`limit` 为 1～100，并包含项目名、错误、可用时间和完成时间。

### 失败恢复与人工运维

以下接口同样需要 Agent Bearer Token。写接口必须提供 `Idempotency-Key`：

```text
GET  /internal/v1/jobs?status=dead&type=analyze_repository&repositoryId=uuid&page=1&pageSize=20
POST /internal/v1/jobs/:id/retry
POST /internal/v1/jobs/reconcile-analysis
POST /internal/v1/projects/:id/recollect
POST /internal/v1/projects/:id/reanalyze
```

任务查询的 `status` 必填，且仅允许 `dead`、`failed`、`running`，避免将内部队列变成无边界的
通用任务浏览接口。人工 retry 仅重排 `failed/dead`，清除终态和租约并重置尝试预算；`pending`
视为已重排，`running/succeeded` 返回冲突。

`recollect` 在事务内将仍在 Star 项目的 `nextCheckAt` 调度到当前时间，由现有 Collector due 流程采集，
响应为 `{"repositoryId":"uuid","scheduled":true,"nextCheckAt":"..."}`；它不会创建无人消费的任务，
也不直接修改 snapshot 或外部事实。
`reanalyze` body 为 `{"analysisVersion":"v2"}`，基于当前不可变 snapshot 创建去重的
`analyze_repository` job；没有当前 snapshot 时返回 `SNAPSHOT_REQUIRED`。
业务去重键由 `repositoryId + contentHash + analysisVersion` 唯一决定，不随请求的
`Idempotency-Key` 改变。

`reconcile-analysis` body 为 `{"limit":500}`（1～1000）。它分批扫描仍在 Star、具有当前
snapshot、但当前 content hash 尚无分析的项目，只创建缺失任务或恢复此前因项目暂时
unstarred 而收敛为 `succeeded/skipped` 的同一去重任务。响应为
`{"created":0,"revived":500,"remaining":4411}`。周期 Curator 在领取任务前调用该接口，
因此服务重启或状态恢复后无需人工逐项触发。

## Curator

```text
POST /internal/v1/repositories/:repositoryId/analyses
```

请求包含 `snapshotId`、`contentHash`、`analysisVersion`、`model` 和 `analysis` JSON。响应：`{"analysisId":"uuid","indexJobId":"uuid"}`。

## Web/Search

```text
GET /api/v1/projects
GET /api/v1/projects/:id
GET /api/v1/search?q=...&category=...&language=...&activity=...&sort=relevance
GET /api/v1/updates?since=...&limit=...
GET /api/v1/categories
POST /api/v1/feedback
```

feedback 包含 `queryId`、`queryText`、`resultRepositoryIds`，以及至少一个 `rating` 或
`action`。用于离线质量评测，不直接改变搜索排序。

## 运行状态与恢复

以下接口需要 Admin Bearer Token：

```text
GET /api/v1/admin/metrics
GET /api/v1/admin/operations/status
GET /api/v1/admin/projects/:id/analysis-status
GET /api/v1/admin/agent-runs?limit=30
GET /api/v1/admin/agent-runs/:id/logs?tail=100
```

项目分析状态包含 `not_requested/queued/running/retry_wait/failed/dead/analyzed`、尝试次数、
可用时间、租约截止和最近错误。点击“立即分析”只提升当前 snapshot job 的优先级，不再创建
会与周期整理竞争的 curate control run。

后者比较 PostgreSQL active Star 与 Meilisearch 文档数并持久化巡检结果。Search Agent
run/event/answer 持久化到 PostgreSQL；API 重启后未完成 run 明确收敛为 failed。

`agent-runs` 通过只读、固定项目的 agent-compose bridge 合并自动 Scheduler 与人工/API
运行，`limit` 最大 100。日志 `tail` 最大 200 行且响应最大 64 KiB，只返回经过脱敏的文本事件；
daemon 不可用时返回明确的 `AGENT_COMPOSE_UNAVAILABLE` 503。Web 不直连 daemon。

分页统一返回：

```json
{"items":[],"page":1,"pageSize":20,"total":0}
```

## Search Agent tools

```text
POST /internal/v1/search/projects
POST /internal/v1/projects/batch-get
GET  /internal/v1/projects/:id/readme?maxChars=20000
POST /internal/v1/projects/compare
```

搜索响应必须包含 `matchedFields`、`highlights`、`dataUpdatedAt`，使 Agent 可以解释结果。

## 可靠事件通道

当前联调以 PostgreSQL `jobs` 为唯一可靠副作用通道：业务事实与后续 job 在同一事务提交，Worker
采用租约和至少一次执行语义。数据库中的 `outbox_events` 仅为后续外部事件集成预留；在发布者、
消费者、重试和监控形成完整闭环前不写入该表，避免出现两套不完整的可靠性模型。
