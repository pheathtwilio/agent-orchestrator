"use client";

import {
  useEffect,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { WorkflowStepNode } from "./WorkflowStepNode";
import type { WorkflowStep } from "@/lib/workflow-types";

interface WorkflowPipelineEditorProps {
  workflowId: string;
  onStepSelect: (stepId: string | null) => void;
}

interface WorkflowVersion {
  id: string;
  version: number;
  created_at: number;
}

export const WorkflowPipelineEditor = forwardRef<
  { refreshSteps: () => void; refreshStepsKeepSelection: () => void },
  WorkflowPipelineEditorProps
>(({ workflowId, onStepSelect }, ref) => {
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [workflowName, setWorkflowName] = useState<string>("");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  const fetchSteps = useCallback(async () => {
    setLoading(true);
    setSelectedStepId(null);
    setPublishedVersion(null);
    onStepSelect(null);

    try {
      const [stepsRes, workflowRes] = await Promise.all([
        fetch(`/api/admin/workflows/${workflowId}/steps`),
        fetch(`/api/admin/workflows/${workflowId}`),
      ]);

      if (stepsRes.ok) {
        const data = await stepsRes.json();
        const sortedSteps = (data.steps || []).sort(
          (a: WorkflowStep, b: WorkflowStep) => a.sort_order - b.sort_order
        );
        setSteps(sortedSteps);
      }

      if (workflowRes.ok) {
        const data = await workflowRes.json();
        setWorkflowName(data.workflow?.name || "Workflow");
      }
    } catch (err) {
      console.error("Failed to fetch workflow steps:", err);
    } finally {
      setLoading(false);
    }
  }, [workflowId, onStepSelect]);

  const fetchVersions = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}/versions`);
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions || []);
      }
    } catch (err) {
      console.error("Failed to fetch versions:", err);
    }
  }, [workflowId]);

  useEffect(() => {
    fetchSteps();
    fetchVersions();
  }, [fetchSteps, fetchVersions]);

  const refreshStepsKeepSelection = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}/steps`);
      if (res.ok) {
        const data = await res.json();
        const sortedSteps = (data.steps || []).sort(
          (a: WorkflowStep, b: WorkflowStep) => a.sort_order - b.sort_order
        );
        setSteps(sortedSteps);
      }
    } catch (err) {
      console.error("Failed to refresh steps:", err);
    }
  }, [workflowId]);

  // Expose refresh methods to parent
  useImperativeHandle(ref, () => ({
    refreshSteps: fetchSteps,
    refreshStepsKeepSelection,
  }));

  const handleStepClick = (stepId: string) => {
    setSelectedStepId(stepId);
    onStepSelect(stepId);
  };

  const handleMoveStep = async (stepId: string, direction: "left" | "right") => {
    const index = steps.findIndex((s) => s.id === stepId);
    if (index < 0) return;
    const swapIndex = direction === "left" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= steps.length) return;

    const newOrder = steps.map((s) => s.id);
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];

    // Optimistic update
    const reordered = [...steps];
    [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
    reordered.forEach((s, i) => (s.sort_order = i));
    setSteps(reordered);

    try {
      await fetch(`/api/admin/workflows/${workflowId}/steps/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIds: newOrder }),
      });
    } catch (err) {
      console.error("Failed to reorder steps:", err);
      fetchSteps(); // Rollback on failure
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/steps/${stepId}`,
        {
          method: "DELETE",
        }
      );

      if (res.ok) {
        setSteps((prev) => prev.filter((s) => s.id !== stepId));
        if (selectedStepId === stepId) {
          setSelectedStepId(null);
          onStepSelect(null);
        }
      }
    } catch (err) {
      console.error("Failed to delete step:", err);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    setPublishedVersion(null);

    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}/publish`, {
        method: "POST",
      });

      if (res.ok) {
        const data = await res.json();
        setPublishedVersion(data.version);
        setTimeout(() => setPublishedVersion(null), 3000);
        fetchVersions(); // Refresh version list
      }
    } catch (err) {
      console.error("Failed to publish workflow:", err);
    } finally {
      setPublishing(false);
    }
  };

  const handleRestoreVersion = async (version: number) => {
    setRestoringVersion(version);

    try {
      const res = await fetch(
        `/api/admin/workflows/${workflowId}/versions/${version}/restore`,
        {
          method: "POST",
        }
      );

      if (res.ok) {
        await fetchSteps(); // Refresh steps after restore
        setShowVersions(false);
      }
    } catch (err) {
      console.error("Failed to restore version:", err);
    } finally {
      setRestoringVersion(null);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        Loading workflow...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-zinc-800">
        <h2 className="text-xl font-bold text-zinc-100">{workflowName}</h2>
        <div className="flex items-center gap-3">
          {publishedVersion !== null && (
            <span className="text-xs text-green-400 animate-fade-in">
              Published v{publishedVersion}
            </span>
          )}

          {/* Version History Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowVersions(!showVersions)}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors border border-zinc-700"
            >
              Version History
            </button>

            {showVersions && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowVersions(false)}
                />
                <div className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 max-h-96 overflow-y-auto">
                  {versions.length === 0 ? (
                    <div className="p-4 text-xs text-zinc-500 text-center">
                      No versions published yet
                    </div>
                  ) : (
                    <div className="p-2">
                      {versions.map((version) => (
                        <div
                          key={version.id}
                          className="flex items-center justify-between p-3 hover:bg-zinc-800 rounded-md transition-colors"
                        >
                          <div className="flex-1">
                            <div className="text-sm font-medium text-zinc-200">
                              Version {version.version}
                            </div>
                            <div className="text-xs text-zinc-500">
                              {formatDate(version.created_at)}
                            </div>
                          </div>
                          <button
                            onClick={() => handleRestoreVersion(version.version)}
                            disabled={restoringVersion === version.version}
                            className="px-3 py-1 rounded text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {restoringVersion === version.version
                              ? "Restoring..."
                              : "Restore"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Publish Button */}
          <button
            onClick={handlePublish}
            disabled={publishing || steps.length === 0}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {publishing ? "Publishing..." : "Publish"}
          </button>
        </div>
      </div>

      {/* Pipeline canvas */}
      <div className="flex-1 overflow-x-auto">
        {steps.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-zinc-600 text-sm">
            No steps yet. Click + to add a step.
          </div>
        ) : (
          <div className="flex items-center gap-4 p-4 min-w-max">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center gap-4">
                <WorkflowStepNode
                  step={step}
                  selected={selectedStepId === step.id}
                  isFirst={index === 0}
                  isLast={index === steps.length - 1}
                  onClick={() => handleStepClick(step.id)}
                  onDelete={handleDeleteStep}
                  onMoveLeft={(id) => handleMoveStep(id, "left")}
                  onMoveRight={(id) => handleMoveStep(id, "right")}
                />

                {/* Arrow connector */}
                {index < steps.length - 1 && (
                  <svg
                    width="40"
                    height="24"
                    viewBox="0 0 40 24"
                    className="flex-shrink-0"
                  >
                    <line
                      x1="0"
                      y1="12"
                      x2="32"
                      y2="12"
                      stroke="rgb(113 113 122)"
                      strokeWidth="2"
                    />
                    <path
                      d="M 28 8 L 36 12 L 28 16"
                      fill="none"
                      stroke="rgb(113 113 122)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            ))}

            {/* Add step button */}
            <button
              onClick={async () => {
                try {
                  const nextOrder = steps.length > 0
                    ? Math.max(...steps.map((s) => s.sort_order)) + 1
                    : 0;
                  const res = await fetch(
                    `/api/admin/workflows/${workflowId}/steps`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: `Step ${nextOrder + 1}`,
                        description: "Describe what this step does",
                        exit_criteria: { programmatic: ["all_tasks_complete"], description: "" },
                        failure_policy: { action: "fail_plan", description: "" },
                        agent_config: { skill: "developer", model_tier: "primary" },
                        is_conditional: false,
                        sort_order: nextOrder,
                      }),
                    }
                  );
                  if (res.ok) {
                    fetchSteps();
                  }
                } catch (err) {
                  console.error("Failed to add step:", err);
                }
              }}
              className="w-12 h-12 rounded-full border-2 border-dashed border-zinc-700 flex items-center justify-center text-zinc-500 hover:border-cyan-500 hover:text-cyan-400 transition-colors flex-shrink-0"
              aria-label="Add step"
            >
              <svg
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

WorkflowPipelineEditor.displayName = "WorkflowPipelineEditor";
