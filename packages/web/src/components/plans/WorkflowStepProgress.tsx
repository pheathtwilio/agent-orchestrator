import { cn } from "@/lib/cn";

interface WorkflowStep {
  name: string;
}

interface WorkflowStepProgressProps {
  steps: WorkflowStep[];
  currentStepIndex: number;
  enginePhase?: string | null;
}

export function WorkflowStepProgress({ steps, currentStepIndex, enginePhase }: WorkflowStepProgressProps) {
  if (!steps || steps.length === 0) return null;

  // Decomposing is a mandatory first phase — always prepend it for engine-managed plans
  const isEnginePlan = !!enginePhase;
  const allSteps: WorkflowStep[] = isEnginePlan
    ? [{ name: "Decomposing" }, ...steps]
    : steps;

  // Determine which step is active based on engine phase
  const getStepState = (index: number) => {
    if (isEnginePlan) {
      if (index === 0) {
        // Decomposing step
        if (enginePhase === "decomposing") return "current";
        if (enginePhase === "created") return "future";
        return "completed"; // Any phase past decomposing
      }
      // Workflow steps (shifted by 1 due to prepended Decomposing)
      const realIndex = index - 1;
      if (enginePhase === "decomposing" || enginePhase === "created" || enginePhase === "reviewing") {
        return "future";
      }
      if (realIndex < currentStepIndex) return "completed";
      if (realIndex === currentStepIndex) return "current";
      return "future";
    }
    // Non-engine plans
    if (index < currentStepIndex) return "completed";
    if (index === currentStepIndex) return "current";
    return "future";
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {allSteps.map((step, index) => {
        const state = getStepState(index);

        return (
          <div key={index} className="flex items-center gap-1">
            {/* Step pill */}
            <div
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium border transition-all",
                state === "completed" && "bg-green-600/20 text-green-400 border-green-600/30",
                state === "current" && "bg-cyan-600/20 text-cyan-400 border-cyan-500 animate-pulse",
                state === "future" && "bg-zinc-800 text-zinc-500 border-zinc-700",
              )}
            >
              {step.name}
            </div>
            {/* Connector line (don't show after last step) */}
            {index < allSteps.length - 1 && (
              <div className="w-4 border-t border-zinc-700" />
            )}
          </div>
        );
      })}
    </div>
  );
}
