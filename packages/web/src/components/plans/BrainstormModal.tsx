"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/cn";

interface ProjectInfo {
  id: string;
  name: string;
  repo: string;
}

interface BrainstormModalProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  onPlanCreated: (planId: string) => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AgentOption {
  id: string;
  name: string;
  description?: string;
}

export function BrainstormModal({
  open,
  onClose,
  projects,
  onPlanCreated,
}: BrainstormModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingSpec, setPendingSpec] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState("default");
  const [agents, setAgents] = useState<AgentOption[]>([{ id: "default", name: "Default Brainstorm Agent" }]);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [skipTesting, setSkipTesting] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch available agents on mount
  useEffect(() => {
    if (!open) return;
    fetch("/api/plans/brainstorm/agents")
      .then((r) => r.json())
      .then((data) => {
        if (data.agents) setAgents(data.agents);
      })
      .catch(() => {});
  }, [open]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setMessages([]);
      setPendingSpec(null);
      setError(null);
      setInput("");
      setCreatingPlan(false);
      setProject(projects[0]?.id ?? "");
    }
  }, [open, projects]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creatingPlan) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, creatingPlan, onClose]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setStreaming(true);
    setPendingSpec(null);
    setError(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/plans/brainstorm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          agent: selectedAgent,
          messages: updatedMessages,
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setError(data.error ?? "Request failed");
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError("No response stream");
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) {
              assistantContent += data.content;
              setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);
            }
            if (data.done) {
              const specMatch = assistantContent.match(/<spec>([\s\S]*?)<\/spec>/);
              if (specMatch) {
                setPendingSpec(specMatch[1].trim());
              }
            }
            if (data.error) {
              setError(data.error);
            }
          } catch {
            // Ignore parse errors on partial chunks
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Connection failed");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, messages, streaming, project, selectedAgent]);

  const handleExecutePlan = useCallback(async () => {
    if (!pendingSpec || creatingPlan) return;
    setCreatingPlan(true);
    setError(null);

    try {
      const res = await fetch("/api/plans/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          description: pendingSpec,
          skipTesting,
          maxConcurrency,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create plan");
        setCreatingPlan(false);
        return;
      }

      onPlanCreated(data.planId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setCreatingPlan(false);
    }
  }, [pendingSpec, creatingPlan, project, skipTesting, maxConcurrency, onPlanCreated]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-zinc-200">Brainstorm</h2>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-300 focus:border-cyan-600 focus:outline-none"
            disabled={streaming}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {projects.length > 1 && (
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-300 focus:border-cyan-600 focus:outline-none"
              disabled={streaming}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Plan settings */}
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={skipTesting}
                onChange={(e) => setSkipTesting(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-800 text-cyan-500 focus:ring-cyan-500/30 w-3 h-3"
              />
              <span className="text-zinc-400">Skip tests</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-zinc-400">Agents:</span>
              <input
                type="number"
                min={1}
                max={10}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(parseInt(e.target.value, 10) || 5)}
                className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 focus:border-cyan-600 focus:outline-none"
              />
            </label>
          </div>
          <button
            onClick={onClose}
            disabled={creatingPlan}
            className="text-zinc-500 hover:text-zinc-300 transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-zinc-600 text-sm py-12">
            Describe your feature idea and the brainstorming agent will help you refine it into an actionable spec.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed",
              msg.role === "user"
                ? "ml-auto bg-cyan-900/40 border border-cyan-800/40 text-zinc-200"
                : "mr-auto bg-zinc-900 border border-zinc-800 text-zinc-300",
            )}
          >
            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
          </div>
        ))}
        {streaming && (
          <div className="text-xs text-cyan-500/60 animate-pulse">Agent is thinking...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Spec card */}
      {pendingSpec && (
        <div className="mx-6 mb-4 p-4 rounded-lg border border-green-800/50 bg-green-950/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-green-400 uppercase tracking-wider">Spec Ready</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingSpec(null)}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition-colors"
              >
                Refine Further
              </button>
              <button
                onClick={handleExecutePlan}
                disabled={creatingPlan}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  creatingPlan
                    ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                    : "bg-cyan-600 text-white hover:bg-cyan-500",
                )}
              >
                {creatingPlan ? "Creating Plan..." : "Execute Plan"}
              </button>
            </div>
          </div>
          <div className="text-xs text-green-300/80 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
            {pendingSpec}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mb-2 text-xs text-red-400 bg-red-900/20 border border-red-800/50 rounded p-2">
          {error}
        </div>
      )}

      {/* Input */}
      <div className="px-6 py-4 border-t border-zinc-800">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Describe your feature idea..."
            rows={2}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600/30 resize-none"
            disabled={streaming || creatingPlan}
          />
          <button
            onClick={sendMessage}
            disabled={streaming || !input.trim() || creatingPlan}
            className={cn(
              "px-4 py-2 rounded-md text-xs font-medium transition-colors self-end",
              streaming || !input.trim() || creatingPlan
                ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                : "bg-cyan-600 text-white hover:bg-cyan-500",
            )}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
