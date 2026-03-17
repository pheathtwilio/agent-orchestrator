"use client";

import { memo } from "react";
import { cn } from "@/lib/cn";
import type { PlanTask, SessionUsage, AgentOutputLine } from "@/hooks/usePlanEvents";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-zinc-600",
  assigned: "bg-yellow-500",
  in_progress: "bg-cyan-400",
  testing: "bg-purple-400",
  complete: "bg-green-400",
  failed: "bg-red-400",
  blocked: "bg-red-500",
};

const SKILL_BADGES: Record<string, { bg: string; text: string }> = {
  frontend: { bg: "bg-blue-500/20", text: "text-blue-400" },
  backend: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  fullstack: { bg: "bg-cyan-500/20", text: "text-cyan-400" },
  testing: { bg: "bg-purple-500/20", text: "text-purple-400" },
  security: { bg: "bg-orange-500/20", text: "text-orange-400" },
  devops: { bg: "bg-amber-500/20", text: "text-amber-400" },
  database: { bg: "bg-pink-500/20", text: "text-pink-400" },
};

interface SwimLaneProps {
  task: PlanTask;
  sessionUsage?: SessionUsage;
  latestActivity?: string;
  outputLines: AgentOutputLine[];
  expanded: boolean;
  onToggle: () => void;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const SwimLane = memo(function SwimLane({
  task,
  sessionUsage,
  latestActivity,
  outputLines,
  expanded,
  onToggle,
}: SwimLaneProps) {
  const skill = SKILL_BADGES[task.skill] ?? SKILL_BADGES.fullstack;
  const isActive = ["assigned", "in_progress", "testing"].includes(task.status);
  const isDone = task.status === "complete";
  const isFailed = task.status === "failed";

  const sessionLines = task.assignedTo
    ? outputLines.filter((l) => l.sessionId === task.assignedTo).slice(-8)
    : [];

  return (
    <div
      className={cn(
        "rounded-lg border transition-all duration-200",
        isActive && "border-cyan-800/60 bg-cyan-950/10",
        isDone && "border-green-800/40 bg-green-950/5",
        isFailed && "border-red-800/40 bg-red-950/10",
        !isActive && !isDone && !isFailed && "border-zinc-800 bg-zinc-900/50",
      )}
    >
      {/* Lane header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-zinc-800/30 transition-colors rounded-t-lg"
      >
        {/* Status dot */}
        <span
          className={cn(
            "w-2.5 h-2.5 rounded-full flex-shrink-0",
            STATUS_COLORS[task.status] ?? "bg-zinc-600",
            isActive && "animate-pulse",
          )}
        />

        {/* Skill badge */}
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0",
            skill.bg,
            skill.text,
          )}
        >
          {task.skill}
        </span>

        {/* Task title + description + activity */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-zinc-200 block truncate">{task.title}</span>
          {task.description && (
            <span className="text-[11px] text-zinc-500 block truncate">{task.description}</span>
          )}
          {isActive && latestActivity && (
            <span className="text-[10px] text-cyan-500/80 block truncate italic">{latestActivity}</span>
          )}
        </div>

        {/* Status label */}
        <span
          className={cn(
            "text-xs whitespace-nowrap flex-shrink-0",
            isActive ? "text-cyan-400 font-medium" : "text-zinc-500",
          )}
        >
          {isActive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse mr-1.5 align-middle" />
          )}
          {task.status.replace("_", " ")}
        </span>

        {/* Cost badge */}
        {sessionUsage && sessionUsage.costUsd > 0 && (
          <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap flex-shrink-0">
            {formatCost(sessionUsage.costUsd)}
          </span>
        )}

        {/* Output line count badge */}
        {sessionLines.length > 0 && (
          <span className="text-[10px] font-mono text-cyan-500/60 whitespace-nowrap flex-shrink-0">
            {sessionLines.length} lines
          </span>
        )}

        {/* Expand chevron */}
        <svg
          className={cn(
            "w-4 h-4 text-zinc-500 transition-transform flex-shrink-0",
            expanded && "rotate-180",
          )}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-800/50 p-3 space-y-3">
          {/* File boundary */}
          {task.fileBoundary && task.fileBoundary.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {task.fileBoundary.map((f) => (
                <span
                  key={f}
                  className="text-[10px] font-mono text-zinc-500 bg-zinc-800/60 px-1.5 py-0.5 rounded"
                >
                  {f}
                </span>
              ))}
            </div>
          )}

          {/* Metadata row */}
          <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
            <span>
              Model: <span className="text-zinc-400">{task.model}</span>
            </span>
            {task.assignedTo && (
              <span>
                Agent: <span className="text-zinc-400 font-mono">{task.assignedTo.slice(0, 12)}</span>
              </span>
            )}
            {task.branch && (
              <span>
                Branch: <span className="text-zinc-400 font-mono">{task.branch}</span>
              </span>
            )}
            {task.dependsOn.length > 0 && (
              <span>
                Deps: <span className="text-zinc-400">{task.dependsOn.join(", ")}</span>
              </span>
            )}
          </div>

          {/* Token usage */}
          {sessionUsage && (
            <div className="flex gap-4 text-[11px] font-mono text-zinc-500">
              <span>
                in: <span className="text-zinc-400">{formatTokens(sessionUsage.inputTokens)}</span>
              </span>
              <span>
                out: <span className="text-zinc-400">{formatTokens(sessionUsage.outputTokens)}</span>
              </span>
              <span>
                cache: <span className="text-zinc-400">{formatTokens(sessionUsage.cacheReadTokens)}</span>
              </span>
              <span>
                cost: <span className="text-cyan-400">{formatCost(sessionUsage.costUsd)}</span>
              </span>
            </div>
          )}

          {/* Live output */}
          {sessionLines.length > 0 && (
            <div className="bg-zinc-950 rounded border border-zinc-800/50 p-2 max-h-40 overflow-y-auto">
              <div className="font-mono text-[11px] text-zinc-500 leading-relaxed">
                {sessionLines.map((line, i) => (
                  <div key={`${line.timestamp}-${i}`} className="truncate">
                    <span className="text-zinc-600 select-none">
                      {new Date(line.timestamp).toLocaleTimeString()}{" "}
                    </span>
                    {line.line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
