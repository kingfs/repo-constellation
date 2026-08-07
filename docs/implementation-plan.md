# 实施任务图

## 原则

- 任务按可独立验收的大块能力拆分，不按文件或微小功能拆分。
- 每块任务在独立 branch + git worktree 开发；负责人统一审查、合并、解决契约冲突和清理。
- 子任务不得自行扩展产品范围；发现契约缺口时记录并向负责人升级。
- PostgreSQL 是事实源，Meilisearch 只保存派生文档。

## 工作包

### WP1：基础设施与持久化基线

交付 PostgreSQL、Meilisearch、初始化迁移、健康检查和本地部署说明。独立于业务实现，可通过容器健康和 SQL 约束验收。

### WP2：Platform API 与搜索服务

交付独立 TypeScript API：配置、健康检查、项目列表/详情、Meilisearch 搜索、内部 Agent API、边界校验和单元测试。通过 repository/search adapter 接口隔离基础设施。

### WP3：Agent 智能 ETL 集成

将现有文件型 Collector/Curator 演进为 API 驱动：完整分页对账、内容 hash、快照提交、job claim、结构化分析提交，保留可测试的纯转换函数。

### WP4：独立 Web 前端

在 WP2 稳定后实现项目浏览、最近更新、过滤搜索、详情和 Agent 搜索入口。不得直接访问 PostgreSQL/Meilisearch。

### WP5：端到端可靠性与发布

负责人完成合并后补齐 schema/API/Agent 的集成测试、索引重建、备份说明、可观测性、迁移文档和发布门禁。

## 依赖与顺序

```text
冻结 API v1
   ├── WP1 基础设施 ─────┐
   ├── WP2 API/搜索 ─────┼── WP5 集成与发布
   └── WP3 Agent ETL ────┤
                         └── WP4 Web（依赖 WP2 public API）
```

合并顺序：WP1 → WP2 → WP3 → WP4 → WP5。WP1/WP2/WP3 可并行开发，但按此顺序进入主分支，以降低配置和契约冲突。

## Phase 1 完成定义

- 一条命令启动 PostgreSQL、Meilisearch、API；
- migration 可重复执行且约束覆盖幂等键；
- Collector 能把完整 Stars 对账和 snapshot 写入 PostgreSQL；
- Curator 能领取任务并提交结构化分析；
- Indexer 能将项目投影到 Meilisearch并可全量重建；
- Web 能浏览、过滤和全文搜索；
- Search Agent 有只读工具边界；
- 核心测试和端到端 smoke 全部通过；
- 所有临时 worktree 已清理。

