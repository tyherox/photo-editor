"use client";

import { useEffect, useRef, useState } from "react";
import { listProjects, type ProjectSummary } from "@/lib/persist/projectStore";
import { useEscapeKey } from "@/lib/useEscapeKey";

// The "Open" UI: a grid of saved projects (thumbnail + name + relative time),
// each openable or deletable, plus entry points to create a new canvas (blank
// or from an image). Reads project metadata from IndexedDB via listProjects().
export default function ProjectsDialog({
  openIds,
  onOpen,
  onDelete,
  onNewBlank,
  onNewFromImage,
  onClose,
}: {
  openIds: string[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
  onNewBlank: () => void;
  onNewFromImage: (file: File) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    let cancelled = false;
    listProjects().then((p) => {
      if (!cancelled) setProjects(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (id: string) => {
    await onDelete(id);
    setProjects((prev) => prev?.filter((p) => p.id !== id) ?? prev);
  };

  return (
    <div className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-dialog flex max-h-[80vh] w-[44rem] max-w-[92vw] flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Open project</h2>
          <div className="flex gap-2">
            <button
              onClick={onNewBlank}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
            >
              + New blank
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onNewFromImage(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600"
            >
              + From image
            </button>
          </div>
        </div>

        <div className="min-h-[8rem] flex-1 overflow-y-auto">
          {projects === null ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-zinc-500">
              <svg className="h-4 w-4 animate-spin text-zinc-600" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Loading…
            </div>
          ) : projects.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-center text-xs text-zinc-500">
              <span className="text-zinc-400">No saved projects yet</span>
              <span>Create a new document or open an image to get started.</span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  isOpen={openIds.includes(p.id)}
                  onOpen={() => onOpen(p.id)}
                  onDelete={() => remove(p.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  isOpen,
  onOpen,
  onDelete,
}: {
  project: ProjectSummary;
  isOpen: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // Create the object URL once during init (cards are keyed by id, so the
  // thumbnail blob is stable) and revoke it on unmount — avoids setState in an effect.
  const [thumbUrl] = useState<string | null>(() =>
    project.thumbnail ? URL.createObjectURL(project.thumbnail) : null
  );
  useEffect(() => {
    return () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    };
  }, [thumbUrl]);

  return (
    <div className="group relative overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800">
      <button onClick={onOpen} className="block w-full text-left" title={`Open ${project.name}`}>
        <div className="flex aspect-square items-center justify-center bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)] bg-[length:16px_16px]">
          {thumbUrl ? (
            <img src={thumbUrl} alt={project.name} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-zinc-500">No preview</span>
          )}
        </div>
        <div className="px-2 py-1.5">
          <div className="truncate text-xs font-medium text-white">{project.name || "Untitled"}</div>
          <div className="text-[10px] text-zinc-500">{relativeTime(project.updatedAt)}</div>
        </div>
      </button>
      {isOpen && (
        <span className="absolute left-1.5 top-1.5 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          Open
        </span>
      )}
      <button
        onClick={onDelete}
        className="absolute right-1.5 top-1.5 rounded bg-black/60 p-1 text-zinc-300 opacity-0 hover:bg-red-600 hover:text-white group-hover:opacity-100"
        title="Delete project"
        aria-label={`Delete ${project.name}`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function relativeTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
