"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { WorkflowPipelineEditor } from "@/components/admin/WorkflowPipelineEditor";

interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  activeVersion: number | null;
}

export default function AdminWorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null
  );
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchWorkflows() {
      try {
        const res = await fetch("/api/admin/workflows");
        if (res.ok) {
          const data = await res.json();
          const workflowList = data.workflows || [];
          setWorkflows(workflowList);

          // Auto-select first workflow
          if (workflowList.length > 0 && !selectedWorkflowId) {
            setSelectedWorkflowId(workflowList[0].id);
          }
        }
      } catch (err) {
        console.error("Failed to fetch workflows:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchWorkflows();
  }, [selectedWorkflowId]);

  const handleCreateWorkflow = () => {
    // TODO: implement create workflow modal
    alert("Create workflow functionality coming soon");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-zinc-400">
        Loading workflows...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      {/* Left sidebar */}
      <div className="w-[250px] border-r border-zinc-800 p-4 bg-zinc-950 flex-shrink-0">
        <div className="mb-4">
          <button
            onClick={handleCreateWorkflow}
            className="w-full px-3 py-2 rounded-md text-sm font-medium bg-cyan-600 text-white hover:bg-cyan-500 transition-colors"
          >
            Create Workflow
          </button>
        </div>

        <div className="space-y-2">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            Workflows
          </h2>

          {workflows.length === 0 ? (
            <p className="text-xs text-zinc-600">
              No workflows yet. Click Create Workflow to start.
            </p>
          ) : (
            workflows.map((workflow) => (
              <button
                key={workflow.id}
                onClick={() => setSelectedWorkflowId(workflow.id)}
                className={cn(
                  "w-full text-left p-3 rounded-lg border transition-all",
                  selectedWorkflowId === workflow.id
                    ? "bg-zinc-800/80 border-cyan-700/60"
                    : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700"
                )}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="text-sm font-medium text-zinc-200">
                    {workflow.name}
                  </span>
                  {workflow.activeVersion !== null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30 whitespace-nowrap">
                      v{workflow.activeVersion}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 line-clamp-2">
                  {workflow.description}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 p-6">
        {selectedWorkflowId ? (
          <WorkflowPipelineEditor
            workflowId={selectedWorkflowId}
            onStepSelect={setSelectedStepId}
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-zinc-600 text-sm">
            Select a workflow to edit
          </div>
        )}
      </div>
    </div>
  );
}
