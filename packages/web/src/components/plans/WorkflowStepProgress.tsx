import { cn } from "@/lib/cn";

interface WorkflowStep {
  name: string;
}

interface WorkflowStepProgressProps {
  steps: WorkflowStep[];
  currentStepIndex: number;
}

export function WorkflowStepProgress({ steps, currentStepIndex }: WorkflowStepProgressProps) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, index) => {
        const isCompleted = index < currentStepIndex;
        const isCurrent = index === currentStepIndex;
        const isFuture = index > currentStepIndex;

        return (
          <div key={index} className="flex items-center gap-1">
            {/* Step pill */}
            <div
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium border transition-all",
                isCompleted && "bg-green-600/20 text-green-400 border-green-600/30",
                isCurrent && "bg-cyan-600/20 text-cyan-400 border-cyan-500 animate-pulse",
                isFuture && "bg-zinc-800 text-zinc-500 border-zinc-700",
              )}
            >
              {step.name}
            </div>
            {/* Connector line (don't show after last step) */}
            {index < steps.length - 1 && (
              <div className="w-4 border-t border-zinc-700" />
            )}
          </div>
        );
      })}
    </div>
  );
}
