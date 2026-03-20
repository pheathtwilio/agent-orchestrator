"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  WorkflowStep,
  ProgrammaticCondition,
  StepCondition,
} from "@/lib/workflow-types";
import { cn } from "@/lib/cn";

interface WorkflowStepEditPanelProps {
  workflowId: string;
  stepId: string;
  step: WorkflowStep;
  onUpdate: (step: WorkflowStep) => void;
  onClose: () => void;
}

const PROGRAMMATIC_CONDITIONS: ProgrammaticCondition[] = [
  "all_tasks_complete",
  "tests_pass",
  "no_failures",
  "pr_created",
];

const FAILURE_ACTIONS = [
  { value: "spawn_doctor", label: "Spawn Doctor" },
  { value: "retry", label: "Retry" },
  { value: "fail_plan", label: "Fail Plan" },
  { value: "skip", label: "Skip" },
  { value: "notify", label: "Notify" },
];

const SKILLS = [
  "developer",
  "frontend",
  "backend",
  "fullstack",
  "testing",
  "security",
  "devops",
  "database",
  "doctor",
];

const MODEL_TIERS = ["primary", "testing", "opus", "sonnet", "haiku"];

const CONDITION_TYPES = [
  { value: "previous_step_had_failures", label: "Previous Step Had Failures" },
  { value: "previous_step_all_passed", label: "Previous Step All Passed" },
  { value: "step_result_contains", label: "Step Result Contains" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
];

export function WorkflowStepEditPanel({
  workflowId,
  stepId,
  step,
  onUpdate,
  onClose,
}: WorkflowStepEditPanelProps) {
  const [localStep, setLocalStep] = useState<WorkflowStep>(step);
  const [saving, setSaving] = useState(false);
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setLocalStep(step);
  }, [step]);

  const saveStep = useCallback(
    async (updatedStep: WorkflowStep) => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/admin/workflows/${workflowId}/steps/${stepId}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updatedStep),
          }
        );

        if (res.ok) {
          const data = await res.json();
          onUpdate(data.step);
        }
      } catch (err) {
        console.error("Failed to save step:", err);
      } finally {
        setSaving(false);
      }
    },
    [workflowId, stepId, onUpdate]
  );

  const debouncedSave = useCallback(
    (updatedStep: WorkflowStep) => {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }

      const timeout = setTimeout(() => {
        saveStep(updatedStep);
      }, 300);

      setSaveTimeout(timeout);
    },
    [saveTimeout, saveStep]
  );

  const handleFieldChange = (
    field: keyof WorkflowStep,
    value: any
  ) => {
    const updatedStep = { ...localStep, [field]: value };
    setLocalStep(updatedStep);
    debouncedSave(updatedStep);
  };

  const handleNestedFieldChange = (
    parentField: keyof WorkflowStep,
    childField: string,
    value: any
  ) => {
    const updatedStep = {
      ...localStep,
      [parentField]: {
        ...(localStep[parentField] as any),
        [childField]: value,
      },
    };
    setLocalStep(updatedStep);
    debouncedSave(updatedStep);
  };

  const handleProgrammaticConditionToggle = (
    condition: ProgrammaticCondition
  ) => {
    const current = localStep.exit_criteria.programmatic;
    const updated = current.includes(condition)
      ? current.filter((c) => c !== condition)
      : [...current, condition];

    handleNestedFieldChange("exit_criteria", "programmatic", updated);
  };

  const handleConditionChange = (conditionData: Partial<StepCondition>) => {
    const updatedCondition: StepCondition = {
      type: conditionData.type || "always",
      ...(conditionData.type === "step_result_contains"
        ? {
            stepIndex: (conditionData as any).stepIndex || 0,
            match: (conditionData as any).match || "",
          }
        : {}),
    } as StepCondition;

    handleFieldChange("condition", updatedCondition);
  };

  const formatConditionLabel = (condition: ProgrammaticCondition): string => {
    return condition
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  return (
    <div className="w-[400px] bg-zinc-900 border-l border-zinc-700 flex flex-col h-screen overflow-y-auto flex-shrink-0">
      {/* Header */}
      <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 p-4 flex items-center justify-between z-10">
        <h3 className="text-lg font-semibold text-zinc-100">Edit Step</h3>
        <button
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-100 transition-colors"
          aria-label="Close"
        >
          <svg
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Form */}
      <div className="p-4 space-y-6">
        {/* Name */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-1">
            Name
          </label>
          <input
            type="text"
            value={localStep.name}
            onChange={(e) => handleFieldChange("name", e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-1">
            Description
          </label>
          <textarea
            value={localStep.description}
            onChange={(e) => handleFieldChange("description", e.target.value)}
            rows={4}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors resize-none"
          />
        </div>

        {/* Exit Criteria */}
        <div className="border-t border-zinc-800 pt-4">
          <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-3">
            Exit Criteria
          </label>

          <div className="space-y-2 mb-3">
            <p className="text-xs text-zinc-500 mb-2">Programmatic Conditions</p>
            {PROGRAMMATIC_CONDITIONS.map((condition) => (
              <label
                key={condition}
                className="flex items-center gap-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={localStep.exit_criteria.programmatic.includes(
                    condition
                  )}
                  onChange={() => handleProgrammaticConditionToggle(condition)}
                  className="w-4 h-4 rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 accent-cyan-500 bg-zinc-800"
                />
                <span className="text-sm text-zinc-300">
                  {formatConditionLabel(condition)}
                </span>
              </label>
            ))}
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Description
            </label>
            <textarea
              value={localStep.exit_criteria.description}
              onChange={(e) =>
                handleNestedFieldChange(
                  "exit_criteria",
                  "description",
                  e.target.value
                )
              }
              rows={3}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors resize-none"
            />
          </div>
        </div>

        {/* Failure Policy */}
        <div className="border-t border-zinc-800 pt-4">
          <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-3">
            Failure Policy
          </label>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Action</label>
              <select
                value={localStep.failure_policy.action}
                onChange={(e) =>
                  handleNestedFieldChange(
                    "failure_policy",
                    "action",
                    e.target.value
                  )
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
              >
                {FAILURE_ACTIONS.map((action) => (
                  <option key={action.value} value={action.value}>
                    {action.label}
                  </option>
                ))}
              </select>
            </div>

            {(localStep.failure_policy.action === "spawn_doctor" ||
              localStep.failure_policy.action === "retry") && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Max Retries
                </label>
                <input
                  type="number"
                  min="0"
                  value={localStep.failure_policy.max_retries || 0}
                  onChange={(e) =>
                    handleNestedFieldChange(
                      "failure_policy",
                      "max_retries",
                      parseInt(e.target.value, 10)
                    )
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Description
              </label>
              <textarea
                value={localStep.failure_policy.description}
                onChange={(e) =>
                  handleNestedFieldChange(
                    "failure_policy",
                    "description",
                    e.target.value
                  )
                }
                rows={3}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors resize-none"
              />
            </div>
          </div>
        </div>

        {/* Agent Config */}
        <div className="border-t border-zinc-800 pt-4">
          <label className="block text-xs text-zinc-400 uppercase tracking-wide mb-3">
            Agent Config
          </label>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Skill</label>
              <select
                value={localStep.agent_config.skill}
                onChange={(e) =>
                  handleNestedFieldChange("agent_config", "skill", e.target.value)
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
              >
                {SKILLS.map((skill) => (
                  <option key={skill} value={skill}>
                    {skill.charAt(0).toUpperCase() + skill.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Model Tier
              </label>
              <select
                value={localStep.agent_config.model_tier}
                onChange={(e) =>
                  handleNestedFieldChange(
                    "agent_config",
                    "model_tier",
                    e.target.value
                  )
                }
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
              >
                {MODEL_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier.charAt(0).toUpperCase() + tier.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Docker Image (optional)
              </label>
              <input
                type="text"
                value={localStep.agent_config.docker_image || ""}
                onChange={(e) =>
                  handleNestedFieldChange(
                    "agent_config",
                    "docker_image",
                    e.target.value
                  )
                }
                placeholder="e.g., node:20-alpine"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors placeholder-zinc-600"
              />
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localStep.agent_config.per_task_testing || false}
                  onChange={(e) =>
                    handleNestedFieldChange(
                      "agent_config",
                      "per_task_testing",
                      e.target.checked
                    )
                  }
                  className="w-4 h-4 rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 accent-cyan-500 bg-zinc-800"
                />
                <span className="text-sm text-zinc-300">Per-task Testing</span>
              </label>
            </div>
          </div>
        </div>

        {/* Conditional */}
        <div className="border-t border-zinc-800 pt-4">
          <label className="flex items-center gap-2 cursor-pointer mb-3">
            <input
              type="checkbox"
              checked={localStep.is_conditional}
              onChange={(e) =>
                handleFieldChange("is_conditional", e.target.checked)
              }
              className="w-4 h-4 rounded border-zinc-700 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 accent-cyan-500 bg-zinc-800"
            />
            <span className="text-xs text-zinc-400 uppercase tracking-wide">
              Conditional Step
            </span>
          </label>

          {localStep.is_conditional && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Condition Type
                </label>
                <select
                  value={localStep.condition?.type || "always"}
                  onChange={(e) =>
                    handleConditionChange({ type: e.target.value as any })
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
                >
                  {CONDITION_TYPES.map((condType) => (
                    <option key={condType.value} value={condType.value}>
                      {condType.label}
                    </option>
                  ))}
                </select>
              </div>

              {localStep.condition?.type === "step_result_contains" && (
                <>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">
                      Step Index
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={
                        (localStep.condition as any).stepIndex || 0
                      }
                      onChange={(e) =>
                        handleConditionChange({
                          type: "step_result_contains",
                          stepIndex: parseInt(e.target.value, 10),
                          match: (localStep.condition as any).match || "",
                        })
                      }
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">
                      Match Text
                    </label>
                    <input
                      type="text"
                      value={(localStep.condition as any).match || ""}
                      onChange={(e) =>
                        handleConditionChange({
                          type: "step_result_contains",
                          stepIndex: (localStep.condition as any).stepIndex || 0,
                          match: e.target.value,
                        })
                      }
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Save indicator */}
        {saving && (
          <div className="text-xs text-cyan-400 text-center py-2">
            Saving...
          </div>
        )}
      </div>
    </div>
  );
}
