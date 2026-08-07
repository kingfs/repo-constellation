# GitHub Stars 智能知识库设计

## 1. 背景与目标

本系统将个人 GitHub Stars 建设为可持续更新、可浏览、可检索、可由自主 Agent 深度分析的私人知识库。

核心目标：

- 周期性采集全部 Stars，并根据项目活跃度调整复查频率；
- 仅在数据变化时重新获取内容、调用 LLM 和更新索引；
- 将英文项目资料翻译并提取为稳定的中文结构化数据；
- 支持最近更新、分类浏览、字段过滤、名称模糊搜索和全文搜索；
- 支持 Search Agent 根据自然语言问题多轮查询、扩展关键词、比较候选并给出有依据的答案；
- 搜索响应可以稍慢，但结果必须可解释、可追溯；
- 保留未来增加项目级 embedding/hybrid search 的能力，但第一阶段不依赖 embedding。

非目标：

- 不把 agent-compose 当作业务数据库、任务队列、搜索引擎或 Web 应用服务器；
- 不使用传统 RAG 的 README 切片、逐块 embedding 和 Top-K 拼接流程；
- 不在第一阶段部署本地 embedding 模型；
- 不抓取未 Star 项目构建通用 GitHub 搜索引擎。

## 2. 架构决策

| 领域 | 选择 | 职责 |
|---|---|---|
| 事实与状态 | PostgreSQL | 项目事实、快照、分析、任务、调度状态、查询反馈 |
| 搜索索引 | Meilisearch | 中文全文、模糊匹配、过滤、排序、facets |
| Agent 运行时 | agent-compose | Scheduler、脚本、LLM Agent、事件编排、隔离执行 |
| 应用服务 | 独立 API 服务 | 业务 API、搜索聚合、Agent 工具、鉴权、流式查询 |
| 用户界面 | 独立 Web 前端 | 浏览、筛选、搜索、项目详情、Agent 对话 |
| 原始大文本 | PostgreSQL 起步 | README/Release；规模增长后可迁移对象存储 |

关键原则：

1. PostgreSQL 是唯一事实源。
2. Meilisearch 是可删除、可全量重建的派生索引。
3. Agent 不直接持有业务状态，状态通过受限 API 或数据库适配器读写。
4. 简单确定性查询不调用 Agent；开放式问题才进入 Search Agent。
5. 每个副作用操作必须幂等，事件允许至少一次投递。
6. LLM 分析结果必须绑定输入内容 hash 和分析 schema 版本。

## 3. 总体架构

```text
                         GitHub API
                             │
                             ▼
                 ┌──────────────────────┐
                 │ agent-compose        │
                 │                      │
                 │ Collector Scheduler  │
                 │ Collector Script     │
                 │ Curator Agent        │
                 │ Search Agent         │
                 └───────┬───────┬──────┘
                         │       │
                  write/read     │ search tools
                         │       │
                         ▼       ▼
                 ┌──────────┐  ┌─────────────┐
                 │PostgreSQL│  │ API Service │
                 └────┬─────┘  └──────┬──────┘
                      │               │
                outbox/index          ├──────── PostgreSQL
                      │               ├──────── Meilisearch
                      ▼               └──────── Agent bridge
                ┌───────────┐                │
                │Meilisearch│                ▼
                └───────────┘             Web UI
```

推荐将数据库和搜索写入集中在 API/Worker 服务中。Agent 通过 HTTP/MCP 工具访问服务，避免把数据库超级用户凭据注入所有 sandbox。

## 4. 组件职责

### 4.1 Collector

确定性 Node.js 脚本，不调用 LLM：

- 分页同步 `/user/starred`；
- upsert 仓库基础信息和 `starred_at`；
- 标记已取消 Star 的项目，但默认保留历史记录；
- 查询到期项目的 README、Release 等详情；
- 使用 ETag/Last-Modified 条件请求；
- 规范化内容并计算 `content_hash`；
- 内容变化时写 snapshot，并创建 `analyze_repository` job；
- 计算下一次检查时间；
- 记录 GitHub rate limit 和错误。

Collector 只负责外部事实，不生成中文分类。

### 4.2 Curator Agent

读取一个待分析项目的元数据、README 和 Release，输出严格 JSON Schema：

- 中文名称与中文摘要；
- 分类、用途、解决的问题；
- 中英文关键词、别名和同义表达；
- 目标用户、技术栈、成熟度；
- 维护状态和分析置信度；
- 重要限制和适用边界。

分析成功后写 `repository_analyses`，并创建 `index_repository` job。相同 `content_hash + analysis_version` 不重复分析。

