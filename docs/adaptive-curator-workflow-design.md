# Curator 自适应工作流设计

状态：阶段 A 已实现；正式 `runtime.workflow()` 接入属于可选后续演进
更新时间：2026-07-17

## 1. 结论

Curator 应从 4 个静态复制的 `star-curator-lane-[2..4]` 收敛为一个
`star-curator` Agent 定义和一个可持续补位的 workflow runner。

这里的“一个 Agent”指一份能力、镜像、权限和模型配置，不等于同一时刻只能执行一次模型调用。
runner 在一次 agent-compose run 内维护多个异步分析 slot；每个 slot 完成一个任务后立即领取下一个，
Platform API 根据队列积压、近期成功率、延迟和 provider pressure 动态决定全局允许的并发数。

职责边界如下：

```text
agent-compose scheduler
        │ 触发/恢复（不是扩缩容器）
        ▼
单个 star-curator workflow runner
        │ 最多启动 configuredMax 个异步 slot
        │ 空 slot 通过 claim 探测当前可用容量
        ▼
Platform API / PostgreSQL
        │ 业务 job 租约、幂等、全局动态配额
        ▼
agent-compose runtime.agent()
        │ 每个已领取 job 一次独立模型调用
        ▼
analysis complete/fail → 立即补位
```

不建议把 agent-compose 的 Agent 定义当作 Worker 副本手工展开，也不建议把业务队列和全局并发控制
迁移到 agent-compose workflow 的本地状态中。PostgreSQL 仍是唯一事实源。

## 2. 研究基线与已确认能力

本设计对照了 agent-compose 上游主分支提交
`a86ebd279962d88c8277d3cd52d380965ad41b99` 和 runtime SDK `0.7.0`。
源码基线来自该项目声明的上游仓库 `https://github.com/chaitin/agent-compose`。
实施前应再以实际部署版本复核，不能仅依据版本号推断能力。

### 2.1 当前已经具备

- Loader scheduler 支持 `cron`、`interval`、`timeout` 和 event trigger。
- `scheduler.exec()` 可以在隔离 sandbox 中运行 workspace Node.js 脚本。
- `@chaitin-ai/agent-compose-runtime-sdk` 的 `runtime.agent()` 可以从 Node.js 主动调用 provider，
  并支持结构化输出和超时。
- scheduler 对到期 trigger 逐个启动 goroutine，触发器本身不是严格串行的；若上一次运行未结束，
  后续到期运行可能重叠。
- `sandboxPolicy: new` 为调用创建新 sandbox；`sticky` 用于复用绑定 sandbox。Curator 的输入来自 API，
  不依赖本地会话状态，默认继续使用 `new` 更容易隔离故障。

### 2.2 当前尚未具备

agent-compose 的 `docs/spec/dynamic-workflow-spec.md` 明确说明 dynamic workflow 尚未实现。
当前 SDK 没有 `runtime.workflow()` / `workflowFile()`，runtime CLI 没有 `workflow` 子命令，Loader 也没有
`scheduler.workflow()`。

此外，v0.7.0 的 `runtime.agent()` 虽然接受 `stateRoot`，却没有在 SDK options 中暴露或向 runtime CLI
传递 `model`。本项目当前传入的额外 `model` 字段不能视为已经生效。并发调用若共享默认 `stateRoot`，
还可能竞争同一 provider session 状态。这两个问题都是并行化之前必须消除的前置条件。

规范中规划的 `agent()`、`parallel()`、`pipeline()`、恢复缓存、预算和统一 limiter 很有价值，
但不能作为当前实现的前置依赖。并且其 `concurrency` 是一次 workflow 内的静态上限，
并不感知本项目 PostgreSQL backlog、job lease 或 provider 近期压力。

### 2.3 对本项目的含义

dynamic workflow 的价值在于“怎样组织一次 run 内的多个子调用”，而本项目还需要解决：

- 多次 run 甚至多个部署实例之间的全局并发；
- job 的至少一次投递、租约过期和重试；
- `content_hash + analysis_version` 业务幂等；
- provider 限流后的退避；
- 服务重启后的可靠恢复。

