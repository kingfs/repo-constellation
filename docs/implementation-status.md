# 实施状态与联调矩阵

更新时间：2026-07-17。状态以主分支可执行代码和测试为准；`design.md` 是目标，
`implementation-plan.md` 是任务拆分，二者都不表示功能已经完成。

## 当前阶段

平台已形成可联调主链路：Collector → PostgreSQL → Curator job → analysis → Indexer →
Meilisearch → public API → Web，并具备有资源上限的 Search Agent run/SSE 闭环与任务
人工恢复入口。当前目标是稳定该链路，不扩展向量检索或复杂多 Agent 编排。

| 设计能力 | 状态 | 自动验收 | 剩余工作 |
| --- | --- | --- | --- |
| PostgreSQL schema、迁移幂等/并发锁 | 已实现 | `task platform:smoke` | 生产备份恢复演练 |
| Stars 完整分页对账、取消 Star 保留 | 已实现 | Agent 单测、`task platform:e2e` | GitHub rate-limit reset 调度 |
| README/Release 条件获取、hash、snapshot 去重 | 已实现基础版 | Agent/API 单测、平台 E2E | Last-Modified 与更细退避 |
| 活跃度分级与自适应刷新 | 已实现基础版 | API scheduling 测试 | 运行指标校准 |
| analyze/index job 租约、幂等和 dead 状态 | 已实现 | API/Agent 测试、平台 E2E | 周期自动协调缺失任务；Curator 编排已收敛为一个 Agent 定义，由每分钟 watchdog 和 Stars 同步事件触发同一有界 runner，人工请求轮询在 watchdog 内串行执行以避免 loader 竞争；运行时 slot pool 与平台动态限流按 [Curator 自适应工作流设计](adaptive-curator-workflow-design.md) 实现 |
| 失败任务查询、人工 retry/recollect/reanalyze | 已实现 | API/Agent 契约测试 | 运维 UI、生产权限细分 |
| Curator 严格结构化分析与注入隔离 | 已实现 | Agent 单测、平台 E2E 使用假 LLM | 已使用独立空工作区、固定模型和最低语义质量门禁；待真实模型质量评测 |
| Meilisearch 投影和后台 Indexer | 已实现 | API测试、平台 E2E | 已实现临时索引、跨进程锁与原子切换；待生产规模演练 |
| public 浏览、过滤、搜索、详情 API | 已实现 | API/Web 测试、平台 E2E | 上线鉴权、限流和审计 |
| 最小 Web 浏览与搜索 | 已实现 | Web 测试、平台 E2E | 已展示项目分析任务状态；历史快照和用户标记界面待实现 |
| 有界 Search Agent、run 状态和 SSE | 已实现基础版 | API/Web 测试、平台 E2E | run/event 已持久化并可恢复；待可替换 agent-compose bridge |
| Outbox 可靠事件 | 仅 schema | 无 | 当前以 jobs 为唯一可靠主通道；外部事件集成时再完整实现 |
| 查询反馈与离线评测 | 已实现基础版 | API 契约测试、评测 CLI | 维护 30～50 条真实发布查询集并持续校准阈值 |
| 收藏、备注、优先级、隐藏 | 未实现 | 无 | 完整纵向工作包 |
| Metrics、追踪、一致性巡检 | 已实现基础版 | API 契约测试、人工运维 task | 每日 GitHub Stars 完整同步状态已持久化并按 26 小时计算健康度；待接入外部告警和生产规模校准 |
| 部署配置 | 已实现基础版 | 容器 E2E、恢复演练 task | 执行并留存生产备份、恢复和升级演练记录 |

## 联调验收矩阵

| 门禁 | 覆盖边界 | 是否依赖外部服务 |
| --- | --- | --- |
| `task quality:lint` | Agent 语法、仓库 whitespace | 否 |
| `task quality:test` | Agent、API、Web 单元/契约测试 | 否 |
| API/Web build | TypeScript 编译和前端产物 | 否 |
| `task platform:smoke` | PostgreSQL migration/约束、Meilisearch health | 仅本地容器 |
| `task platform:e2e` | 假 GitHub → Collector → DB → 假 LLM Curator → Indexer → Meilisearch → API/Web → Search Agent SSE | 仅本地平台；无 GitHub/LLM |
| `task quality:check` | 上述本地静态与单元门禁、agent-compose config | 需要本地 agent-compose CLI |

完整命令、隔离要求和失败判定见 `docs/integration-gate.md`。未来工作包合并后应先更新
本矩阵，再把新增纵向场景加入 E2E；不得预先把尚不存在的接口标记为完成。
