"use client";

import { cn } from "@/lib/cn";
import type { WorkflowStep } from "@/lib/workflow-types";

interface WorkflowStepNodeProps {
  step: WorkflowStep;
  selected: boolean;
  onClick: () => void;
  onDelete: (stepId: string) => void;
}

export function WorkflowStepNode({
  step,
  selected,
  onClick,
  onDelete,
}: WorkflowStepNodeProps) {
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete step "${step.name}"?`)) {
      onDelete(step.id);
    }
  };

  const failurePolicyColors = {
    spawn_doctor: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    fail_plan: "bg-red-500/20 text-red-400 border-red-500/30",
    retry: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    skip: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    notify: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  };

  const policyColor =
    failurePolicyColors[step.failure_policy.action] ||
    failurePolicyColors.skip;

  return (
    <div
      onClick={onClick}
      className={cn(
        "relative w-[200px] rounded-lg p-4 cursor-pointer transition-all bg-zinc-900",
        step.is_conditional
          ? "border-2 border-dashed"
          : "border-2 border-solid",
        selected ? "border-cyan-500" : "border-zinc-700 hover:border-zinc-600"
      )}
    >
      {/* Delete button */}
      <button
        onClick={handleDelete}
        className="absolute top-2 right-2 w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-red-400 hover:bg-red-900/20 transition-colors text-xs"
        aria-label="Delete step"
      >
        ×
      </button>

      {/* Step name */}
      <h3 className="text-sm font-bold text-zinc-100 mb-2 pr-4 truncate">
        {step.name}
      </h3>

      {/* Description preview */}
      <p className="text-xs text-zinc-400 mb-3 line-clamp-2 leading-relaxed">
        {step.description}
      </p>

      {/* Failure policy badge */}
      <div
        className={cn(
          "inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border",
          policyColor
        )}
      >
        {step.failure_policy.action.replace("_", " ")}
      </div>
    </div>
  );
}
