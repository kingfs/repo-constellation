import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { ActiveJob, AgentAnswer, AgentEvent, AgentRun, AnalysisTaskStatus, ControlRun, FailedJob, JobSummary, LibraryStats, Project, ProjectFilters } from "./types";

type Route = { name: "catalog" | "updates" | "agent" | "progress" | "admin" } | { name: "detail"; id: string };

function parseRoute(): Route {
  const detail = window.location.pathname.match(/^\/projects\/([^/]+)$/);
  if (detail) return { name: "detail", id: decodeURIComponent(detail[1]) };
  if (window.location.pathname === "/updates") return { name: "updates" };
  if (window.location.pathname === "/agent-search") return { name: "agent" };
  if (window.location.pathname === "/progress") return { name: "progress" };
  if (window.location.pathname === "/admin") return { name: "admin" };
  return { name: "catalog" };
}

function useRoute() {
  const [route, setRoute] = useState<Route>(parseRoute);
  useEffect(() => { const handler = () => setRoute(parseRoute()); window.addEventListener("popstate", handler); return () => window.removeEventListener("popstate", handler); }, []);
  const navigate = (path: string) => { window.history.pushState({}, "", path); setRoute(parseRoute()); window.scrollTo({ top: 0 }); };
  return { route, navigate };
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)) : "暂无";
}

function duration(milliseconds: number | null) {
  if (milliseconds === null) return "—";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60); const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

function elapsed(value: string | null) {
  return value ? duration(Date.now() - new Date(value).getTime()) : "—";
}

function ProjectCard({ project, open }: { project: Project; open: () => void }) {
  return <article className="card">
    <div className="card-head"><span className={`activity activity-${project.activityClass}`}>{project.activityClass || "unknown"}</span><span>★ {project.starsCount.toLocaleString()}</span></div>
    <button className="title-link" onClick={open}>{project.analysis?.nameZh || project.fullName}</button>
    {project.analysis?.nameZh && <p className="repo-name">{project.fullName}</p>}
    <p className="summary">{project.analysis?.summaryZh || project.description || "暂无项目摘要"}</p>
    <div className="chips">{project.analysis?.categories.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div>
    <footer><span>{project.primaryLanguage || "未知语言"}</span><span>更新于 {date(project.pushedAt || project.githubUpdatedAt)}</span></footer>
  </article>;
}

function Status({ loading, error, empty, retry }: { loading: boolean; error: string; empty: boolean; retry: () => void }) {
  if (loading) return <div className="status" role="status"><span className="spinner" />正在载入知识库…</div>;
  if (error) return <div className="status error" role="alert"><p>{error}</p><button onClick={retry}>重新加载</button></div>;
  if (empty) return <div className="status"><strong>没有找到项目</strong><p>调整搜索词或筛选条件后再试。</p></div>;
  return null;
}

function Catalog({ navigate }: { navigate: (path: string) => void }) {
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState<ProjectFilters>({ page: 1, pageSize: 20, sort: "relevance" });
  const [items, setItems] = useState<Project[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => { const controller = new AbortController(); api.categories(controller.signal).then(setCategories).catch(() => undefined); return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    api.projects(filters, controller.signal).then((result) => { setItems(result.items); setTotal(result.total); }).catch((cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, reload]);
  const pages = Math.max(1, Math.ceil(total / (filters.pageSize ?? 20)));
  const change = (key: keyof ProjectFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined, page: 1 }));
  const submit = (event: FormEvent) => { event.preventDefault(); setFilters((current) => ({ ...current, q: draft.trim() || undefined, page: 1 })); };
  return <main>
    <section className="hero"><p className="eyebrow">YOUR CURATED OPEN-SOURCE MAP</p><h1>找到你曾经关注的那个项目</h1><p>搜索名称、用途和中文摘要，或按技术与活跃度筛选。</p>
      <form className="search" onSubmit={submit}><label className="sr-only" htmlFor="query">搜索项目</label><input id="query" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="例如：让 git diff 更易读的终端工具"/><button>搜索</button></form>
    </section>
    <section className="toolbar" aria-label="项目筛选">
      <select aria-label="分类" value={filters.category ?? ""} onChange={(e) => change("category", e.target.value)}><option value="">全部分类</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
      <input aria-label="编程语言" value={filters.language ?? ""} onChange={(e) => change("language", e.target.value)} placeholder="语言，如 Go" />
      <select aria-label="活跃度" value={filters.activity ?? ""} onChange={(e) => change("activity", e.target.value)}><option value="">全部活跃度</option><option value="hot">近期活跃</option><option value="active">持续维护</option><option value="quiet">低频更新</option><option value="stale">长期未更新</option></select>
      <select aria-label="排序" value={filters.sort ?? "relevance"} onChange={(e) => change("sort", e.target.value)}><option value="relevance">相关度</option><option value="updated">最近更新</option><option value="stars">Stars 数</option><option value="starred">最近收藏</option></select>
    </section>
    <div className="result-head"><strong>{filters.q ? `“${filters.q}” 的结果` : "全部项目"}</strong><span>{total.toLocaleString()} 个项目</span></div>
    <Status loading={loading} error={error} empty={!loading && !error && items.length === 0} retry={() => setReload((v) => v + 1)} />
    {!loading && !error && <section className="grid">{items.map((project) => <ProjectCard key={project.id} project={project} open={() => navigate(`/projects/${project.id}`)} />)}</section>}
    {!loading && !error && total > 0 && <nav className="pagination" aria-label="分页"><button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) - 1 }))}>上一页</button><span>第 {filters.page ?? 1} / {pages} 页</span><button disabled={(filters.page ?? 1) >= pages} onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}>下一页</button></nav>}
  </main>;
}