这些状态已经由 Platform API 和 PostgreSQL 承担，不能复制到 guest runtime 的本地 workflow state。
未来接入正式 dynamic workflow 时，也只替换 runner 内部的编排实现，不改变事实源和任务协议。

## 3. 当前方案为什么低效

当前 `agent-compose.yml` 重复声明 4 个配置几乎相同的 Curator lane。每条 lane 每 10 分钟运行一次，
每次最多分析 10 个任务或运行 420 秒。Platform API 虽然维护 1～4 的动态分析配额，
却只能在 claim 时允许或拒绝，不能唤醒已经退出的 lane。

典型空闲过程是：

1. 四条 lane 同时触发，当前配额为 2；两条 claim 成功，另外两条看到容量已满并立即退出。
2. 一个模型调用提前完成，配额出现空位。
3. 已退出的 lane 不再探测，运行中的 lane 只有在当前调用结束后才可能补位。
4. 单次 run 达到任务数或时长上限后退出，直到下一个 10 分钟刻度才重新启动。

静态 lane 同时造成以下问题：

- 扩容决策和执行载体分离，`current_limit=4` 不代表实际有 4 个调用在运行；
- 配置、scheduler、测试和运维视图随最大并发数线性复制；
- 所有 lane 同刻触发，形成瞬时竞争而不是平滑供给；
- 提高上限需要修改 compose，而不是只调整平台策略；
- agent-compose run 被误用为固定 Worker 进程，削弱了 Agent 定义的语义。

## 4. 设计原则

### 4.1 Agent 定义表达能力，不表达副本

`star-curator` 唯一声明以下内容：

- provider/model；
- guest image；
- Platform API 凭据；
- 输入不可信边界；
- workflow runner 入口和最大资源护栏。

并发副本是运行时状态，不进入 YAML 名称空间。

### 4.2 调度器只负责触发和看门狗

scheduler 不根据队列长度生成 lane，也不保存业务进度。它负责：

- 周期启动 runner；
- Stars 同步后提前唤醒；
- runner 异常退出后的兜底恢复；
- 提供 run/sandbox 日志。

### 4.3 Platform API 掌握全局配额

只有 API 能在 PostgreSQL 事务中同时看到所有活跃租约，因此动态并发必须在 API 做最终仲裁。
runner 的本地并发仅是资源护栏，不能覆盖 API 配额。

### 4.4 一次只为即将执行的调用领取一个 job

每个 slot 只 claim 一个 job，执行完成后再 claim。这样不会让等待本地执行的 job 白白消耗租约，
也避免慢模型导致一批任务同时过期。

### 4.5 允许至少一次运行，副作用必须幂等

scheduler 可能重叠启动，进程也可能在提交 analysis 后、complete job 前退出。
正确性来自 job lease、analysis 唯一约束和 Idempotency-Key，而不是假设只有一个 runner。

## 5. 目标运行机制

### 5.1 一个 Agent，两类入口

保留一个 `star-curator` Agent，并在同一 scheduler script 注册：

- 每分钟 `curator-watchdog`：先串行轮询人工请求，再进入有界 drain，避免同一 Agent 的两个触发器竞争 loader；
- `scheduler.on("workflow.github-stars.synced", ...)`：新 snapshot 产生后立即触发。

两个入口调用同一个 runner。agent-compose 允许 watchdog、Stars 同步事件和人工请求短暂重叠；
当前实现不为此增加数据库结构或第二套业务租约，而是由 Platform API 在 PostgreSQL 事务内统一限制
所有 run 的分析容量。重叠 run 可能产生短暂空 claim，但不会突破全局模型并发。

runner 最长运行 8.5 分钟；每分钟 watchdog 在运行期间会由 loader 去重，并在 sandbox 收尾后的首个分钟 tick 继续 drain。无界 drain 会在 deadline 前按
模型 timeout 加提交余量停止新 claim，已开始的任务可以完成。这样既能持续补位，又不要求
agent-compose 承担永久守护进程。后续若 agent-compose 提供可靠的长驻 workflow 生命周期，可以延长
运行时间，但业务协议不变。

