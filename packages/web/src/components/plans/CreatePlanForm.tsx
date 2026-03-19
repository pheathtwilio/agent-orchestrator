"use client";

import { useState, memo } from "react";
import { cn } from "@/lib/cn";

interface ProjectInfo {
  id: string;
  name: string;
  repo: string;
}

interface CreatePlanFormProps {
  projects: ProjectInfo[];
  onCreated: (planId: string) => void;
  onCancel: () => void;
  onBrainstorm: (config: { project: string; description: string; skipTesting: boolean; maxConcurrency: number }) => void;
}

export const CreatePlanForm = memo(function CreatePlanForm({
  projects,
  onCreated,
  onCancel,
  onBrainstorm,
}: CreatePlanFormProps) {
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [skipTesting, setSkipTesting] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = projects.find((p) => p.id === project);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/plans/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          description: description.trim(),
          skipTesting,
          maxConcurrency,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to create plan");
        return;
      }

      onCreated(data.planId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Project */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Project</label>
        {projects.length <= 1 ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-md">
            <span className="text-sm text-zinc-200">{selectedProject?.name ?? project}</span>
            {selectedProject?.repo && (
              <span className="text-[10px] text-zinc-500 font-mono">{selectedProject.repo}</span>
            )}
          </div>
        ) : (
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/30"
            disabled={submitting}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.repo})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Feature description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the feature you want to build..."
          rows={4}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 resize-none"
          disabled={submitting}
          autoFocus
        />
      </div>

      {/* Options */}
      <div className="space-y-2">
        <label className="block text-xs text-zinc-400 mb-1">Options</label>

        <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={skipTesting}
            onChange={(e) => setSkipTesting(e.target.checked)}
            className="rounded border-zinc-700 bg-zinc-800 text-cyan-500 focus:ring-cyan-500/30 w-3.5 h-3.5"
            disabled={submitting}
          />
          Skip integration testing
        </label>

        <div className="flex items-center gap-2 text-xs text-zinc-300">
          <span>Max concurrent agents:</span>
          <input
            type="number"
            min={1}
            max={10}
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(parseInt(e.target.value, 10) || 5)}
            className="w-14 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:border-cyan-600 focus:outline-none"
            disabled={submitting}
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded p-2">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting || !project || !description.trim()}
          className={cn(
            "px-4 py-2 rounded-md text-xs font-medium transition-colors",
            submitting || !project || !description.trim()
              ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
              : "bg-cyan-600 text-white hover:bg-cyan-500",
          )}
        >
          {submitting ? "Creating..." : "Create Plan"}
        </button>
        <button
          type="button"
          onClick={() => onBrainstorm({ project, description, skipTesting, maxConcurrency })}
          disabled={submitting || !project}
          className={cn(
            "px-4 py-2 rounded-md text-xs font-medium transition-colors",
            submitting || !project
              ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
              : "bg-purple-600 text-white hover:bg-purple-500",
          )}
        >
          Brainstorm
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
});
