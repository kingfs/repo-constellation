# Platform API 模块约束

本目录拥有事实库事务、任务状态和 Meilisearch 投影。保持 adapter 边界，使业务测试不依赖外部服务。

- PostgreSQL 是事实源；索引写入必须可重试、幂等并能从数据库全量重建。
- internal API 必须鉴权、校验边界输入并保持 `docs/api-contract-v1.md` 兼容。
- 租约领取、完成/失败、快照去重和 analysis 提交的状态转换必须在事务约束下成立。
- 禁止把仅存在于 Meilisearch 的数据作为业务事实，禁止为局部需求破坏冻结契约。
- 数据库变更使用新 migration；错误格式、游标和幂等语义需要测试。

验证：`npm --prefix services/api test && npm --prefix services/api run lint && npm --prefix services/api run build`。
