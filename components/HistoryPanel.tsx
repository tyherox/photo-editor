"use client";

import type { BBox } from "@/lib/crop-inpaint-stitch";

interface HistoryEntry {
  id: number;
  thumbnail: string;
  label: string;
  beforeThumbnail?: string;
  regions?: BBox[];
  srcW?: number;
  srcH?: number;
}

interface Props {
  entries: HistoryEntry[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export default function HistoryPanel({ entries, activeIndex, onSelect }: Props) {
  if (entries.length === 0) return null;

  return (
    <div className="hidden md:block w-48 bg-zinc-900 border-l border-zinc-800 overflow-y-auto flex-shrink-0">
      <div className="p-3">
        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">History</h3>
        <div className="flex flex-col gap-2">
          {entries.map((entry, i) => {
            const isOriginal = i === 0;
            const hasBefore = !!entry.beforeThumbnail;
            const aspect = entry.srcW && entry.srcH ? `${entry.srcW} / ${entry.srcH}` : "16 / 9";
            const regions = entry.regions ?? [];
            return (
              <button
                key={entry.id}
                onClick={() => onSelect(i)}
                title={hasBefore ? "Hover to see the before" : entry.label}
                className={`group relative w-full rounded-lg overflow-hidden border-2 transition-colors ${
                  i === activeIndex ? "border-blue-500" : "border-transparent hover:border-zinc-600"
                }`}
              >
                <div className="relative w-full bg-zinc-950" style={{ aspectRatio: aspect }}>
                  {/* After (current) image */}
                  <img src={entry.thumbnail} alt={entry.label} className="absolute inset-0 h-full w-full object-cover" />

                  {/* Edited-area outlines (hidden while peeking at the before) */}
                  {regions.length > 0 && entry.srcW && entry.srcH && (
                    <div className="absolute inset-0 transition-opacity group-hover:opacity-0">
                      {regions.map((r, ri) => (
                        <div
                          key={ri}
                          className="absolute border border-cyan-400 bg-cyan-400/10"
                          style={{
                            left: `${(r.x / entry.srcW!) * 100}%`,
                            top: `${(r.y / entry.srcH!) * 100}%`,
                            width: `${(r.w / entry.srcW!) * 100}%`,
                            height: `${(r.h / entry.srcH!) * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {/* Before image, revealed on hover */}
                  {hasBefore && (
                    <img
                      src={entry.beforeThumbnail}
                      alt="before"
                      className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  )}

                  {/* Before / after badge */}
                  {hasBefore && (
                    <span className="absolute top-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-cyan-300">
                      <span className="group-hover:hidden">after</span>
                      <span className="hidden group-hover:inline">before</span>
                    </span>
                  )}
                  {isOriginal && (
                    <span className="absolute top-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-300">
                      source
                    </span>
                  )}
                </div>

                <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5">
                  <span className="block truncate text-[10px] text-zinc-300">{entry.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
