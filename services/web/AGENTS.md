# Web 模块约束

本目录只实现公开 API 上的浏览、筛选、搜索和详情体验。

- 只通过 `/api/v1` 访问 Platform API；禁止直连数据库、Meilisearch 或 `/internal/v1`。
- API 类型和空态、错误态、加载态一起演进；不要在组件中虚构后端能力。
- Search Agent 等未完成接口只保留明确扩展点，不用前端假数据伪装完成。
- 拒绝与联调目标无关的零碎视觉调整或框架替换。

验证：`npm --prefix services/web test && npm --prefix services/web run lint && npm --prefix services/web run build`。