### 5.2 异步 slot 池

runner 创建 `CURATOR_LOCAL_MAX_CONCURRENCY` 个异步 slot，默认等于平台允许的最大值 4。
每个已领取 job 使用由 `runId + jobId` 派生的独立 runtime `stateRoot`，禁止多个并发调用共享 provider
session 状态。runner 必须把选定 model 确实传到 provider runner；若部署 SDK 尚不支持，应先升级 SDK
或补齐其 `model` 透传并通过契约测试，不能静默回退到 provider 默认模型。
slot 循环如下：

```text
while 未取消且未超过运行时限:
    claim(limit=1)
    if 获得 job:
        runtime.agent(structured prompt)
        submit analysis
        complete/fail job
        清空 idle backoff
        立即领取下一个
    else:
        带抖动等待 2s → 5s → 10s
        若全局队列持续为空 60～90s，则允许 runner 提前退出
```

所有 slot 同时存在不代表都能获得 job。API 在事务中按动态 `current_limit` 放行：

- 配额为 2 时，最多两个 slot 持有分析租约；
- 扩到 3 时，空闲 slot 最迟在下一次短轮询补上；
- 缩到 1 时，不强杀已运行调用，但完成后不再补到旧容量。

这种方式使伸缩速度由 10 分钟降低到数秒，同时仍保持有界资源使用。

### 5.3 API claim 必须精确限制剩余容量

当前逻辑只判断 `active >= capacity`，然后仍可能按请求 `limit` 领取。目标逻辑必须计算：

```text
remaining = max(0, capacity - active)
effectiveLimit = min(requestedLimit, remaining)
```

即使首版 slot 始终 `limit=1`，API 也应封闭这个边界，避免其他调用方突破全局配额。

可选的后续优化是让空 claim 返回非破坏性的控制提示：

```json
{
  "jobs": [],
  "analysisCapacity": {
    "current": 2,
    "active": 2,
    "retryAfterMs": 5000,
    "reason": "capacity_full"
  }
}
```

这属于 v1 向后兼容字段增加。首版也可以不修改响应，由 runner 自己退避。

### 5.4 动态并发控制

动态控制采用“快速补位、谨慎扩容、快速降压、缓慢恢复”：

| 信号 | 建议动作 |
| --- | --- |
| `backlog > 0` 且 `active < current` | 不调整配额，runner 立即补位 |
| `backlog >= current`，近 3～5 分钟健康且利用率高 | `current + 1` |
| 429、rate limit、OOM、provider unavailable | 立即减少 1；严重时减半 |
| 失败率 > 10% 或 P95 超过目标上界 | 减少 1 |
| backlog 为 0 持续一段时间 | 可保持 current；不必频繁缩到 1 |

现有 `backlog > 100`、15 分钟至少 10 个样本的扩容条件对私人 Stars 队列过于保守：
几十个任务也可能需要较快处理，却永远达不到扩容门槛。建议将阈值改为相对当前容量，并设置：

- 扩容观察窗：3～5 分钟；
- 扩容冷却：3 分钟；
- 压力缩容观察窗：1 分钟；
- 缩容冷却：1～2 分钟；
- 初始/最小/最大：2/1/4，生产观察稳定后才提高最大值。

控制器只在 claim 或独立维护 tick 时调整会导致“没有 claim 就不调整”。首版短轮询可以自然提供 tick；
后续更清晰的做法是将指标计算抽成 API 内部周期控制器，claim 只读取当前值。

### 5.5 优先任务

当前独立的 `star-curator-priority` 每分钟运行一次，会再次引入静态 Agent 副本并与普通任务竞争同一配额。
目标方案应由同一个 runner 领取所有分析任务，数据库按 `priority DESC, available_at, created_at` 排序。

为了避免持续普通任务占满配额导致点击任务等待，可选择以下之一：

