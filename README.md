# Repo Constellation

[English](README.en.md) · [架构设计](docs/design.md) · [API 契约](docs/api-contract-v1.md) · [实施状态](docs/implementation-status.md)

Repo Constellation 是一个面向个人 GitHub Stars 的 AI 知识库。它会持续同步你收藏的仓库，读取项目元数据、README 和 Release，由 AI 生成中文摘要、分类、关键词、适用场景与限制，并提供浏览、筛选、全文搜索和可解释的 Agent 深度搜索。

它不是简单的 Stars 备份，也不是 README 分块后做向量检索的传统 RAG。Repo Constellation 将收藏仓库视为持续变化的知识对象：只有内容发生变化时才重新分析，并保留分析所依据的内容快照和版本。

> 本项目基于 [chaitin/agent-compose](https://github.com/chaitin/agent-compose) 开发。agent-compose 负责 Agent 的声明、隔离运行、调度和事件编排；Repo Constellation 提供 GitHub Stars 场景下的 Collector、Curator、Search Agent、数据平台和 Web 界面。

## 主要能力

- 完整分页同步 GitHub Stars，安全对账取消收藏的项目
- 根据项目活跃度自适应刷新 README 与最新 Release
- 内容 hash 去重，只在数据变化时调用 LLM
- 将英文项目资料整理为稳定的中文结构化信息
- 按分类、语言、活跃度、许可证等条件浏览和搜索
- 使用 Search Agent 扩展中英文关键词、比较候选并给出依据
- 任务租约、幂等写入、失败重试、人工恢复和运行状态页面
- PostgreSQL 事实库与可随时重建的 Meilisearch 查询投影

## 工作原理

```text
GitHub API
    │
    ▼
Collector ──完整分页与条件刷新──▶ PostgreSQL
                                      │
                                      ▼
                              Curator jobs + LLM
                                      │
                                      ▼
                                结构化中文分析
                                      │
                                      ▼
Meilisearch ◀── Indexer ◀── Platform API ──▶ Web
                                      ▲
                                      │
                                Search Agent
```

PostgreSQL 是唯一事实源；Meilisearch 只是可删除、可重建的搜索投影。Agent 只能通过受限的 Platform API 访问业务状态，Web 也只访问公开 API。README、Release 和用户查询都按不可信输入处理，不能改变 Agent 权限。

## 快速开始

### 环境要求

- Linux 或支持 Docker socket 的 Docker 环境
- Docker Engine 及 Docker Compose v2
- Node.js 22+（运行测试和宿主机 CLI）
- [Task](https://taskfile.dev/)（推荐，也可直接运行对应命令）
- [agent-compose CLI](https://github.com/chaitin/agent-compose#快速开始)
- GitHub Token 和一个 agent-compose 支持的 LLM

### 1. 配置

```bash
git clone https://github.com/kingfs/repo-constellation.git
cd repo-constellation
cp .env.example .env
```

编辑 `.env`，至少填写：

```dotenv
GITHUB_TOKEN=你的_GitHub_Token
POSTGRES_PASSWORD=随机长密码
MEILI_MASTER_KEY=至少16字节的随机值
PLATFORM_AGENT_TOKEN=随机长令牌
ADMIN_TOKEN=另一个随机长令牌
AGENT_COMPOSE_AUTH_TOKEN=随机长令牌
AGENT_MODEL=你的模型名称
LLM_API_KEY=你的模型服务密钥
```

GitHub fine-grained token 需要读取 Starred repositories；classic token 对公开收藏可使用 `public_repo`，包含私有仓库时使用 `repo`。不要提交 `.env`。

### 2. 启动完整平台

`docker-compose.yml` 会启动 agent-compose、PostgreSQL、Meilisearch、Platform API 和 Web；Agent guest 镜像由本地源码构建。宿主机上的 agent-compose CLI 随后把 `agent-compose.yml` 应用到 daemon。

```bash
task setup:deps
task start
```

`task start` 会使用 `AGENT_COMPOSE_AUTH_TOKEN` 将本地 CLI 登录到 daemon。需要手工重新登录或只应用 Agent 配置时，可以运行：

```bash
task agent:login
task agent:apply
```

启动后访问：

- Web：<http://127.0.0.1:3000>
- Platform API：<http://127.0.0.1:8080>
- agent-compose daemon：<http://127.0.0.1:7410>

默认端口只绑定到 `127.0.0.1`。如需公网访问，请配置 HTTPS、鉴权、限流和可信反向代理。

### 3. 首次同步与整理

```bash
task agent:sync
task agent:curate
```

同步和整理 Scheduler 会继续周期运行。你也可以在 Web 的“任务控制”页面发起立即同步或 AI 整理，Admin Token 仅保存在浏览器当前会话中。

停止服务：

```bash
task stop
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `task start` | 构建并启动全部服务，应用 Agent 项目 |
| `task platform:up` | 使用已有镜像启动服务 |
| `task agent:apply` | 应用 Agent 定义并启用 Scheduler |
| `task agent:sync` | 立即完整同步 GitHub Stars |
| `task agent:curate` | 立即消费分析任务 |
| `task quality:check` | 运行静态检查、测试、构建与配置验证 |
| `task platform:smoke` | 验证基础设施和数据库约束 |
| `task platform:e2e` | 运行不依赖真实 GitHub/LLM 的平台 E2E |

生产部署、备份和恢复见[运维文档](docs/operations.md)，完整门禁见[联调指南](docs/integration-gate.md)。

## 安全与隐私

仓库内容、README、Release 和用户输入都可能包含提示注入或恶意文本。Curator 使用隔离 workspace 和严格结构化输出；Search Agent 默认只读。生产环境仍应使用最小权限 Token，并限制 API、Meilisearch、PostgreSQL 和 agent-compose daemon 的网络暴露。

提交安全问题前请阅读 [SECURITY.md](SECURITY.md)。本仓库不会接收或保存你的 `.env`，运行数据默认位于 Docker volumes 与 `.data/`，均已从 Git 忽略。

## 开发与贡献

```bash
task setup:deps
task quality:lint
task quality:test
npm --prefix services/api run build
npm --prefix services/web run build
git diff --check
```

贡献流程与架构约束见 [CONTRIBUTING.md](CONTRIBUTING.md)。当前实现边界以 [docs/implementation-status.md](docs/implementation-status.md) 为准，设计中的计划项不等于已经实现。

## 许可证

Repo Constellation 使用 [MIT License](LICENSE)。agent-compose 及其他依赖分别遵循其自身许可证。