function Updates({ navigate }: { navigate: (path: string) => void }) {
  const [state, setState] = useState<{ items: Project[]; loading: boolean; error: string }>({ items: [], loading: true, error: "" });
  const [reload, setReload] = useState(0);
  const since = useMemo(() => { const value = new Date(); value.setDate(value.getDate() - 30); return value.toISOString(); }, []);
  useEffect(() => { const controller = new AbortController(); setState((s) => ({ ...s, loading: true, error: "" })); api.updates(since, 24, controller.signal).then((page) => setState({ items: page.items, loading: false, error: "" })).catch((cause: Error) => { if (cause.name !== "AbortError") setState({ items: [], loading: false, error: cause.message }); }); return () => controller.abort(); }, [since, reload]);
  return <main><section className="page-title"><p className="eyebrow">LAST 30 DAYS</p><h1>最近更新</h1><p>快速回到仍在演进的项目。</p></section><Status loading={state.loading} error={state.error} empty={!state.loading && !state.error && state.items.length === 0} retry={() => setReload((v) => v + 1)} />{!state.loading && !state.error && <section className="grid">{state.items.map((p) => <ProjectCard key={p.id} project={p} open={() => navigate(`/projects/${p.id}`)} />)}</section>}</main>;
}

function Detail({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const [project, setProject] = useState<Project>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [reload, setReload] = useState(0);
  const [analysisTask, setAnalysisTask] = useState<AnalysisTaskStatus>(); const [analysisError, setAnalysisError] = useState("");
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(""); api.project(id, controller.signal).then(setProject).catch((cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [id, reload]);
  useEffect(() => { const token = sessionStorage.getItem("star-atlas-admin-token") ?? ""; if (token) void api.analysisStatus(token, id).then(setAnalysisTask).catch(() => undefined); }, [id, reload]);
  useEffect(() => { if (!analysisTask || ["analyzed", "failed", "dead"].includes(analysisTask.state)) return; const token = sessionStorage.getItem("star-atlas-admin-token") ?? ""; if (!token) return; const refresh = () => Promise.all([api.project(id), api.analysisStatus(token, id)]).then(([latest, task]) => { setProject(latest); setAnalysisTask(latest.analysis ? { ...task, state: "analyzed" } : task); }).catch(() => undefined); const timer = window.setInterval(refresh, 5000); return () => clearInterval(timer); }, [analysisTask?.state, id]);
  if (loading || error || !project) return <main><button className="back" onClick={() => navigate("/")}>← 返回项目库</button><Status loading={loading} error={error} empty={!loading && !error && !project} retry={() => setReload((v) => v + 1)} /></main>;
  const analysis = project.analysis;
  const requestAnalysis = async () => { let token = sessionStorage.getItem("star-atlas-admin-token") ?? ""; if (!token) token = window.prompt("请输入根目录 .env 中的 ADMIN_TOKEN（未配置时使用 PLATFORM_AGENT_TOKEN）")?.trim() ?? ""; if (!token) return; setAnalysisError(""); try { sessionStorage.setItem("star-atlas-admin-token", token); await api.prioritizeAnalysis(token, project.id); setAnalysisTask(await api.analysisStatus(token, project.id)); } catch (cause) { if ((cause as { status?: number }).status === 401) sessionStorage.removeItem("star-atlas-admin-token"); setAnalysisError((cause as Error).message); } };
  const taskActive = analysisTask && ["queued", "running", "retry_wait"].includes(analysisTask.state);
  const taskMessage = analysisTask?.state === "running" ? "AI 正在分析" : analysisTask?.state === "retry_wait" ? "上次执行失败，等待自动重试" : "已进入优先分析队列";
  return <main><button className="back" onClick={() => navigate("/")}>← 返回项目库</button><article className="detail"><header><div><p className="eyebrow">{project.owner}</p><h1>{analysis?.nameZh || project.name}</h1><p className="repo-name">{project.fullName}</p></div><div className="detail-actions"><a className="primary-link" href={project.htmlUrl} target="_blank" rel="noreferrer">在 GitHub 查看 ↗</a>{!analysis && <button className="analyze-now" disabled={Boolean(taskActive)} onClick={() => void requestAnalysis()}>{taskActive ? "分析处理中…" : "立即分析"}</button>}</div></header>{analysisError && <div className="inline-error" role="alert">{analysisError}</div>}{taskActive && <div className="analysis-progress" role="status"><span className="spinner"/><div><strong>{taskMessage}</strong><p>尝试次数 {analysisTask.attempts}/{analysisTask.maxAttempts}；页面每 5 秒刷新状态。</p></div></div>}{analysisTask && ["failed", "dead"].includes(analysisTask.state) && <div className="inline-error" role="alert">分析失败：{analysisTask.lastError || "请稍后重新提交"}</div>}<p className="lead">{analysis?.summaryZh || project.description || "暂无项目摘要"}</p>
    <dl className="metrics"><div><dt>Stars</dt><dd>{project.starsCount.toLocaleString()}</dd></div><div><dt>语言</dt><dd>{project.primaryLanguage || "未知"}</dd></div><div><dt>活跃度</dt><dd>{project.activityClass}</dd></div><div><dt>最后推送</dt><dd>{date(project.pushedAt)}</dd></div></dl>
    {analysis ? <div className="detail-grid"><section><h2>解决的问题</h2><ul>{analysis.problemsSolved.map((v) => <li key={v}>{v}</li>)}</ul><h2>使用场景</h2><ul>{analysis.useCases.map((v) => <li key={v}>{v}</li>)}</ul></section><aside><h2>分类</h2><div className="chips">{analysis.categories.map((v) => <span key={v}>{v}</span>)}</div><h2>关键词</h2><div className="chips muted">{analysis.keywords.map((v) => <span key={v}>{v}</span>)}</div>{analysis.limitations.length > 0 && <><h2>限制</h2><ul>{analysis.limitations.map((v) => <li key={v}>{v}</li>)}</ul></>}</aside></div> : <div className="status">该项目尚未生成中文结构化分析。</div>}
  </article></main>;
}

function AgentSearch({ navigate }: { navigate: (path: string) => void }) {
  const [query, setQuery] = useState(""); const [events, setEvents] = useState<AgentEvent[]>([]); const [answer, setAnswer] = useState<AgentAnswer>(); const [running, setRunning] = useState(false); const [error, setError] = useState("");
  const [runId, setRunId] = useState(""); const [feedback, setFeedback] = useState<"" | "sending" | "sent">("");
  const cancel = useRef<() => void>(() => undefined); useEffect(() => () => cancel.current(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault(); const value = query.trim(); if (value.length < 2 || running) return;
    setEvents([]); setAnswer(undefined); setError(""); setRunId(""); setFeedback(""); setRunning(true);
    cancel.current(); cancel.current = api.agentSearch(value, (item) => { setRunId(item.runId); setEvents((current) => [...current, item]); if (item.type === "answer.completed" && item.data.answer) { setAnswer(item.data.answer); setRunning(false); } if (item.type === "run.failed") { setError(item.data.message ?? "搜索失败"); setRunning(false); } }, (message) => { setError(message); setRunning(false); });
  };
  const rate = async (rating: -1 | 1, action: "helpful" | "unhelpful") => { if (!answer || !runId || feedback) return; setFeedback("sending"); try { await api.feedback({ queryId: runId, queryText: query.trim(), resultRepositoryIds: answer.recommendations.map((item) => item.project.id), rating, action }); setFeedback("sent"); } catch (cause) { setFeedback(""); setError((cause as Error).message); } };
  return <main><section className="page-title"><p className="eyebrow">DEEP SEARCH</p><h1>自主搜索 Agent</h1><p>描述你记得的用途，Agent 会扩展关键词、多轮检索并比较候选。</p></section>
    <form className="search agent-query" onSubmit={submit}><label className="sr-only" htmlFor="agent-query">描述你的问题</label><input id="agent-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例如：能把 API 变成 MCP 的项目"/><button disabled={running}>{running ? "搜索中…" : "深度搜索"}</button></form>
    {error && <div className="status error" role="alert">{error}</div>}
    {events.length > 0 && <ol className="agent-events" aria-label="搜索步骤">{events.filter((e) => e.type !== "answer.completed").map((e) => <li key={e.id}><time>{new Date(e.at).toLocaleTimeString("zh-CN")}</time><span>{e.type === "search.started" ? `第 ${e.data.round} 轮：${e.data.query}` : e.type === "search.completed" ? `检索完成，累计 ${e.data.uniqueCandidates} 个候选` : e.type === "candidates.compared" ? `比较 ${e.data.candidateCount} 个候选` : "开始理解问题"}</span></li>)}</ol>}
    {answer && <section className="agent-answer"><header><h2>推荐结论</h2><span>置信度 {Math.round(answer.confidence * 100)}%</span></header><p className="lead">{answer.text}</p><p className="freshness">数据更新至 {date(answer.dataUpdatedAt)}</p><div className="grid">{answer.recommendations.map((item) => <article className="card" key={item.project.id}><button className="title-link" onClick={() => navigate(`/projects/${item.project.id}`)}>{item.project.analysis?.nameZh || item.project.fullName}</button><p className="repo-name">{item.project.fullName}</p><ul>{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><footer><span>匹配 {Math.round(item.confidence * 100)}%</span><span>{date(item.dataUpdatedAt)}</span></footer></article>)}</div><div className="feedback" aria-label="结果反馈">{feedback === "sent" ? <span role="status">感谢反馈</span> : <><span>这次推荐有帮助吗？</span><button disabled={feedback === "sending"} onClick={() => void rate(1, "helpful")}>有帮助</button><button disabled={feedback === "sending"} onClick={() => void rate(-1, "unhelpful")}>没帮助</button></>}</div></section>}
  </main>;
}

function Progress() {
  const [stats, setStats] = useState<LibraryStats>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [reload, setReload] = useState(0);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(""); api.stats(controller.signal).then(setStats).catch((cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [reload]);
  if (loading || error || !stats) return <main><section className="page-title"><p className="eyebrow">PIPELINE STATUS</p><h1>处理进度</h1></section><Status loading={loading} error={error} empty={!loading && !error && !stats} retry={() => setReload((value) => value + 1)} /></main>;
  const syncRate = stats.totalStars ? stats.syncedRepositories / stats.totalStars : 0; const analysisRate = stats.totalStars ? stats.analyzedRepositories / stats.totalStars : 0; const percentage = (value: number) => `${Math.round(value * 100)}%`;
  return <main><section className="page-title"><p className="eyebrow">PIPELINE STATUS</p><h1>处理进度</h1><p>查看 GitHub Stars 从同步、采集到模型整理的真实完成情况。</p></section>
    <section className="progress-summary" aria-label="知识库处理统计"><article><span>Stars 总数</span><strong>{stats.totalStars.toLocaleString()}</strong><p>当前仍在关注的仓库</p></article><article><span>已同步详情</span><strong>{stats.syncedRepositories.toLocaleString()}</strong><p>{percentage(syncRate)} 已获取当前快照</p></article><article><span>模型已分析</span><strong>{stats.analyzedRepositories.toLocaleString()}</strong><p>{percentage(analysisRate)} 已生成当前分析</p></article><article><span>等待分析</span><strong>{stats.pendingAnalysis.toLocaleString()}</strong><p>将由 Curator 分批处理</p></article></section>
    <section className="pipeline-progress"><div><header><strong>仓库同步</strong><span>{stats.syncedRepositories.toLocaleString()} / {stats.totalStars.toLocaleString()}</span></header><progress max={stats.totalStars || 1} value={stats.syncedRepositories}>{percentage(syncRate)}</progress></div><div><header><strong>模型整理</strong><span>{stats.analyzedRepositories.toLocaleString()} / {stats.totalStars.toLocaleString()}</span></header><progress max={stats.totalStars || 1} value={stats.analyzedRepositories}>{percentage(analysisRate)}</progress></div><p>数据更新于 {stats.updatedAt ? new Date(stats.updatedAt).toLocaleString("zh-CN") : "暂无"}</p></section>
  </main>;
}

function Admin() {
  const [token, setToken] = useState(() => sessionStorage.getItem("star-atlas-admin-token") ?? "");
  const [controlRuns, setControlRuns] = useState<ControlRun[]>([]); const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]); const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]); const [failures, setFailures] = useState<FailedJob[]>([]); const [summary, setSummary] = useState<JobSummary>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [connected, setConnected] = useState(false);
  const refresh = async (value = token) => {
    if (!value) return;
    const results = await Promise.allSettled([api.adminRuns(value), api.adminAgentRuns(value), api.adminActiveJobs(value), api.adminJobSummary(value), api.adminRecentFailures(value)]);
    if (results[0].status === "fulfilled") setControlRuns(results[0].value);
    if (results[1].status === "fulfilled") setAgentRuns(results[1].value);
    if (results[2].status === "fulfilled") setActiveJobs(results[2].value);
    if (results[3].status === "fulfilled") setSummary(results[3].value);
    if (results[4].status === "fulfilled") setFailures(results[4].value);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) { setError((rejected.reason as Error).message); setConnected(false); return; }
    setError(""); setConnected(true); sessionStorage.setItem("star-atlas-admin-token", value);
  };
  useEffect(() => { if (!token) return; void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [token]);
  const trigger = async (operation: "sync" | "curate") => { setBusy(true); try { await api.triggerAdminRun(token, operation); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } };
  const label: Record<string, string> = { sync: "同步 Stars", curate: "AI 整理" }; const status: Record<string, string> = { pending: "等待执行", running: "执行中", succeeded: "已完成", failed: "失败", canceled: "已取消", dead: "已终止", retry_wait: "等待重试" };
  const source: Record<string, string> = { cron: "定时", event: "事件", manual: "手动" };
  const count = (name: string) => summary?.counts[name] ?? 0;
  const healthy = connected && !agentRuns.some((run) => run.status === "running" && run.startedAt && Date.now() - new Date(run.startedAt).getTime() > 10 * 60 * 1000);
  return <main><section className="page-title"><p className="eyebrow">CONTROL PLANE</p><h1>任务控制台</h1><p>查看 Agent 自动运行、业务任务进度与人工控制请求；页面每 5 秒刷新。</p></section>
    <section className="admin-auth"><label htmlFor="admin-token">管理员 Token</label><input id="admin-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入根目录 .env 中的 ADMIN_TOKEN"/><button onClick={() => void refresh()}>连接</button></section>
    {error && <div className="status error" role="alert">{error}</div>}
    {token && <section className="health-overview" aria-label="运行健康概览"><article><span>后台状态</span><strong className={healthy ? "healthy" : "unhealthy"}>{healthy ? "运行正常" : connected ? "需要关注" : "连接中"}</strong><p>{connected ? "运维数据已连接" : "等待 Platform API 响应"}</p></article><article><span>分析并发</span><strong>{summary?.analysisConcurrency ? `${summary.analysisConcurrency.active}/${summary.analysisConcurrency.current}` : "—"}</strong><p>{summary?.analysisConcurrency ? `上限 ${summary.analysisConcurrency.max} · P95 ${summary.analysisConcurrency.p95Seconds == null ? "—" : `${Math.round(summary.analysisConcurrency.p95Seconds)} 秒`}` : "等待控制器数据"}</p></article><article><span>等待队列</span><strong>{summary ? count("pending") : "—"}</strong><p>等待 Worker 领取</p></article><article><span>异常任务</span><strong>{summary ? count("failed") + count("dead") : "—"}</strong><p>{summary ? count("retry_wait") : "—"} 项等待重试</p></article></section>}
    <section className="admin-actions"><article><h2>同步 GitHub Stars</h2><p>完整对账 Stars，并刷新到期仓库详情。</p><button disabled={!token || busy || controlRuns.some((run) => run.operation === "sync" && ["pending", "running"].includes(run.status))} onClick={() => void trigger("sync")}>立即同步</button></article><article><h2>分析下一项</h2><p>启动一个全新的模型会话处理最高优先级项目；全量队列每 10 分钟自动继续。</p><button disabled={!token || busy || controlRuns.some((run) => run.operation === "curate" && ["pending", "running"].includes(run.status))} onClick={() => void trigger("curate")}>分析下一项</button></article></section>
    <section className="run-history"><h2>当前正在处理</h2>{activeJobs.length === 0 ? <p className="empty-note">当前没有执行中的业务任务，后台会按计划继续领取队列。</p> : <div className="job-table">{activeJobs.map((job) => <article key={job.id}><div><strong>{job.fullName}</strong><small>{job.type}</small></div><span className={`run-status ${job.status}`}>{status[job.status] ?? job.status}</span><span>第 {job.attempts}/{job.maxAttempts} 次</span><span>已运行 {elapsed(job.startedAt)}</span><span>租约至 {job.leasedUntil ? new Date(job.leasedUntil).toLocaleTimeString("zh-CN") : "—"}</span><small>{job.workerId || "Worker 未知"}</small></article>)}</div>}</section>
    <section className="run-history"><h2>最近 Agent 运行</h2>{agentRuns.length === 0 ? <p className="empty-note">尚无 Agent 运行记录；自动触发后会显示在这里。</p> : <div className="agent-run-table">{agentRuns.map((run) => <article key={run.id}><div><strong>{run.agentName}</strong><small>{source[run.source] ?? run.source}{run.triggerId ? ` · ${run.triggerId}` : ""}</small></div><span className={`run-status ${run.status}`}>{status[run.status] ?? run.status}</span><time>{run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "尚未开始"}</time><span>{duration(run.durationMs)}</span>{run.summary && <p className="run-summary">{run.summary}</p>}{run.error && <p className="run-error">{run.error}</p>}</article>)}</div>}</section>
    <section className="run-history"><h2>人工控制请求</h2>{controlRuns.length === 0 ? <p className="empty-note">尚无人工控制请求。</p> : <div className="run-table">{controlRuns.map((run) => <article key={run.id}><strong>{label[run.operation]}</strong><span className={`run-status ${run.status}`}>{status[run.status] ?? run.status}</span><time>{new Date(run.requestedAt).toLocaleString("zh-CN")}</time>{run.error && <p>{run.error}</p>}</article>)}</div>}</section>
    <section className="run-history"><h2>最近失败</h2>{failures.length === 0 ? <p className="empty-note">最近没有失败的业务任务。</p> : <div className="failure-table">{failures.map((job) => <article key={job.id}><div><strong>{job.fullName}</strong><small>{job.type} · 第 {job.attempts}/{job.maxAttempts} 次</small></div><span className={`run-status ${job.status}`}>{status[job.status] ?? job.status}</span><time>{job.completedAt ? new Date(job.completedAt).toLocaleString("zh-CN") : "—"}</time>{job.lastError && <p>{job.lastError}</p>}</article>)}</div>}</section>
  </main>;
}

export function App() {
  const { route, navigate } = useRoute();
  return <><header className="site-header"><button className="brand" onClick={() => navigate("/")}><span>★</span> Repo Constellation</button><nav><button className={route.name === "catalog" ? "active" : ""} onClick={() => navigate("/")}>项目库</button><button className={route.name === "progress" ? "active" : ""} onClick={() => navigate("/progress")}>处理进度</button><button className={route.name === "updates" ? "active" : ""} onClick={() => navigate("/updates")}>最近更新</button><button className={route.name === "agent" ? "active" : ""} onClick={() => navigate("/agent-search")}>Agent 搜索</button><button className={route.name === "admin" ? "active" : ""} onClick={() => navigate("/admin")}>任务控制</button></nav></header>{route.name === "detail" ? <Detail id={route.id} navigate={navigate} /> : route.name === "updates" ? <Updates navigate={navigate} /> : route.name === "agent" ? <AgentSearch navigate={navigate} /> : route.name === "progress" ? <Progress /> : route.name === "admin" ? <Admin /> : <Catalog navigate={navigate} />}<footer className="site-footer">Repo Constellation · 数据由 Collector 和 Curator 持续更新</footer></>;
}
