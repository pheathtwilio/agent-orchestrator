"use client";

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/cn";
import { usePlanEvents, type PlanTask } from "@/hooks/usePlanEvents";
import { SwimLane } from "./plans/SwimLane";
import { TaskQueueLog } from "./plans/TaskQueueLog";
import { PlanSummaryPanel } from "./plans/PlanSummaryPanel";
import { UsageBanner } from "./plans/UsageBanner";
import { CreatePlanForm } from "./plans/CreatePlanForm";

// ── Types ──

interface PlanListItem {
  id: string;
  featureId: string;
  title: string;
  taskCount: number;
  complete: number;
  inProgress: number;
  pending: number;
  failed: number;
  progressPercent: number;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
}

interface ContainerInfo {
  name: string;
  status: string;
  state: "running" | "exited" | "dead" | "created" | "unknown";
  uptime: string;
}

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
}

// ── Helpers ──

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full bg-zinc-800 rounded-full h-1.5">
      <div
        className="bg-green-500 h-1.5 rounded-full transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function TimeAgo({ timestamp }: { timestamp: number }) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return <span>{seconds}s ago</span>;
  if (seconds < 3600) return <span>{Math.floor(seconds / 60)}m ago</span>;
  return <span>{Math.floor(seconds / 3600)}h ago</span>;
}

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px]">
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          connected ? "bg-green-400" : "bg-zinc-600",
        )}
      />
      <span className={connected ? "text-green-500" : "text-zinc-600"}>
        {connected ? "Live" : "Connecting..."}
      </span>
    </span>
  );
}

/** Group tasks by status category for the swim lane view */
function groupTasks(tasks: PlanTask[]) {
  const active: PlanTask[] = [];
  const waiting: PlanTask[] = [];
  const done: PlanTask[] = [];

  for (const t of tasks) {
    if (["assigned", "in_progress", "testing"].includes(t.status)) {
      active.push(t);
    } else if (["pending", "blocked"].includes(t.status)) {
      waiting.push(t);
    } else {
      done.push(t);
    }
  }

  return { active, waiting, done };
}

// ── Main Component ──

interface ProjectInfo {
  id: string;
  name: string;
  repo: string;
}

