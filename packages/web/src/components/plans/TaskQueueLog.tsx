"use client";

import { useEffect, useRef, memo } from "react";
import { cn } from "@/lib/cn";
import type { BusMessage } from "@/hooks/usePlanEvents";

const TYPE_STYLES: Record<string, { color: string; label: string }> = {
  TASK_COMPLETE: { color: "text-green-400", label: "COMPLETE" },
  TASK_FAILED: { color: "text-red-400", label: "FAILED" },
  STUCK: { color: "text-yellow-400", label: "STUCK" },
  PROGRESS_UPDATE: { color: "text-zinc-500", label: "HEARTBEAT" },
  ASSIGN_TASK: { color: "text-cyan-400", label: "ASSIGN" },
  ABORT: { color: "text-red-500", label: "ABORT" },
  UNSTICK: { color: "text-yellow-300", label: "UNSTICK" },
  CONTEXT_UPDATE: { color: "text-blue-400", label: "CONTEXT" },
  QUESTION: { color: "text-amber-400", label: "QUESTION" },
  FILE_LOCK_REQUEST: { color: "text-purple-400", label: "LOCK" },
  RUN_TESTS: { color: "text-purple-400", label: "TEST" },
  TEST_RESULT: { color: "text-purple-300", label: "RESULT" },
};

interface TaskQueueLogProps {
  messages: BusMessage[];
  maxVisible?: number;
}

export const TaskQueueLog = memo(function TaskQueueLog({
  messages,
  maxVisible = 100,
}: TaskQueueLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  const visible = messages.slice(-maxVisible);

  if (visible.length === 0) {
    return (
      <div className="text-zinc-600 text-xs text-center py-6">
        No messages yet. Events will appear as agents report progress.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="max-h-64 overflow-y-auto space-y-0.5">
      {visible.map((msg) => {
        const style = TYPE_STYLES[msg.type] ?? { color: "text-zinc-500", label: msg.type };
        const payload = msg.payload;
        const summary = (payload.summary as string)
          ?? (payload.error as string)
          ?? (payload.reason as string)
          ?? (payload.status as string)
          ?? "";

        return (
          <div
            key={msg.id}
            className="flex items-start gap-2 py-1 px-2 rounded hover:bg-zinc-800/30 transition-colors text-[11px]"
          >
            {/* Timestamp */}
            <span className="text-zinc-600 font-mono whitespace-nowrap flex-shrink-0">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>

            {/* Type badge */}
            <span
              className={cn(
                "font-semibold uppercase tracking-wider whitespace-nowrap flex-shrink-0 w-16 text-right",
                style.color,
              )}
            >
              {style.label}
            </span>

            {/* From */}
            <span className="text-zinc-600 font-mono flex-shrink-0 w-20 truncate">
              {msg.from}
            </span>

            {/* Summary */}
            <span className="text-zinc-400 truncate flex-1">{summary}</span>
          </div>
        );
      })}
    </div>
  );
});
