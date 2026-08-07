# Contributing to Repo Constellation

感谢你参与 Repo Constellation。提交改动前，请先阅读 `docs/design.md`、`docs/api-contract-v1.md` 和 `docs/implementation-status.md`。

## 开发原则

- PostgreSQL 是唯一事实源，Meilisearch 只能作为可重建投影。
- Agent 通过 Platform API 访问业务状态；Web 只访问公开 API。
- Collector 完成所有 Stars 分页后才能对账；所有副作用必须幂等。
- README、Release 和用户输入是不可信数据，不能改变指令或权限。
- 不在一个工作包中顺手重构无关模块；破坏性 API 变更必须升级版本。
- 不提交 `.env`、凭据、运行数据、构建产物或本地绝对路径。

## 本地验证

```bash
task setup:deps
task quality:lint
task quality:test
npm --prefix services/api run build
npm --prefix services/web run build
git diff --check
```

修改基础设施、迁移或主链路时，按 `docs/integration-gate.md` 运行对应 smoke/E2E。迁移发布后不得改写；请新增迁移并保持重复执行及并发安全。

## Pull Request

请让每个 PR 聚焦一个可独立验收的工作包，并在描述中说明：

- 改动解决的问题与边界；
- 数据、API 或安全影响；
- 已执行的验证；
- 未执行门禁及原因。

提交信息建议遵循 Conventional Commits，例如 `feat(web): add repository filters`。