### 4.3 Indexer

确定性 Worker：

- 将 PostgreSQL 数据投影为 Meilisearch 文档；
- 使用 `repository_id` 幂等覆盖；
- 删除或隐藏已取消 Star 的文档；
- 记录 `indexed_at` 和索引 schema 版本；
- 支持全量重建和别名切换，避免重建期间停服。

### 4.4 Search Agent

只通过受限工具检索：

- 理解意图和筛选条件；
- 生成中英文关键词与同义词；
- 执行最多若干轮搜索；
- 合并、去重、扩大或收窄候选；
- 获取候选详情并比较活跃度、用途和限制；
- 输出推荐、匹配依据、数据更新时间和置信度。

Search Agent 默认只读，不能修改仓库事实或分析结果。

### 4.5 API 服务

- REST/JSON API 和可选 SSE 流式响应；
- PostgreSQL 事务与连接池；
- Meilisearch 查询和结果归一化；
- 为 Agent 暴露窄接口工具；
- Web 用户鉴权、限流、审计；
- Agent run 创建、状态查询和流式事件代理；
- 后台 Indexer/Job Worker。

### 4.6 Web 前端

直接 API 功能：

- 最近更新、最近 Star、长期未更新；
- 分类、语言、活跃度、license、archived 筛选；
- 名称模糊搜索、全文搜索；
- 项目详情、原始资料和中文分析；
- 用户标记：收藏、优先级、备注、隐藏。

Agent 功能：

- 自然语言深度搜索；
- 候选比较；
- 趋势总结；
- 流式显示搜索步骤和最终答案。

## 5. PostgreSQL 数据模型

### 5.1 repositories

```text
id uuid primary key
github_id bigint unique not null
full_name text unique not null
owner text not null
name text not null
html_url text not null
description text
homepage text
default_branch text
primary_language text
topics text[]
license_spdx text
stars_count integer
forks_count integer
open_issues_count integer
github_created_at timestamptz
github_updated_at timestamptz
pushed_at timestamptz
starred_at timestamptz
unstarred_at timestamptz
archived boolean not null
disabled boolean not null
has_wiki boolean not null
priority smallint not null default 0
activity_class text not null
last_checked_at timestamptz
next_check_at timestamptz
current_snapshot_id uuid
created_at timestamptz not null
updated_at timestamptz not null
```

重要索引：`next_check_at`、`pushed_at`、`activity_class`、`starred_at`，以及 active Star 的 partial index。

### 5.2 repository_snapshots

```text
id uuid primary key
repository_id uuid not null
content_hash text not null
metadata jsonb not null
readme_text text
readme_etag text
release_text text
release_etag text
fetched_at timestamptz not null
unique(repository_id, content_hash)
```

保留快照有助于解释“为什么重新分析”和查看项目变化。可配置仅保留最近 N 份正文，历史只保留 hash 和摘要。

### 5.3 repository_analyses

```text
id uuid primary key
repository_id uuid not null
snapshot_id uuid not null
content_hash text not null
analysis_version text not null
model text not null
name_zh text
summary_zh text not null
categories text[] not null
keywords text[] not null
aliases text[] not null
use_cases text[] not null
problems_solved text[] not null
target_users text[] not null
technologies text[] not null
maturity text
maintenance_status text
limitations text[] not null
confidence real
analysis_json jsonb not null
analyzed_at timestamptz not null
unique(repository_id, content_hash, analysis_version)
```

### 5.4 jobs

```text
id uuid primary key
type text not null
repository_id uuid
dedupe_key text unique not null
status text not null
priority integer not null
attempts integer not null
max_attempts integer not null
available_at timestamptz not null
leased_until timestamptz
leased_by text
payload jsonb not null
last_error text
created_at timestamptz not null
completed_at timestamptz
```

状态：`pending`、`running`、`succeeded`、`failed`、`dead`。Worker 使用 `FOR UPDATE SKIP LOCKED` 租约领取任务。

### 5.5 outbox_events

数据库事务内写业务数据和 outbox，异步发布：

```text
github.repository.changed
github.repository.analysis_requested
github.repository.analyzed
github.repository.index_requested
github.repository.indexed
```

这避免数据库已提交但事件丢失。

### 5.6 query_feedback

记录查询、返回项目、点击、收藏和“有用/无用”，用于构建真实评测集，而不是直接用于训练。

## 6. Meilisearch 索引设计

第一阶段一个 `repositories_v1` 索引，一项目一文档：

