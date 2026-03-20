"use client";

import { useEffect, useState } from "react";
import { WorkflowStepNode } from "./WorkflowStepNode";
import type { WorkflowStep } from "@/lib/workflow-types";

interface WorkflowPipelineEditorProps {
  workflowId: string;
  onStepSelect: (stepId: string | null) => void;
}

export function WorkflowPipelineEditor({
  workflowId,
  onStepSelect,
}: WorkflowPipelineEditorProps) {
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [workflowName, setWorkflowName] = useState<string>("");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);

  useEffect(() => {
    async function fetchSteps() {
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
    }

    fetchSteps();
  }, [workflowId, onStepSelect]);

  const handleStepClick = (stepId: string) => {
    setSelectedStepId(stepId);
    onStepSelect(stepId);
  };

  const handleDeleteStep = async (stepId: string) => {
    try {
      const res = await fetch(`/api/admin/workflows/${workflowId}/steps/${stepId}`, {
        method: "DELETE",
      });

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
      }
    } catch (err) {
      console.error("Failed to publish workflow:", err);
    } finally {
      setPublishing(false);
    }
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
                  onClick={() => handleStepClick(step.id)}
                  onDelete={handleDeleteStep}
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
              onClick={() => {
                // TODO: implement add step modal
                alert("Add step functionality coming soon");
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
}