export function PlansDashboard() {
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [followOutput, setFollowOutput] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"lanes" | "log" | "summary">("lanes");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string>("main");
  const [restartingWatchers, setRestartingWatchers] = useState(false);

  // SSE connection for the selected plan
  const { snapshot, messages, outputLines, connected } = usePlanEvents(
    selectedPlanId,
    followOutput,
  );

  const fetchPlans = useCallback(async () => {
    try {
      const url = showArchived ? "/api/plans?include=archived" : "/api/plans";
      const res = await fetch(url);
      const data = await res.json();
      setPlans(data.plans ?? []);
    } catch {
      // Retry next poll
    }
    setLoading(false);
  }, [showArchived]);

  const fetchContainers = useCallback(async () => {
    try {
      const res = await fetch("/api/containers");
      const data = await res.json();
      setContainers(data.containers ?? []);
    } catch {
      // Retry next poll
    }
  }, []);

  const fetchBranches = useCallback(async () => {
    try {
      const res = await fetch("/api/projects/branches");
      const data = await res.json();
      setBranches(data.branches ?? []);
      if (data.defaultBranch) setDefaultBranch(data.defaultBranch);
    } catch {
      // Retry next poll
    }
  }, []);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects(data.projects ?? []))
      .catch(() => {});
    fetchPlans();
    fetchContainers();
    fetchBranches();
    const interval = setInterval(() => {
      fetchPlans();
      fetchContainers();
      fetchBranches();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchPlans, fetchContainers, fetchBranches]);

  const primaryProject = projects[0];

  async function archivePlan(planId: string) {
    await fetch(`/api/plans/${planId}/archive`, { method: "POST" });
    fetchPlans();
    if (selectedPlanId === planId) setSelectedPlanId(null);
  }

  async function unarchivePlan(planId: string) {
    await fetch(`/api/plans/${planId}/archive`, { method: "DELETE" });
    fetchPlans();
  }

  async function cancelPlan(planId: string) {
    await fetch(`/api/plans/${planId}/cancel`, { method: "POST" });
    setSelectedPlanId(null);
    fetchPlans();
  }

  async function retryPlan(planId: string) {
    await fetch(`/api/plans/${planId}/retry`, { method: "POST" });
    fetchPlans();
  }

  // Derive plan detail from SSE snapshot
  const planDetail = snapshot
    ? {
        id: snapshot.plan.id,
        title: snapshot.plan.title,
        featureId: snapshot.plan.featureId,
        createdAt: snapshot.plan.createdAt,
        updatedAt: snapshot.plan.updatedAt,
        tasks: snapshot.tasks,
      }
    : null;

  const isTerminal = planDetail
    ? planDetail.tasks.every((t) => ["complete", "failed"].includes(t.status))
    : false;

  const groups = planDetail ? groupTasks(planDetail.tasks) : null;

  // Compute the latest meaningful bus message per task for stage display
  const latestActivityByTask = new Map<string, string>();
  for (const msg of messages) {
    const taskId = msg.payload.taskId as string | undefined;
    if (!taskId) continue;
    const summary = (msg.payload.summary as string)
      ?? (msg.payload.status as string)
      ?? (msg.payload.reason as string)
      ?? "";
    if (summary) {
      latestActivityByTask.set(taskId, summary);
    }
  }

  // Auto-expand active swim lanes when stream output is toggled on.
  // Use a stable key (sorted active IDs) to avoid re-running on every snapshot.
  const activeTaskIds = planDetail
    ? planDetail.tasks
        .filter((t) => ["assigned", "in_progress", "testing"].includes(t.status))
        .map((t) => t.id)
        .sort()
        .join(",")
    : "";

  useEffect(() => {
    if (followOutput && activeTaskIds) {
      const ids = activeTaskIds.split(",");
      setExpandedTasks((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
    }
  }, [followOutput, activeTaskIds]);

  function toggleTask(taskId: string) {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-base text-zinc-400">
        Loading plans...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-base text-zinc-100 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Plan Orchestrator</h1>
          {primaryProject && (
            <p className="text-xs text-zinc-500 mt-0.5 font-mono">{primaryProject.repo}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {selectedPlanId && <ConnectionDot connected={connected} />}
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors"
          >
            + New Plan
          </button>
        </div>
      </div>

      {/* Create plan modal */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-lg shadow-2xl">
            <h2 className="text-lg font-semibold text-zinc-200 mb-4">Create Plan</h2>
            <CreatePlanForm
              projects={projects}
              onCreated={(planId) => {
                setShowCreateForm(false);
                setSelectedPlanId(planId);
                fetchPlans();
              }}
              onCancel={() => setShowCreateForm(false)}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* ── Left sidebar: Plan list + locks ── */}
        <div className="lg:col-span-1 space-y-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
                Plans
              </h2>
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={cn(
                  "text-[10px] transition-colors",
                  showArchived ? "text-cyan-500" : "text-zinc-600 hover:text-zinc-400",
                )}
              >
                {showArchived ? "Hide archived" : "Show archived"}
              </button>
            </div>

            {plans.length === 0 ? (
              <p className="text-zinc-600 text-xs">
                No plans yet. Click{" "}
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="text-cyan-500 hover:text-cyan-400"
                >
                  + New Plan
                </button>{" "}
                to start.
              </p>
            ) : (
              <div className="space-y-2">
                {plans.map((plan) => (
                  <div
                    key={plan.id}
                    className={cn(
                      "rounded-lg border transition-all group",
                      plan.archived && "opacity-50",
                      selectedPlanId === plan.id
                        ? "bg-zinc-800/80 border-cyan-700/60"
                        : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700",
                    )}
                  >
                    <button
                      onClick={() => {
                        setSelectedPlanId(plan.id);
                        setActiveTab("lanes");
                      }}
                      className="w-full text-left p-3"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-xs font-medium text-zinc-200 leading-tight">
                          {plan.title}
                        </span>
                        <span className="text-[10px] text-zinc-500 ml-2 whitespace-nowrap">
                          {plan.progressPercent}%
                        </span>
                      </div>
                      <ProgressBar percent={plan.progressPercent} />
                      <div className="flex gap-2 mt-1.5 text-[10px] text-zinc-600">
                        <span className="text-green-500">{plan.complete}</span>
                        <span className="text-cyan-500">{plan.inProgress}</span>
                        <span>{plan.pending}</span>
                        {plan.failed > 0 && <span className="text-red-500">{plan.failed}</span>}
                      </div>
                    </button>
                    {/* Archive/unarchive button */}
                    <div className="px-3 pb-2">
                      {plan.archived ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); unarchivePlan(plan.id); }}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300"
                        >
                          Unarchive
                        </button>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); archivePlan(plan.id); }}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300"
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Containers */}
          {containers.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2 text-zinc-400 uppercase tracking-wider">
                Containers
                <span className="text-[10px] text-zinc-600 font-normal ml-2">{containers.length}</span>
              </h2>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {containers.map((c) => {
                  const alive = c.state === "running";
                  return (
                    <div
                      key={c.name}
                      className={cn(
                        "text-[10px] p-1.5 rounded border",
                        alive
                          ? "bg-cyan-950/10 border-cyan-800/30"
                          : "bg-zinc-900/50 border-zinc-800/50 opacity-60",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full flex-shrink-0",
                            alive ? "bg-green-400" : "bg-zinc-600",
                          )}
                        />
                        <span className="font-mono text-zinc-300 truncate">{c.name}</span>
                      </div>
                      <div className="flex justify-between mt-0.5 pl-3">
                        <span className={cn(
                          "truncate",
                          alive ? "text-cyan-500/70" : "text-zinc-600",
                        )}>
                          {c.status}
                        </span>
                        <span className="text-zinc-700 whitespace-nowrap ml-2">{c.uptime}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Git branches */}
          {branches.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2 text-zinc-400 uppercase tracking-wider">
                Branches
                <span className="text-[10px] text-zinc-600 font-normal ml-2">{branches.length}</span>
              </h2>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {branches.map((branch) => {
                  const isDefault = branch.name === defaultBranch;
                  const isFeat = branch.name.startsWith("feat/") || branch.name.startsWith("test/") || branch.name.startsWith("verify/");
                  return (
                    <div
                      key={branch.name}
                      className={cn(
                        "text-[10px] p-1.5 rounded border",
                        branch.isCurrent
                          ? "bg-cyan-950/20 border-cyan-800/40"
                          : "bg-zinc-900/50 border-zinc-800/50",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        {branch.isCurrent && (
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 flex-shrink-0" />
                        )}
                        <span
                          className={cn(
                            "font-mono truncate",
                            isDefault ? "text-green-400" : isFeat ? "text-cyan-400/80" : "text-zinc-400",
                          )}
                        >
                          {branch.name}
                        </span>
                      </div>
                      <div className="flex justify-between mt-0.5 pl-3">
                        <span className="text-zinc-600 truncate">{branch.lastCommitMessage}</span>
                        <span className="text-zinc-700 whitespace-nowrap ml-2">{branch.lastCommitAge}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Dev tools */}
          <div className="pt-2 border-t border-zinc-800/50">
            <button
              onClick={async () => {
                setRestartingWatchers(true);
                try {
                  const res = await fetch("/api/plans/restart-watchers", { method: "POST" });
                  const data = await res.json();
                  console.log("[restart-watchers]", data);
                } finally {
                  setRestartingWatchers(false);
                }
              }}
              disabled={restartingWatchers}
              className="w-full px-2.5 py-1.5 rounded text-[10px] font-medium text-amber-400 border border-amber-800/50 hover:bg-amber-900/30 transition-colors disabled:opacity-50"
            >
              {restartingWatchers ? "Restarting..." : "Restart Watchers"}
            </button>
            <p className="text-[9px] text-zinc-600 mt-1">
              Reload plan watchers with latest code
            </p>
          </div>
        </div>

        {/* ── Main content area ── */}
        <div className="lg:col-span-3">
          {planDetail && groups ? (
            <div className="space-y-4">
              {/* Plan header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-200">{planDetail.title}</h2>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    <span className="font-mono">{planDetail.id}</span>
                    {" \u00b7 "}
                    Updated <TimeAgo timestamp={planDetail.updatedAt} />
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {snapshot && <UsageBanner usage={snapshot.usage} />}
                  {/* Plan actions */}
                  {!isTerminal ? (
                    <button
                      onClick={() => cancelPlan(planDetail.id)}
                      className="px-2.5 py-1 rounded text-[10px] font-medium text-red-400 border border-red-800/50 hover:bg-red-900/30 transition-colors"
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={() => retryPlan(planDetail.id)}
                      className="px-2.5 py-1 rounded text-[10px] font-medium text-cyan-400 border border-cyan-800/50 hover:bg-cyan-900/30 transition-colors"
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>

              {/* Tab bar */}
              <div className="flex items-center gap-1 border-b border-zinc-800">
                <TabButton
                  active={activeTab === "lanes"}
                  onClick={() => setActiveTab("lanes")}
                  label="Agents"
                  count={planDetail.tasks.length}
                />
                <TabButton
                  active={activeTab === "log"}
                  onClick={() => setActiveTab("log")}
                  label="Event Log"
                  count={messages.length}
                />
                <TabButton
                  active={activeTab === "summary"}
                  onClick={() => setActiveTab("summary")}
                  label="Summary"
                />

                {/* Follow toggle (right-aligned) */}
                <div className="ml-auto flex items-center gap-2 pb-2">
                  <label className="flex items-center gap-1.5 text-[10px] text-zinc-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={followOutput}
                      onChange={(e) => setFollowOutput(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-800 text-cyan-500 focus:ring-cyan-500/30 w-3 h-3"
                    />
                    Stream output
                  </label>
                </div>
              </div>

              {/* Tab content */}
              {activeTab === "lanes" && (
                <div className="space-y-5">
                  {/* Active agents group */}
                  {groups.active.length > 0 && (
                    <TaskGroup
                      label="Active"
                      count={groups.active.length}
                      color="text-cyan-400"
                      dotColor="bg-cyan-400"
                    >
                      {groups.active.map((task) => (
                        <SwimLane
                          key={task.id}
                          task={task}
                          sessionUsage={
                            task.assignedTo && snapshot?.sessionUsage
                              ? snapshot.sessionUsage[task.assignedTo]
                              : undefined
                          }
                          latestActivity={latestActivityByTask.get(task.id)}
                          outputLines={outputLines}
                          expanded={expandedTasks.has(task.id)}
                          onToggle={() => toggleTask(task.id)}
                        />
                      ))}
                    </TaskGroup>
                  )}

                  {/* Waiting group */}
                  {groups.waiting.length > 0 && (
                    <TaskGroup
                      label="Waiting"
                      count={groups.waiting.length}
                      color="text-zinc-500"
                      dotColor="bg-zinc-500"
                    >
                      {groups.waiting.map((task) => (
                        <SwimLane
                          key={task.id}
                          task={task}
                          latestActivity={latestActivityByTask.get(task.id)}
                          outputLines={outputLines}
                          expanded={expandedTasks.has(task.id)}
                          onToggle={() => toggleTask(task.id)}
                        />
                      ))}
                    </TaskGroup>
                  )}

                  {/* Completed group */}
                  {groups.done.length > 0 && (
                    <TaskGroup
                      label="Finished"
                      count={groups.done.length}
                      color="text-zinc-600"
                      dotColor="bg-green-500"
                      defaultCollapsed
                    >
                      {groups.done.map((task) => (
                        <SwimLane
                          key={task.id}
                          task={task}
                          sessionUsage={
                            task.assignedTo && snapshot?.sessionUsage
                              ? snapshot.sessionUsage[task.assignedTo]
                              : undefined
                          }
                          latestActivity={latestActivityByTask.get(task.id)}
                          outputLines={outputLines}
                          expanded={expandedTasks.has(task.id)}
                          onToggle={() => toggleTask(task.id)}
                        />
                      ))}
                    </TaskGroup>
                  )}
                </div>
              )}

              {/* Live output console — shown when streaming is active */}
              {followOutput && outputLines.length > 0 && activeTab === "lanes" && (
                <div className="bg-zinc-950 rounded-lg border border-zinc-800 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-500">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse mr-1.5 align-middle" />
                      Live Output
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      {outputLines.length} lines
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-zinc-500 leading-relaxed max-h-48 overflow-y-auto">
                    {outputLines.slice(-30).map((line, i) => (
                      <div key={`${line.timestamp}-${i}`} className="truncate">
                        <span className="text-zinc-700 select-none">
                          {new Date(line.timestamp).toLocaleTimeString()}{" "}
                        </span>
                        <span className="text-cyan-600/60 select-none">
                          {line.sessionId.slice(-6)}{" "}
                        </span>
                        {line.line}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "log" && (
                <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
                  <TaskQueueLog messages={messages} />
                </div>
              )}

              {activeTab === "summary" && (
                <PlanSummaryPanel planId={planDetail.id} isTerminal={isTerminal} />
              )}

              {/* Terminal state banner */}
              {isTerminal && activeTab !== "summary" && (
                <div className="text-center py-3">
                  <button
                    onClick={() => setActiveTab("summary")}
                    className="text-xs text-cyan-500 hover:text-cyan-400 transition-colors"
                  >
                    Plan finished — view summary
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-600 text-sm gap-3">
              <span>Select a plan to view real-time progress</span>
              <button
                onClick={() => setShowCreateForm(true)}
                className="text-xs text-cyan-500 hover:text-cyan-400"
              >
                or create a new plan
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function TaskGroup({
  label,
  count,
  color,
  dotColor,
  defaultCollapsed = false,
  children,
}: {
  label: string;
  count: number;
  color: string;
  dotColor: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-2 group"
      >
        <span className={cn("w-2 h-2 rounded-full", dotColor)} />
        <span className={cn("text-xs font-semibold uppercase tracking-wider", color)}>
          {label}
        </span>
        <span className="text-[10px] text-zinc-600 font-mono">{count}</span>
        <svg
          className={cn(
            "w-3 h-3 text-zinc-600 transition-transform",
            collapsed && "-rotate-90",
          )}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {!collapsed && <div className="space-y-2">{children}</div>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
        active
          ? "border-cyan-500 text-cyan-400"
          : "border-transparent text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "ml-1.5 text-[10px] font-mono px-1 rounded",
            active ? "bg-cyan-500/20 text-cyan-400" : "bg-zinc-800 text-zinc-500",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
