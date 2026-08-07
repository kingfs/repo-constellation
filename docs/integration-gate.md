# 联调与发布门禁

## 快速门禁

在仓库根目录执行：

```bash
task quality:lint
task quality:test
npm --prefix services/api run build
npm --prefix services/web run build
```

这些检查不访问 GitHub、LLM、PostgreSQL 或 Meilisearch。`task quality:check` 额外验证
agent-compose 配置，需要通过 `AGENT_COMPOSE=/path/to/agent-compose` 指定 CLI。

发布候选还必须执行并留存：

```bash
task ops:check
task ops:backup -- ./release.dump
task ops:restore-drill -- ./release.dump
API_URL=http://127.0.0.1:8080 task search:evaluate -- docs/search-evaluation.json
```

## 隔离平台门禁

E2E 会写入固定 fixture `example/delta-tool`，必须针对开发或临时数据库运行：

```bash
cp .env.example .env
# 设置 POSTGRES_PASSWORD、MEILI_MASTER_KEY、PLATFORM_AGENT_TOKEN
task platform:rebuild
task platform:smoke

API_URL=http://127.0.0.1:8080 \
WEB_URL=http://127.0.0.1:3000 \
PLATFORM_AGENT_TOKEN="$(sed -n 's/^PLATFORM_AGENT_TOKEN=//p' .env)" \
task platform:e2e
```

`platform-e2e` 在进程内模拟 GitHub 分页、README、Release 和 LLM 结构化输出，
但使用真实 Collector、Platform API、PostgreSQL job、Curator、后台 Indexer、
Meilisearch、public API 和 Web 反向代理。它不需要 `GITHUB_TOKEN`、网络访问或模型额度。

通过标准：迁移和 schema 检查成功，Collector 产生 snapshot/analyze job，Curator 提交
analysis 并完成 job，Indexer 最终使中文/英文关键词可搜索，Search Agent run 通过 SSE
返回引用该项目的可解释答案，Web 首页可访问。

## 合并后扩展规则

- 新工作包必须增加单元/契约测试；只有跨进程主链路才加入平台 E2E。
- dead job 管理的状态转换由数据库/API 契约测试覆盖；若未来增加运维 Worker，再补跨进程场景。
- 不为尚未合并的接口写虚假通过用例；在 `implementation-status.md` 保持待办即可。
- 发布候选必须记录门禁命令、结果、commit 和任何未执行项，不能以人工点击替代失败测试。
