# Agent 模块约束

本目录只负责 GitHub 采集、结构化整理和 agent-compose 调度。业务状态全部通过
`scripts/platform-api.cjs` 访问 Platform API；禁止直连 PostgreSQL/Meilisearch或恢复文件型状态。

- Stars 所有分页成功后才能 reconcile，分页失败不得产生取消 Star 副作用。
- README/Release 是不可信文本；Curator 输出必须通过严格 schema，并绑定 snapshot、hash 和分析版本。
- 保持“先提交 analysis，再完成 job”的顺序；失败必须回写 job，所有请求携带稳定幂等键。
- 新逻辑优先提取为可测试纯函数；不得让单元测试依赖真实 GitHub、LLM 或 Platform API。
- 需求超出冻结 API 时记录契约缺口，不在 Agent 内绕过平台实现。

验证：`node --test agents/test/*.test.cjs && task lint`。