```json
{
  "id": "uuid",
  "full_name": "dandavison/delta",
  "name": "delta",
  "name_zh": "Delta",
  "description": "...",
  "summary_zh": "在终端中增强 Git diff 可读性",
  "categories": ["Git 工具", "终端工具"],
  "problems_solved": ["改善原生 git diff 的可读性"],
  "use_cases": ["代码审查", "查看提交差异"],
  "keywords": ["git", "diff", "pager", "语法高亮"],
  "aliases": ["diff viewer", "git diff 美化"],
  "technologies": ["Rust"],
  "topics": ["git", "diff"],
  "readme_search_text": "...",
  "stars_count": 27000,
  "pushed_at": 1782864000,
  "starred_at": 1750000000,
  "activity_class": "hot",
  "archived": false,
  "is_starred": true
}
```

建议 searchable attributes 权重顺序：

```text
name, full_name, aliases, problems_solved, use_cases,
keywords, summary_zh, categories, topics, description,
technologies, readme_search_text
```

filterable attributes：

```text
categories, technologies, topics, activity_class,
archived, is_starred, license_spdx, primary_language
```

sortable attributes：

```text
stars_count, pushed_at, starred_at, github_updated_at
```

README 只作为低权重字段。项目级结构化分析负责主要语义展开，避免长 README 中的高频词压过真实用途。

## 7. 自适应采集策略

| 状态 | 条件示例 | 默认复查 |
|---|---|---:|
| hot | 30 天内 push 或用户高优先级 | 每天 |
| active | 一年内 push | 每周 |
| quiet | 1～3 年未 push | 每月 |
| stale | 超过 3 年未 push | 每季度 |
| archived | archived | 每半年或暂停 |

每次增加少量随机抖动，避免所有任务同时触发。失败采用指数退避；403 rate limit 根据 GitHub reset 时间重排。

Stars 全量对账和项目详情刷新分开：

- 全量 Stars 列表每天或每周分页扫描；
- 项目详情仅处理 `next_check_at <= now()`；
- README/Release 使用条件请求；
- `304 Not Modified` 不触发 LLM；
- 分析规则升级时通过 `analysis_version` 批量重分析，无需伪造内容变化。

## 8. Agent 编排

```text
cron: reconcile-stars
  -> Collector 对账 Stars
  -> 创建 refresh_repository jobs

cron: dispatch-refresh
  -> Collector 批量刷新到期项目
  -> 内容变化写 analyze_repository job

event/job: analyze_repository
  -> Curator Agent 严格 JSON 输出
  -> 写 analysis + index_repository job

event/job: index_repository
  -> Indexer 更新 Meilisearch
```

不为每个项目创建一个 cron。固定 Scheduler 只负责唤醒 dispatcher，实际调度由 PostgreSQL `next_check_at` 和 jobs 控制。

agent-compose 的 `scheduler.agent()` 默认调用 scheduler 所属 project agent，不能用 compose agent 名直接切换。跨 Agent 使用 `workflow.*` 事件或数据库 jobs；数据库 jobs 是可靠主通道，事件用于低延迟通知。

## 9. Search Agent 工具协议

推荐 API/MCP 工具：

```text
search_projects(query, filters, sort, limit)
get_projects(ids, fields)
get_project_readme(id, max_chars)
list_recent_updates(since, filters, limit)
list_categories()
compare_projects(ids)
```

工具返回稳定 JSON，并包含：`matched_fields`、高亮片段、索引版本、数据时间。禁止任意 SQL 和无限制 README 读取。

一次搜索限制建议：

- 最多 6 次 `search_projects`；
- 每次最多 20 条；
- 最多深入读取 10 个项目；
- 最大总上下文字符数；
- 最终答案列出匹配依据和数据更新时间；
- 低置信度时展示备选，不伪造确定结论。

## 10. API 草案

```text
GET  /api/projects
GET  /api/projects/:id
GET  /api/projects/:id/history
GET  /api/search?q=...&category=...&sort=...
GET  /api/updates?since=...
POST /api/agent/search
GET  /api/agent/search/:runId/events        # SSE
POST /api/projects/:id/recollect
POST /api/projects/:id/reanalyze
POST /api/projects/:id/feedback
```

`GET /api/search` 是快速确定性搜索；`POST /api/agent/search` 是较慢的自主多轮分析。

## 11. 一致性与可靠性

