# Security Policy

## Reporting a vulnerability

请不要通过公开 Issue 披露尚未修复的漏洞。使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告渠道，并提供受影响版本、复现步骤、潜在影响和建议缓解方式。

Do not disclose unpatched vulnerabilities in public issues. Please use the repository's private **Security → Report a vulnerability** channel and include the affected version, reproduction steps, impact and suggested mitigation.

## Deployment guidance

- 使用最小权限 GitHub Token；除非确实需要私有 Stars，不要授予 `repo` 权限。
- 为 Platform Agent、Admin 和 agent-compose daemon 使用不同的高熵 Token。
- 默认只在回环地址暴露端口；公网部署必须使用 HTTPS、鉴权、限流和可信反向代理。
- 不要公开 PostgreSQL、Meilisearch 或 Docker socket。
- README、Release 和搜索问题是不可信输入；不要放宽 Curator 隔离或 Search Agent 只读边界。
- `.env`、`.data/`、备份和日志可能包含敏感信息，不应提交或公开分发。

本项目只对当前默认分支提供安全修复。
