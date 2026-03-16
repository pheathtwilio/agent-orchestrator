"use client";

import { useEffect, useState, useCallback } from "react";

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

interface TaskNode {
  id: string;
  title: string;
  description: string;
  status: string;
  skill: string;
  model: string;
  assignedTo: string | null;
  branch: string | null;
  dependsOn: string[];
  fileBoundary: string[];
}

interface PlanDetail {
  id: string;
  featureId: string;
  title: string;
  nodes: TaskNode[];
  createdAt: number;
  updatedAt: number;
}

interface FileLock {
  filePath: string;
  owner: string;
  acquiredAt: number;
  ageMs: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "text-zinc-500",
  assigned: "text-yellow-400",
  in_progress: "text-cyan-400",
  testing: "text-purple-400",
  complete: "text-green-400",
  failed: "text-red-400",
  blocked: "text-red-500",
};

const STATUS_DOTS: Record<string, string> = {
  pending: "bg-zinc-500",
  in_progress: "bg-cyan-400",
  complete: "bg-green-400",
  failed: "bg-red-400",
  testing: "bg-purple-400",
};

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full bg-zinc-800 rounded-full h-2">
      <div
        className="bg-green-500 h-2 rounded-full transition-all duration-500"
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

export function PlansDashboard() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanDetail | null>(null);
  const [locks, setLocks] = useState<FileLock[]>([]);
  const [deadlocks, setDeadlocks] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/plans");
      const data = await res.json();
      setPlans(data.plans ?? []);
    } catch {
      // Retry on next poll
    }
    setLoading(false);
  }, []);

  const fetchPlanDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/plans/${id}`);
      const data = await res.json();
      setSelectedPlan(data.plan ?? null);
    } catch {
      // Retry on next poll
    }
  }, []);

  const fetchLocks = useCallback(async () => {
    try {
      const res = await fetch("/api/plans/locks");
      const data = await res.json();
      setLocks(data.locks ?? []);
      setDeadlocks(data.deadlocks ?? []);
    } catch {
      // Retry on next poll
    }
  }, []);

  useEffect(() => {
    fetchPlans();
    fetchLocks();
    const interval = setInterval(() => {
      fetchPlans();
      fetchLocks();
      if (selectedPlan) fetchPlanDetail(selectedPlan.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchPlans, fetchLocks, fetchPlanDetail, selectedPlan]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-400">
        Loading plans...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <h1 className="text-2xl font-bold mb-6">Plan Orchestrator</h1>

      {/* Deadlock warning */}
      {deadlocks.length > 0 && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6">
          <h3 className="text-red-400 font-semibold mb-2">Deadlocks Detected</h3>
          {deadlocks.map((cycle, i) => (
            <p key={i} className="text-red-300 text-sm">
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Plan list */}
        <div className="lg:col-span-1">
          <h2 className="text-lg font-semibold mb-3 text-zinc-300">Active Plans</h2>
          {plans.length === 0 ? (
            <p className="text-zinc-500 text-sm">No active plans. Use <code className="bg-zinc-800 px-1 rounded">ao plan create</code> to start.</p>
          ) : (
            <div className="space-y-3">
              {plans.map((plan) => (
                <button
                  key={plan.id}
                  onClick={() => fetchPlanDetail(plan.id)}
                  className={`w-full text-left p-4 rounded-lg border transition-colors ${
                    selectedPlan?.id === plan.id
                      ? "bg-zinc-800 border-cyan-600"
                      : "bg-zinc-900 border-zinc-800 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-medium text-sm">{plan.title}</span>
                    <span className="text-xs text-zinc-500">{plan.progressPercent}%</span>
                  </div>
                  <ProgressBar percent={plan.progressPercent} />
                  <div className="flex gap-3 mt-2 text-xs text-zinc-500">
                    <span className="text-green-400">{plan.complete} done</span>
                    <span className="text-cyan-400">{plan.inProgress} active</span>
                    <span>{plan.pending} pending</span>
                    {plan.failed > 0 && <span className="text-red-400">{plan.failed} failed</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* File locks */}
          {locks.length > 0 && (
            <div className="mt-6">
              <h2 className="text-lg font-semibold mb-3 text-zinc-300">File Locks</h2>
              <div className="space-y-1">
                {locks.map((lock) => (
                  <div key={lock.filePath} className="flex justify-between text-xs p-2 bg-zinc-900 rounded">
                    <span className="text-zinc-300 truncate">{lock.filePath}</span>
                    <span className="text-zinc-500 ml-2 whitespace-nowrap">
                      {lock.owner} · {Math.round(lock.ageMs / 1000)}s
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Plan detail */}
        <div className="lg:col-span-2">
          {selectedPlan ? (
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-zinc-300">{selectedPlan.title}</h2>
                <span className="text-xs text-zinc-500">
                  Updated <TimeAgo timestamp={selectedPlan.updatedAt} />
                </span>
              </div>

              {/* Task table */}
              <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500 text-xs">
                      <th className="text-left p-3">ID</th>
                      <th className="text-left p-3">Status</th>
                      <th className="text-left p-3">Skill</th>
                      <th className="text-left p-3">Title</th>
                      <th className="text-left p-3">Agent</th>
                      <th className="text-left p-3">Deps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPlan.nodes.map((node) => (
                      <tr key={node.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                        <td className="p-3 font-mono text-xs text-zinc-400">{node.id}</td>
                        <td className="p-3">
                          <span className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[node.status] ?? "bg-zinc-600"}`} />
                            <span className={`text-xs ${STATUS_COLORS[node.status] ?? "text-zinc-400"}`}>
                              {node.status}
                            </span>
                          </span>
                        </td>
                        <td className="p-3 text-xs text-zinc-400">{node.skill ?? "—"}</td>
                        <td className="p-3 text-zinc-200">{node.title}</td>
                        <td className="p-3 text-xs text-zinc-500 font-mono">{node.assignedTo ?? "—"}</td>
                        <td className="p-3 text-xs text-zinc-600">
                          {node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-64 text-zinc-600">
              Select a plan to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
