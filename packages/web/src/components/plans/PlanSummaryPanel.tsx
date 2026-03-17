"use client";

import { useEffect, useState, useRef, memo } from "react";
import { cn } from "@/lib/cn";

interface PlanSummaryData {
  planId: string;
  title: string;
  outcome: "complete" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tasks: {
    id: string;
    title: string;
    status: string;
    skill: string;
    model: string;
    branch: string | null;
    durationMs: number | null;
  }[];
  totals: {
    total: number;
    complete: number;
    failed: number;
    pending: number;
  };
  branches: string[];
  prUrl: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  } | null;
}

interface PlanSummaryPanelProps {
  planId: string;
  isTerminal?: boolean;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const OUTCOME_STYLES = {
  complete: { bg: "bg-green-500/10", border: "border-green-700/50", text: "text-green-400", label: "Complete" },
  failed: { bg: "bg-red-500/10", border: "border-red-700/50", text: "text-red-400", label: "Failed" },
  cancelled: { bg: "bg-zinc-500/10", border: "border-zinc-700/50", text: "text-zinc-400", label: "Cancelled" },
};

export const PlanSummaryPanel = memo(function PlanSummaryPanel({ planId, isTerminal }: PlanSummaryPanelProps) {
  const [summary, setSummary] = useState<PlanSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function fetchSummary(refresh = false) {
      try {
        const url = `/api/plans/${planId}/summary${refresh ? "?refresh=true" : ""}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setSummary(data.summary ?? null);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    // Initial fetch (always refresh to get latest data)
    fetchSummary(true);

    // Poll every 10s while the plan is still running
    if (!isTerminal) {
      pollRef.current = setInterval(() => fetchSummary(true), 10_000);
    }

    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [planId, isTerminal]);

  // Re-fetch when plan becomes terminal
  useEffect(() => {
    if (isTerminal) {
      clearInterval(pollRef.current);
      fetch(`/api/plans/${planId}/summary?refresh=true`)
        .then((r) => r.json())
        .then((data) => setSummary(data.summary ?? null))
        .catch(() => {});
    }
  }, [isTerminal, planId]);

  if (loading) {
    return <div className="text-zinc-600 text-xs py-4 text-center">Loading summary...</div>;
  }

  if (!summary) {
    return <div className="text-zinc-600 text-xs py-4 text-center">Summary not available yet. It will appear once the plan completes.</div>;
  }

  const style = OUTCOME_STYLES[summary.outcome];

  return (
    <div className={cn("rounded-lg border p-4 space-y-4", style.bg, style.border)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">{summary.title}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {new Date(summary.startedAt).toLocaleString()} — {formatDuration(summary.durationMs)}
          </p>
        </div>
        <span className={cn("text-xs font-semibold uppercase tracking-wider", style.text)}>
          {style.label}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Tasks" value={String(summary.totals.total)} />
        <StatCard label="Complete" value={String(summary.totals.complete)} color="text-green-400" />
        <StatCard label="Failed" value={String(summary.totals.failed)} color="text-red-400" />
        <StatCard label="Duration" value={formatDuration(summary.durationMs)} />
      </div>

      {/* Token usage */}
      {summary.usage && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="Input" value={formatTokens(summary.usage.inputTokens)} />
          <StatCard label="Output" value={formatTokens(summary.usage.outputTokens)} />
          <StatCard label="Cache Read" value={formatTokens(summary.usage.cacheReadTokens)} />
          <StatCard label="Cache Write" value={formatTokens(summary.usage.cacheCreationTokens)} />
          <StatCard label="Total Cost" value={`$${summary.usage.costUsd.toFixed(4)}`} color="text-cyan-400" />
        </div>
      )}

      {/* Branches */}
      {summary.branches.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 mb-1">Branches</p>
          <div className="flex flex-wrap gap-1">
            {summary.branches.map((b) => (
              <span key={b} className="text-[10px] font-mono text-zinc-400 bg-zinc-800/60 px-1.5 py-0.5 rounded">
                {b}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* PR link */}
      {summary.prUrl && (
        <a
          href={summary.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          View Pull Request
        </a>
      )}
    </div>
  );
});

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-zinc-900/50 rounded p-2">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</p>
      <p className={cn("text-sm font-mono font-semibold mt-0.5", color ?? "text-zinc-300")}>{value}</p>
    </div>
  );
}
