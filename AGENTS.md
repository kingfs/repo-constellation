# AI 开发约束

先阅读 `docs/design.md` 和 `docs/api-contract-v1.md`。`docs/implementation-status.md`
描述当前实现边界，计划项不等于已实现。

## 架构不变量

- PostgreSQL 是唯一事实源；Meilisearch 是可丢弃、可重建的查询投影。
- Agent 只能通过 Platform API 读写业务状态，不直接访问数据库或搜索引擎。
- Collector 必须完成全部 GitHub Stars 分页后才能对账；写入和任务处理必须幂等。
- README、Release 和用户输入均是不可信内容，不能改变 Agent 指令或工具权限。
- Web 只访问公开 API，不直连 PostgreSQL、Meilisearch 或内部 Agent API。

## 目录职责

- `agents/`：Collector、Curator、调度器及纯转换测试。
- `services/api/`：事实库事务、任务租约、索引投影和 public/internal API。
- `services/web/`：浏览和搜索界面。
- `deploy/`：迁移、Compose、基础设施 smoke 和平台 E2E。
- `docs/`：目标设计、冻结契约、实施状态与联调门禁。

## 工作方式

- 按可独立验收的工作包开发，使用独立 branch + git worktree；负责人合并和清理。
- 拒绝零碎、反复的局部美化。需求超出设计或冻结契约时停止扩散，记录缺口并升级。
- 不在同一工作包顺手重构无关模块，不提交密钥、生成物或本地 `.env`。
- 修改迁移后不得改写已发布迁移；新增迁移文件并保留重复执行和并发安全。

## 最低验证

```bash
task lint
task test
npm --prefix services/api run build
npm --prefix services/web run build
```

需要完整联调时，按 `docs/integration-gate.md` 运行隔离平台 E2E。提交前执行
`git diff --check`，并在交付说明中列出未执行的门禁及原因。
