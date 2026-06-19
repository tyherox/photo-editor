"use client";

import { useWorkspace } from "@/lib/doc/DocContext";

// Open-canvas tabs. Each tab is one document with its own undo history (held in
// the workspace reducer); clicking switches the active canvas. `×` closes a tab
// (the project stays saved and reopenable); `+` opens the New-document dialog.
export default function TabBar({ onNew }: { onNew: () => void }) {
  const { tabs, activeId, activateTab, closeTab } = useWorkspace();

  return (
    <div className="flex items-stretch gap-px overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-1">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => activateTab(t.id)}
            className={`group flex max-w-[12rem] shrink-0 cursor-pointer items-center gap-2 rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
              active
                ? "border-blue-500 bg-zinc-900 text-white"
                : "border-transparent text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200"
            }`}
            title={t.name}
          >
            <span className="truncate">{t.name || "Untitled"}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              className="rounded p-0.5 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-white group-hover:opacity-100"
              title="Close tab"
              aria-label={`Close ${t.name}`}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}
      <button
        onClick={onNew}
        className="shrink-0 px-2.5 py-1.5 text-lg leading-none text-zinc-400 hover:text-white"
        title="New canvas"
        aria-label="New canvas"
      >
        +
      </button>
    </div>
  );
}