1. 推荐：普通 slot 每完成一次即重新 claim，高优先级会在最近一次完成后自然抢占，通常只等待一个模型调用时长；
2. 若必须低延迟，API 为 priority 预留一个可借用容量：没有高优先级任务时普通任务可用，出现时下一次补位优先归还；
3. 不推荐：继续保留独立 priority Agent，因为它仍然是部署期副本且不能保证获得全局容量。

首版采用方案 1，先用实际等待时间验证是否需要容量预留。

## 6. 与 agent-compose dynamic workflow 的演进关系

### 阶段 A：使用现有 v0.7.0 能力

以普通 Node.js 实现 slot pool，内部并发调用 `runtime.agent()`。scheduler 通过 `scheduler.exec()` 启动。
这是当前即可交付、且不依赖上游未实现 API 的方案。

Node.js workflow runner 必须显式实现：

- 本地 concurrency limiter；
- AbortSignal 和单 job timeout；
- `Promise.allSettled` 式故障隔离；
- slot 空闲退避；
- shutdown 时停止新 claim，等待或失败化已领取 job；
- 有界日志和最终结构化摘要。

### 阶段 B：接入正式 runtime.workflow

仅当部署版本实际具备并验证以下能力后迁移：

- `runtime.workflow()` / `workflowFile()`；
- 所有子 agent 共享 limiter；
- abort/timeout 能终止 provider runner；
- 结构化结果和进度事件稳定；
- 并发调用的 provider state 相互隔离。

届时可以把 slot 内的模型调用或一批已领取 job 表达为 `parallel()` / `pipeline()`，但仍需保留：

- PostgreSQL job lease；
- Platform API 动态配额；
- analysis 业务幂等；
- API complete/fail；
- scheduler 看门狗。

不采用 dynamic workflow 的本地 resume cache 作为业务成功依据。缓存最多优化重复模型计算，
是否已经分析成功必须由 PostgreSQL 中的 `repository_analyses` 判断。

### 阶段 C：可选的事件驱动唤醒

若 agent-compose 后续提供可靠、可背压的 workflow 唤醒接口，可在 analysis job 从 0 变为 1 时发布事件，
减少空轮询。周期看门狗仍保留，用于弥补事件丢失、服务重启和状态恢复。

## 7. 失败、重启与重叠语义

### 7.1 runner 重叠

scheduler 允许到期 run 并发启动，因此不能依赖 trigger 自带的“单实例”语义。
当前不增加 `curator_dispatch` 数据库租约。短暂重叠由 job claim 的事务锁和动态配额收口，保证模型并发
不突破平台上限；空 claim 使用有抖动退避，避免容量已满时形成高频请求。

### 7.2 模型调用超时

单 job timeout 应小于 job lease，并预留提交失败结果的时间。例如：

- 模型 timeout：90 秒；
- job lease：5 分钟；
- runner 最大运行：8 分钟；
- control lease：10 分钟。

当前 job lease 为 30 分钟，安全但故障恢复过慢。实现阶段可先保留，增加 job heartbeat 后再缩短。

### 7.3 进程终止

收到 SIGTERM/SIGINT：

1. 停止所有新 claim；
2. 通知正在运行的模型调用取消；
3. 对能够确认取消的 job 调用 retryable fail；
4. 无法确认的 job 留给租约过期恢复；
5. 释放 control lease。

### 7.4 提交与完成之间崩溃

analysis 提交使用稳定 Idempotency-Key 和数据库唯一约束。重领 job 后发现 analysis 已存在，claim 清理逻辑
将其收敛为 succeeded，避免重复模型调用。该路径应加入集成测试。

## 8. 可观测性与调优

只看 scheduler run 次数不能判断模型是否被充分利用。至少记录：

- `analysis_concurrency.current/max/active`；
- `analysis_backlog` 和 oldest pending age；
- `curator_local_slots.busy/idle`；
- claim 结果：`claimed/capacity_full/queue_empty/error`；
- 模型调用吞吐、成功率、P50/P95；
- 429、timeout、unavailable 分类计数；
- slot 从完成到下一次调用开始的补位延迟；
- runner 启动、控制租约冲突、提前空闲退出和异常退出。

核心 SLO 建议：