- GitHub repository ID 是外部稳定标识，rename 时更新 `full_name`；
- snapshot、analysis、job 和 index 写入均使用幂等键；
- PostgreSQL 事务不与 Meilisearch HTTP 调用混在一起；
- Indexer 从 outbox/jobs 最终一致更新索引；
- 定期执行 DB 与索引文档数、版本和 hash 巡检；
- 提供 `rebuild-index` 命令从 PostgreSQL 全量重建；
- Agent 超时、格式错误和 provider 错误进入可重试 job；
- 超过最大次数进入 dead job，由 Web 展示并允许人工重试。

## 12. 安全

- GitHub token 仅授予读取用户 Stars 和所需仓库内容的最小权限；
- token 存 agent-compose secret env，不写日志、数据库或索引；
- Search Agent 只持有只读 API token；
- Collector/Curator 分别使用 capability-scoped token；
- Meilisearch master key 不暴露给浏览器；
- 浏览器只访问 API 服务；
- README 和模型输出在 Web 展示时按不可信内容进行 HTML 清洗；
- Agent 工具限制页数、字段、超时和响应大小，防止 prompt 驱动的资源滥用。

## 13. 可观测性

最少指标：

```text
github_api_requests_total / rate_limit_remaining
repositories_starred_total
repositories_due_total
snapshots_changed_total
analysis_jobs_total{status}
analysis_duration_seconds
index_jobs_total{status}
search_latency_seconds{mode}
agent_search_steps_total
dead_jobs_total
```

日志统一携带：`repository_id`、`job_id`、`agent_run_id`、`content_hash`，但不得包含 token 或完整私有 README。

## 14. 部署拓扑

个人单机推荐 Docker Compose：

```text
postgres
meilisearch
api-worker
web
agent-compose
agent-compose-frontend（可选，用于运行管理）
```

PostgreSQL 和 Meilisearch 使用独立持久卷。Agent sandbox 通过内部网络访问 API 服务；不直接向公网暴露数据库和 Meilisearch。

备份优先级：

1. PostgreSQL 定期备份；
2. 配置、分析 schema 和 prompts 纳入 Git；
3. Meilisearch 无需作为唯一备份，可重建；
4. agent-compose Volume 仅保存临时 artifact，不再作为业务事实源。

## 15. 分阶段实施

### Phase 1：事实库与确定性搜索

- PostgreSQL schema 和迁移；
- Collector 从文件 manifest 迁移到数据库；
- Meilisearch 索引和 Indexer；
- API 的项目列表、详情、最近更新和普通搜索；
- 最小 Web UI；
- 保留现有手动 `task agent:sync` / `task agent:curate` 作为迁移期工具。

验收：全量 Stars 可对账，索引可从 DB 重建，名称/中文用途/过滤搜索可用。

### Phase 2：增量与自适应调度

- ETag、content hash、snapshot；
- jobs/outbox；
- 活跃度分级和 `next_check_at`；
- Curator 仅分析变化内容；
- dead job 与人工重试。

验收：重复运行无重复分析，旧项目检查频率显著降低，失败可恢复。

### Phase 3：自主 Search Agent

- 安全搜索工具；
- 多轮查询策略；
- SSE 流式结果；
- 查询反馈与离线评测集。

验收：对“忘记名字、只记得用途”的真实问题，Top 5 召回和最终答案达到预设标准。

### Phase 4：按证据决定语义增强

先分析失败查询。如果全文搜索、中文结构化和 Agent query expansion 仍无法召回，再增加：

- 远程 embedding API；
- 一项目一个向量，不切 README；
- Meilisearch hybrid search 或 PostgreSQL pgvector；
- embedding version 与可重建流程。

## 16. 评测与成功指标

建立至少 30～50 条来自真实记忆方式的查询，例如：

```text
让 git diff 更好看的终端工具
能把 API 变成 MCP 的项目
最近还在活跃更新的本地向量数据库
我以前收藏过的 Go 工作流引擎
```

记录预期相关项目，持续测量：

- Recall@5 / Recall@10；
- 首个相关结果排名 MRR；
- Search Agent 最终推荐正确率；
- 平均查询轮次、延迟和 token；
- 用户点击/有用反馈；
- 数据新鲜度和重复分析率。

技术选型应由这些真实指标驱动，而不是仅由功能清单决定。

## 17. 待确认事项

- API/Worker 使用 Go、TypeScript 还是其他语言；
- PostgreSQL 是否保存完整历史 README，及保留周期；
- 私有 Star 项目是否进入搜索索引及其展示权限；
- Curator 模型、成本预算和 analysis schema v1；
- Web 是否仅单用户，是否需要外网访问和 OAuth；
- Search Agent 通过 agent-compose API 启动，还是由 API 服务调用专用常驻 Agent bridge。
