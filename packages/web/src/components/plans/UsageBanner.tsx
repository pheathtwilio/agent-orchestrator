"use client";

import { memo } from "react";
import type { UsageTotals } from "@/hooks/usePlanEvents";

interface UsageBannerProps {
  usage: UsageTotals;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const UsageBanner = memo(function UsageBanner({ usage }: UsageBannerProps) {
  const hasData = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (!hasData) return null;

  return (
    <div className="flex items-center gap-4 text-[11px] font-mono text-zinc-500">
      <span>
        tokens: <span className="text-zinc-400">{fmt(usage.inputTokens + usage.outputTokens)}</span>
      </span>
      <span>
        cache: <span className="text-zinc-400">{fmt(usage.cacheReadTokens)}</span>
      </span>
      <span>
        cost: <span className="text-cyan-400">${usage.costUsd.toFixed(4)}</span>
      </span>
    </div>
  );
});