- backlog 存在且 provider 健康时，`active/current >= 0.8`；
- slot 补位 P95 小于 10 秒；
- 高优先级任务等待领取 P95 小于一个普通模型调用时长；
- 因本地批次/定时刻度造成的空闲时间接近 0；
- 动态配额不超过配置最大值，429 后 1 分钟内开始降压。

## 9. 方案比较

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 手写 4 条 lane | 简单、已有实现 | 配置复制、同刻竞争、补位慢、上限变更需部署 | 淘汰 |
| 把 cron 改成每分钟 | 改动小 | 仍产生大量短 run，容量满时立即退出，治标不治本 | 仅作临时缓解 |
| 单 Agent + 长驻串行 drain | 配置简单 | 只能一个模型调用，未利用动态并发 | 不采用 |
| 单 Agent + Node.js 自适应 slot pool | 当前可实现、快速补位、API 保持全局仲裁 | runner 需实现少量编排基础设施 | 推荐 |
| 等待 agent-compose dynamic workflow | 未来抽象更统一 | 当前未实现，且仍不解决分布式业务配额 | 后续演进 |
| API 为每个 job 启动 agent-compose run | 事件驱动、每 job 可观测 | run/sandbox 启动成本高，突发时需额外 dispatcher/限流 | 暂不采用 |

## 10. 实施工作包

### WP1：单 Agent runner 与精确配额

- 新增 Curator workflow runner 的有界 slot pool；
- 为每个 job 隔离 runtime state root，并补齐/验证 SDK model 透传；
- API claim 限制为剩余容量；
- 验证重叠 runner 由现有 job 租约和全局配额安全收敛，不新增数据库状态；
- 覆盖并行成功、单 slot 失败、容量不足、取消和租约恢复测试。

验收：只保留一个 `star-curator` 也能稳定达到 `active=current`。

### WP2：配置收敛与调度切换

- 删除 `star-curator-lane-[2..4]` 和独立 priority Agent；
- 一个 scheduler script 同时注册 watchdog 和 Stars synced event；
- 保留旧入口一版兼容窗口，确认无运行中旧租约后再清理；
- 更新 agent run bridge 的 Agent 名称白名单和测试。

验收：compose 中 Curator 能力只声明一次，配置最大并发无需增加 Agent 定义。

### WP3：动态策略校准

- 将绝对 backlog 100 改为相对容量阈值；
- 增加 provider pressure 分类和利用率指标；
- 运行至少一晚，比较吞吐、429、P95 和空闲比例；
- 有证据后再决定是否将最大并发提高到 6～8。

验收：健康积压期间利用率达到 SLO，压力出现时能自动降压且无振荡。

### WP4：可选接入正式 dynamic workflow

- 锁定已包含 workflow API 的 agent-compose/runtime SDK 版本；
- 用契约测试验证并发、取消、结构化结果和 provider state 隔离；
- 只替换 runner 内部编排，不迁移业务状态。

## 11. 最低测试门禁

除项目通用门禁外，实施必须新增以下场景：

- 配额 2、4 个本地 slot、10 个 pending job 时，任意时刻最多 2 个模型调用；
- 配额从 2 调到 3 后，10 秒内第三个调用开始；
- 配额从 3 调到 1 后不杀死已运行任务，后续 active 最终收敛到 1；
- 一个 slot 模型失败不终止其他 slot；
- 并发 slot 使用不同 provider state root，指定 model 到达实际 provider runner；
- queue empty 与 capacity full 使用不同退避/指标；
- 两个重叠 runner 不突破全局配额；
- analysis 已提交但 job 未 complete 的崩溃能够幂等收敛；
- Stars synced event 和周期看门狗同时触发时只保留一个有效 dispatcher。

完整实现仍需执行：

```bash
task lint
task test
npm --prefix services/api run build
npm --prefix services/web run build
git diff --check
```

涉及实际 agent-compose 调度与 sandbox 并行时，还需按 `docs/integration-gate.md` 执行隔离平台 E2E，
并使用部署中的 agent-compose 精确版本验证，而不是仅依赖假 LLM 单测。
