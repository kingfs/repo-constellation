import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const project = { id:"11111111-1111-4111-8111-111111111111", githubId:"1", fullName:"dandavison/delta", owner:"dandavison", name:"delta", htmlUrl:"https://github.com/dandavison/delta", description:"A syntax-highlighting pager", primaryLanguage:"Rust", topics:["git"], licenseSpdx:"MIT", starsCount:26000, forksCount:400, openIssuesCount:10, pushedAt:"2026-07-01T00:00:00Z", githubUpdatedAt:"2026-07-01T00:00:00Z", starredAt:"2025-01-01T00:00:00Z", unstarredAt:null, archived:false, activityClass:"hot", updatedAt:"2026-07-01T00:00:00Z", analysis:{ nameZh:"Delta", summaryZh:"让 git diff 更易读", categories:["Git 工具"], keywords:["diff"], aliases:[], useCases:["查看代码差异"], problemsSolved:["改善差异可读性"], targetUsers:["开发者"], technologies:["Rust"], limitations:[] } };
beforeEach(() => {
  window.history.replaceState({}, "", "/"); sessionStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/categories")) return { ok:true, json:async()=>({items:[{name:"Git 工具",count:1}]}) };
    if (url.includes("/stats")) return { ok:true, json:async()=>({totalStars:5067,syncedRepositories:5067,analyzedRepositories:60,pendingAnalysis:5007,updatedAt:"2026-07-15T00:00:00Z"}) };
    if (url.includes(`/projects/${project.id}`)) return { ok:true, json:async()=>project };
    if (url.includes("/search?")) return { ok:true, json:async()=>({items:[{project,matchedFields:["summaryZh"],highlights:{},dataUpdatedAt:project.updatedAt}],page:1,pageSize:20,total:1,indexVersion:"v1"}) };
    if (url.includes("/agent/search")) return { ok:true, json:async()=>({runId:"run-1",eventsUrl:"/api/v1/agent/search/run-1/events"}) };
    return { ok:true, json:async()=>({items:[project],page:1,pageSize:20,total:1}) };
  }));
});
describe("web application", () => {
  it("searches, filters, and opens project details", async () => {
    render(<App />);
    expect(await screen.findByText("Delta")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索项目"), { target: { value: "git diff" } });
    fireEvent.submit(screen.getByRole("button", { name:"搜索" }).closest("form")!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/search?"), expect.anything()));
    fireEvent.click(screen.getByText("Delta"));
    expect(await screen.findByText("解决的问题")).toBeInTheDocument();
    expect(screen.getByText("改善差异可读性")).toBeInTheDocument();
  });
  it("streams and displays an explainable agent recommendation", async () => {
    class MockEventSource { listeners = new Map<string, (event: MessageEvent) => void>(); onerror: (() => void) | null = null; constructor(_url: string) { setTimeout(() => { const answer = { text:"首选 delta",confidence:.9,dataUpdatedAt:project.updatedAt,recommendations:[{project,reasons:["改善差异可读性"],confidence:.9,dataUpdatedAt:project.updatedAt}],alternatives:[] }; this.listeners.get("answer.completed")?.({ data: JSON.stringify({id:1,runId:"run-1",type:"answer.completed",at:project.updatedAt,data:{answer}}) } as MessageEvent); }, 0); } addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as (event: MessageEvent) => void); } close() {} }
    vi.stubGlobal("EventSource", MockEventSource);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name:"Agent 搜索" }));
    fireEvent.change(await screen.findByLabelText("描述你的问题"), { target: { value: "让 git diff 更好看" } }); fireEvent.click(screen.getByRole("button", { name: "深度搜索" }));
    expect(await screen.findByText("首选 delta")).toBeInTheDocument(); expect(screen.getByText("改善差异可读性")).toBeInTheDocument();
  });
  it("shows real synchronization and model analysis progress", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "处理进度" }));
    expect(await screen.findByText("Stars 总数")).toBeInTheDocument();
    expect(screen.getByText("5,067 / 5,067")).toBeInTheDocument();
    expect(screen.getByText("60 / 5,067")).toBeInTheDocument();
    expect(screen.getByText("5,007")).toBeInTheDocument();
  });
  it("opens the authenticated task control page", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "任务控制" }));
    expect(await screen.findByRole("heading", { name: "任务控制台" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即同步" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "分析下一项" })).toBeDisabled();
  });
  it("separates running agents, active jobs, control requests, and failures", async () => {
    window.history.replaceState({}, "", "/admin"); sessionStorage.setItem("star-atlas-admin-token", "admin-token");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/agent-runs")) return { ok:true, json:async()=>({items:[{id:"run-1",agentName:"star-curator",triggerId:"every-ten-minutes",source:"cron",status:"running",startedAt:new Date().toISOString(),completedAt:null,durationMs:null,sandboxId:"sandbox-1",summary:"已领取 1 个任务",error:null},{id:"run-2",agentName:"star-sync",triggerId:null,source:"manual",status:"failed",startedAt:"2026-07-15T20:00:00Z",completedAt:"2026-07-15T20:00:10Z",durationMs:10000,sandboxId:"sandbox-2",summary:null,error:"GitHub unavailable"}]}) };
      if (url.endsWith("/jobs/active")) return { ok:true, json:async()=>({items:[{id:"job-1",type:"analyze_repository",status:"running",repositoryId:project.id,fullName:"nbs-system/naxsi",priority:0,attempts:1,maxAttempts:5,startedAt:new Date().toISOString(),lastHeartbeatAt:null,leasedUntil:new Date(Date.now()+600000).toISOString(),workerId:"curator-33",runId:"run-1",sandboxId:"sandbox-1"}]}) };
      if (url.endsWith("/jobs/summary")) return { ok:true, json:async()=>({counts:{pending:4942,running:1,retry_wait:2,failed:1,dead:0},oldestPendingAt:null,checkedAt:new Date().toISOString()}) };
      if (url.endsWith("/jobs/recent-failures")) return { ok:true, json:async()=>({items:[{id:"job-2",type:"analyze_repository",status:"failed",repositoryId:project.id,fullName:"owner/broken",attempts:2,maxAttempts:5,lastError:"model timeout",availableAt:null,completedAt:"2026-07-15T20:00:00Z"}]}) };
      if (url.endsWith("/admin/runs")) return { ok:true, json:async()=>({items:[{id:"control-1",operation:"sync",status:"failed",requestedAt:"2026-07-15T19:00:00Z",startedAt:null,completedAt:null,result:null,error:"invalid limit"}]}) };
      return { ok:false,status:404,json:async()=>({error:{message:"not found"}}) };
    }));
    render(<App />);
    expect(await screen.findByText("运行正常")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name:"当前正在处理" })).toBeInTheDocument(); expect(screen.getByText("nbs-system/naxsi")).toBeInTheDocument(); expect(screen.getByText("第 1/5 次")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name:"最近 Agent 运行" })).toBeInTheDocument(); expect(screen.getByText("star-curator")).toBeInTheDocument(); expect(screen.getByText(/定时 · every-ten-minutes/)).toBeInTheDocument(); expect(screen.getByText("GitHub unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name:"人工控制请求" })).toBeInTheDocument(); expect(screen.getByText("invalid limit")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name:"最近失败" })).toBeInTheDocument(); expect(screen.getByText("owner/broken")).toBeInTheDocument(); expect(screen.getByText("model timeout")).toBeInTheDocument();
  });
  it("shows clear empty operational states", async () => {
    window.history.replaceState({}, "", "/admin"); sessionStorage.setItem("star-atlas-admin-token", "admin-token");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => ({ ok:true, json:async()=> String(input).endsWith("/jobs/summary") ? {counts:{},oldestPendingAt:null,checkedAt:null} : {items:[]} })));
    render(<App />);
    expect(await screen.findByText(/当前没有执行中的业务任务/)).toBeInTheDocument();
    expect(screen.getByText(/尚无 Agent 运行记录/)).toBeInTheDocument(); expect(screen.getByText("尚无人工控制请求。")).toBeInTheDocument(); expect(screen.getByText("最近没有失败的业务任务。")).toBeInTheDocument();
  });
  it("offers immediate analysis on an unanalyzed project detail", async () => {
    const unanalyzed = { ...project, analysis: null }; const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/categories")) return { ok:true, json:async()=>({items:[]}) };
      if (url.includes(`/projects/${project.id}/analyze`)) return { ok:true, json:async()=>({jobId:"job",status:"queued"}) };
      if (url.includes(`/projects/${project.id}/analysis-status`)) return { ok:true, json:async()=>({repositoryId:project.id,state:"queued",jobId:"job",attempts:0,maxAttempts:5,availableAt:new Date().toISOString(),leasedUntil:null,lastError:null}) };
      if (url.includes(`/projects/${project.id}`)) return { ok:true, json:async()=>unanalyzed };
      return { ok:true, json:async()=>({items:[unanalyzed],page:1,pageSize:20,total:1}) };
    }); vi.stubGlobal("fetch", fetch); vi.stubGlobal("prompt", vi.fn(() => "admin-token"));
    render(<App />); fireEvent.click(await screen.findByText(project.fullName)); fireEvent.click(await screen.findByRole("button", { name: "立即分析" }));
    expect(await screen.findByRole("button", { name: "分析处理中…" })).toBeDisabled();
    expect(screen.getByText("已进入优先分析队列")).toBeInTheDocument();
    expect(screen.getByText(/尝试次数 0\/5/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/projects/${project.id}/analyze`), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer admin-token" }) }));
  });
});
