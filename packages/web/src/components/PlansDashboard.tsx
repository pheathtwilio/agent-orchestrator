"use client";

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/cn";
import { usePlanEvents } from "@/hooks/usePlanEvents";
import { SwimLane } from "./plans/SwimLane";
import { TaskQueueLog } from "./plans/TaskQueueLog";
import { PlanSummaryPanel } from "./plans/PlanSummaryPanel";
import { UsageBanner } from "./plans/UsageBanner";

// ── Types ──

interface PlanSummary {
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
}

interface FileLock {
  filePath: string;
  owner: string;
  acquiredAt: number;
  ageMs: number;
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

// ── Main Component ──

export function PlansDashboard() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [locks, setLocks] = useState<FileLock[]>([]);
  const [deadlocks, setDeadlocks] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [followOutput, setFollowOutput] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"lanes" | "log" | "summary">("lanes");

  // SSE connection for the selected plan
  const { snapshot, messages, outputLines, connected } = usePlanEvents(
    selectedPlanId,
    followOutput,
  );

  // Fetch plan list (still polled since it's a lightweight list endpoint)
  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/plans");
      const data = await res.json();
      setPlans(data.plans ?? []);
    } catch {
      // Retry next poll
    }
    setLoading(false);
  }, []);

  const fetchLocks = useCallback(async () => {
    try {
      const res = await fetch("/api/plans/locks");
      const data = await res.json();
      setLocks(data.locks ?? []);
      setDeadlocks(data.deadlocks ?? []);
    } catch {
      // Retry next poll
    }
  }, []);

  useEffect(() => {
    fetchPlans();
    fetchLocks();
    const interval = setInterval(() => {
      fetchPlans();
      fetchLocks();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchPlans, fetchLocks]);

  // Derive plan detail from SSE snapshot when available
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

  // Determine if plan is in a terminal state
  const isTerminal = planDetail
    ? planDetail.tasks.every((t) => ["complete", "failed"].includes(t.status))
    : false;

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
        <h1 className="text-2xl font-bold">Plan Orchestrator</h1>
        {selectedPlanId && <ConnectionDot connected={connected} />}
      </div>

      {/* Deadlock warning */}
      {deadlocks.length > 0 && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
          <h3 className="text-red-400 font-semibold mb-2">Deadlocks Detected</h3>
          {deadlocks.map((cycle, i) => (
            <p key={i} className="text-red-300 text-sm">
              {cycle.join(" \u2192 ")} \u2192 {cycle[0]}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* ── Left sidebar: Plan list + locks ── */}
        <div className="lg:col-span-1 space-y-6">
          <div>
            <h2 className="text-sm font-semibold mb-3 text-zinc-400 uppercase tracking-wider">
              Plans
            </h2>
            {plans.length === 0 ? (
              <p className="text-zinc-600 text-xs">
                No active plans. Use{" "}
                <code className="bg-zinc-800 px-1 rounded text-zinc-400">ao plan create</code> to
                start.
              </p>
            ) : (
              <div className="space-y-2">
                {plans.map((plan) => (
                  <button
                    key={plan.id}
                    onClick={() => {
                      setSelectedPlanId(plan.id);
                      setActiveTab("lanes");
                    }}
                    className={cn(
                      "w-full text-left p-3 rounded-lg border transition-all",
                      selectedPlanId === plan.id
                        ? "bg-zinc-800/80 border-cyan-700/60"
                        : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700",
                    )}
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
                ))}
              </div>
            )}
          </div>

          {/* File locks */}
          {locks.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2 text-zinc-400 uppercase tracking-wider">
                File Locks
              </h2>
              <div className="space-y-1">
                {locks.map((lock) => (
                  <div
                    key={lock.filePath}
                    className="flex justify-between text-[10px] p-1.5 bg-zinc-900/50 rounded border border-zinc-800/50"
                  >
                    <span className="text-zinc-400 truncate">{lock.filePath}</span>
                    <span className="text-zinc-600 ml-2 whitespace-nowrap">
                      {Math.round(lock.ageMs / 1000)}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Main content area ── */}
        <div className="lg:col-span-3">
          {planDetail ? (
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
                {snapshot && <UsageBanner usage={snapshot.usage} />}
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
                <div className="space-y-2">
                  {planDetail.tasks.map((task) => (
                    <SwimLane
                      key={task.id}
                      task={task}
                      sessionUsage={
                        task.assignedTo && snapshot?.sessionUsage
                          ? snapshot.sessionUsage[task.assignedTo]
                          : undefined
                      }
                      outputLines={outputLines}
                      expanded={expandedTasks.has(task.id)}
                      onToggle={() => toggleTask(task.id)}
                    />
                  ))}
                </div>
              )}

              {activeTab === "log" && (
                <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
                  <TaskQueueLog messages={messages} />
                </div>
              )}

              {activeTab === "summary" && (
                <PlanSummaryPanel planId={planDetail.id} />
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
            <div className="flex items-center justify-center h-64 text-zinc-600 text-sm">
              Select a plan to view real-time progress
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tab Button ──

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
