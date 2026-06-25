"use client";

import { useState, type DragEvent } from "react";
import { useDoc, useDocActions } from "@/lib/doc/DocContext";
import { BLEND_MODES, type Layer } from "@/lib/doc/types";

// Concrete font stacks (no CSS var()) so DOM and canvas export resolve identically.
const FONTS = [
  { label: "Sans", value: "Arial, Helvetica, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", value: "'Courier New', monospace" },
  { label: "Display", value: "Impact, Haettenschweiler, sans-serif" },
];
const WEIGHTS = [
  { label: "Light", value: 300 },
  { label: "Regular", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Semibold", value: 600 },
  { label: "Bold", value: 700 },
  { label: "Black", value: 900 },
];

// Crisp SVG glyphs for the per-layer controls — emojis render inconsistently
// across platforms (and looked out of place against the rest of the chrome).
const ICON = "h-3.5 w-3.5";
const svgProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
} as const;

const EyeIcon = ({ off }: { off?: boolean }) =>
  off ? (
    <svg className={ICON} {...svgProps}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.774 3.162 10.066 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88" />
    </svg>
  ) : (
    <svg className={ICON} {...svgProps}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );

const LockIcon = ({ open }: { open?: boolean }) =>
  open ? (
    <svg className={ICON} {...svgProps}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  ) : (
    <svg className={ICON} {...svgProps}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );

const LinkIcon = () => (
  <svg className="h-3 w-3" {...svgProps}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  </svg>
);

const SparkleIcon = () => (
  <svg className="h-3 w-3" {...svgProps}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
  </svg>
);

const TrashIcon = () => (
  <svg className={ICON} {...svgProps}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

function LayerProperties({
  layer,
  onStartSplit,
  onExport,
  onRepromptLayer,
  onRetryLayer,
  onUpscaleLayer,
}: {
  layer: Layer;
  onStartSplit: (axis: "x" | "y") => void;
  onExport: (format: "png" | "jpeg") => void;
  onRepromptLayer?: (id: string, prompt: string) => void;
  onRetryLayer?: (id: string) => void;
  onUpscaleLayer?: (id: string, factor: number) => void;
}) {
  const { doAction, commit } = useDocActions();
  const [repromptText, setRepromptText] = useState("");

  return (
    <div className="flex flex-col gap-2 border-b border-zinc-800 px-3 py-3 text-xs">
      {layer.type === "raster" && layer.aiEdit && (
        <div className="flex flex-col gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/5 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-indigo-300">
            <SparkleIcon />
            <span className="font-medium">AI edit</span>
          </div>
          <p className="truncate text-zinc-400" title={layer.aiEdit.prompt}>
            “{layer.aiEdit.prompt}”
          </p>
          <input
            value={repromptText}
            onChange={(e) => setRepromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && repromptText.trim()) {
                onRepromptLayer?.(layer.id, repromptText.trim());
                setRepromptText("");
              }
            }}
            placeholder="Describe a change to this layer…"
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-white placeholder:text-zinc-500 focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                if (!repromptText.trim()) return;
                onRepromptLayer?.(layer.id, repromptText.trim());
                setRepromptText("");
              }}
              disabled={!repromptText.trim()}
              className="rounded bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              title="Apply a new instruction to this layer's current image"
            >
              ✎ Edit
            </button>
            <button
              onClick={() => onRetryLayer?.(layer.id)}
              className="rounded bg-zinc-700 px-2.5 py-1 text-white hover:bg-zinc-600"
              title="Re-run the original instruction against the original input"
            >
              ↻ Retry
            </button>
          </div>
        </div>
      )}

      <label className="flex items-center justify-between gap-2 text-zinc-400">
        Opacity
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={layer.opacity}
          onChange={(e) => doAction({ type: "LAYER_SET_OPACITY", id: layer.id, opacity: Number(e.target.value) }, true)}
          onPointerUp={commit}
          onBlur={commit}
          className="w-32"
        />
      </label>

      <label className="flex items-center justify-between gap-2 text-zinc-400">
        Blend
        <select
          value={layer.blendMode}
          onChange={(e) =>
            doAction({ type: "LAYER_SET_BLEND", id: layer.id, blendMode: e.target.value as Layer["blendMode"] })
          }
          className="rounded bg-zinc-800 px-1.5 py-1 text-white"
        >
          {BLEND_MODES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      {layer.type === "text" && (
        <>
          <textarea
            value={layer.text}
            onChange={(e) => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { text: e.target.value } }, true)}
            onBlur={commit}
            rows={3}
            className="w-full resize-y rounded bg-zinc-800 px-2 py-1 text-white"
          />
          <div className="flex items-center gap-2">
            <select
              value={layer.fontFamily}
              onChange={(e) => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { fontFamily: e.target.value } })}
              className="min-w-0 flex-1 rounded bg-zinc-800 px-1.5 py-1 text-white"
              title="Font"
            >
              {FONTS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
              {!FONTS.some((f) => f.value === layer.fontFamily) && <option value={layer.fontFamily}>Custom</option>}
            </select>
            <select
              value={layer.fontWeight}
              onChange={(e) => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { fontWeight: Number(e.target.value) } })}
              className="rounded bg-zinc-800 px-1.5 py-1 text-white"
              title="Font weight"
            >
              {WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-zinc-400">
              Size
              <input
                type="number"
                min={4}
                value={layer.fontSize}
                onChange={(e) =>
                  doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { fontSize: Number(e.target.value) } }, true)
                }
                onBlur={commit}
                className="w-14 rounded bg-zinc-800 px-1.5 py-1 text-white"
              />
            </label>
            <label className="flex items-center gap-1 text-zinc-400" title="Text box width (text reflows)">
              Width
              <input
                type="number"
                min={20}
                value={Math.round(layer.boxWidth)}
                onChange={(e) =>
                  doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { boxWidth: Math.max(20, Number(e.target.value)) } }, true)
                }
                onBlur={commit}
                className="w-16 rounded bg-zinc-800 px-1.5 py-1 text-white"
              />
            </label>
            <label className="flex items-center gap-1 text-zinc-400" title="Line height (multiplier)">
              Line
              <input
                type="number"
                min={0.5}
                step={0.1}
                value={layer.lineHeight}
                onChange={(e) =>
                  doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { lineHeight: Math.max(0.5, Number(e.target.value)) } }, true)
                }
                onBlur={commit}
                className="w-14 rounded bg-zinc-800 px-1.5 py-1 text-white"
              />
            </label>
            <input
              type="color"
              value={layer.color}
              onChange={(e) => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { color: e.target.value } }, true)}
              onBlur={commit}
              className="h-7 w-7 rounded bg-transparent"
              title="Text color"
            />
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <span>Align</span>
            <div className="flex overflow-hidden rounded border border-zinc-700">
              {(["left", "center", "right"] as const).map((a) => (
                <button
                  key={a}
                  title={`Align ${a}`}
                  onClick={() => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { align: a } })}
                  className={`px-2.5 py-1 ${layer.align === a ? "bg-zinc-700 text-white" : "hover:bg-zinc-800"}`}
                >
                  {a === "left" ? "⯇" : a === "center" ? "≡" : "⯈"}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded border border-zinc-700">
              <button
                title="Italic"
                onClick={() => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { italic: !layer.italic } })}
                className={`px-2.5 py-1 italic ${layer.italic ? "bg-zinc-700 text-white" : "hover:bg-zinc-800"}`}
              >
                I
              </button>
              <button
                title="Underline"
                onClick={() => doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { underline: !layer.underline } })}
                className={`px-2.5 py-1 underline ${layer.underline ? "bg-zinc-700 text-white" : "hover:bg-zinc-800"}`}
              >
                U
              </button>
            </div>
          </div>
        </>
      )}

      {layer.type === "shape" && layer.shape !== "line" && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-zinc-400">
            Fill
            <input
              type="color"
              value={layer.fill === "transparent" ? "#000000" : layer.fill}
              onChange={(e) => doAction({ type: "LAYER_PATCH_SHAPE", id: layer.id, patch: { fill: e.target.value } }, true)}
              onBlur={commit}
              className="h-7 w-7 rounded bg-transparent"
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-400">
            Stroke
            <input
              type="color"
              value={layer.stroke === "transparent" ? "#ffffff" : layer.stroke}
              onChange={(e) =>
                doAction({ type: "LAYER_PATCH_SHAPE", id: layer.id, patch: { stroke: e.target.value, strokeWidth: Math.max(layer.strokeWidth, 2) } }, true)
              }
              onBlur={commit}
              className="h-7 w-7 rounded bg-transparent"
            />
          </label>
        </div>
      )}

      {layer.type === "raster" && (
        <div className="flex items-center gap-2 text-zinc-400">
          <span>Split</span>
          <button onClick={() => onStartSplit("x")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Place vertical cut lines">
            ⬌ Vertical
          </button>
          <button onClick={() => onStartSplit("y")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Place horizontal cut lines">
            ⬍ Horizontal
          </button>
        </div>
      )}

      {layer.type === "raster" && onUpscaleLayer && (
        <div className="flex items-center gap-2 text-zinc-400">
          <span title="Resample to a higher resolution; on-canvas size is unchanged">
            Upscale
          </span>
          <button
            onClick={() => onUpscaleLayer(layer.id, 2)}
            className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700"
            title={`Double resolution (→ ${layer.naturalWidth * 2}×${layer.naturalHeight * 2}px)`}
          >
            2×
          </button>
          <button
            onClick={() => onUpscaleLayer(layer.id, 4)}
            className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700"
            title={`Quadruple resolution (→ ${layer.naturalWidth * 4}×${layer.naturalHeight * 4}px)`}
          >
            4×
          </button>
          <span className="ml-auto tabular-nums text-zinc-500">
            {layer.naturalWidth}×{layer.naturalHeight}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 text-zinc-400">
        <span>Export</span>
        <button onClick={() => onExport("png")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Export this layer as PNG (transparent)">
          PNG
        </button>
        <button onClick={() => onExport("jpeg")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Export this layer as JPEG (white background)">
          JPEG
        </button>
      </div>
    </div>
  );
}

export default function LayersPanel({
  selectedIds,
  onSelect,
  onStartSplit,
  onExportLayers,
  onGroup,
  onUngroup,
  canGroup,
  canUngroup,
  onRepromptLayer,
  onRetryLayer,
  onUpscaleLayer,
}: {
  selectedIds: string[];
  onSelect: (id: string | null, additive?: boolean) => void;
  onStartSplit: (axis: "x" | "y") => void;
  onExportLayers: (ids: string[], format: "png" | "jpeg") => void;
  onGroup: () => void;
  onUngroup: () => void;
  canGroup: boolean;
  canUngroup: boolean;
  onRepromptLayer?: (id: string, prompt: string) => void;
  onRetryLayer?: (id: string) => void;
  onUpscaleLayer?: (id: string, factor: number) => void;
}) {
  const doc = useDoc();
  const { doAction } = useDocActions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  // Per-layer properties only make sense for a single selection.
  const single = selectedIds.length === 1 ? doc.layers.find((l) => l.id === selectedIds[0]) : undefined;
  // Display front (last in array) at the top.
  const display = doc.layers.slice().reverse();

  function onDrop(e: DragEvent, displayIndex: number) {
    e.preventDefault();
    if (!dragId) return;
    const toIndex = doc.layers.length - 1 - displayIndex; // map display row → array index
    doAction({ type: "LAYER_REORDER", id: dragId, toIndex });
    setDragId(null);
  }

  return (
    <aside className="flex w-64 flex-shrink-0 flex-col border-l border-zinc-800 bg-zinc-900">
      <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Layers</div>

      {(canGroup || canUngroup) && (
        <div className="flex items-center gap-1 border-b border-zinc-800 px-3 py-1.5">
          {canGroup && (
            <button onClick={onGroup} className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700" title="Group (⌘G)">
              Group
            </button>
          )}
          {canUngroup && (
            <button onClick={onUngroup} className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700" title="Ungroup (⌘⇧G)">
              Ungroup
            </button>
          )}
          {selectedIds.length > 1 && <span className="ml-auto text-xs text-zinc-500">{selectedIds.length} selected</span>}
        </div>
      )}

      {selectedIds.length > 1 && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-400">
          <span>Export as one</span>
          <button onClick={() => onExportLayers(selectedIds, "png")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Export the selected layers flattened into one PNG (transparent)">
            PNG
          </button>
          <button onClick={() => onExportLayers(selectedIds, "jpeg")} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700" title="Export the selected layers flattened into one JPEG (white background)">
            JPEG
          </button>
        </div>
      )}

      {single &&
        (single.locked ? (
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-3 text-xs text-zinc-400">
            <span className="flex items-center gap-1.5 text-amber-500/90"><LockIcon /> Layer locked — editing disabled.</span>
            <button
              onClick={() => doAction({ type: "LAYER_SET_LOCKED", id: single.id, locked: false })}
              className="ml-auto rounded bg-zinc-800 px-2 py-1 text-white hover:bg-zinc-700"
            >
              Unlock
            </button>
          </div>
        ) : (
          <LayerProperties
            layer={single}
            onStartSplit={onStartSplit}
            onExport={(format) => onExportLayers([single.id], format)}
            onRepromptLayer={onRepromptLayer}
            onRetryLayer={onRetryLayer}
            onUpscaleLayer={onUpscaleLayer}
          />
        ))}

      <div className="flex-1 overflow-y-auto">
        {display.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-zinc-600">Add an image, text, or shape to begin.</p>
        )}
        {display.map((layer, i) => {
          const isSelected = selectedIds.includes(layer.id);
          return (
            <div
              key={layer.id}
              draggable
              onDragStart={() => setDragId(layer.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, i)}
              onPointerDown={(e) => onSelect(layer.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              className={`flex items-center gap-1.5 border-l-2 px-2 py-2 text-xs ${
                isSelected ? "border-blue-500 bg-zinc-800/70 text-white" : "border-transparent text-zinc-300 hover:bg-zinc-800/40"
              }`}
            >
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_SET_VISIBLE", id: layer.id, visible: !layer.visible });
                }}
                className={`transition-colors hover:text-white ${layer.visible ? "text-zinc-400" : "text-zinc-600"}`}
                title={layer.visible ? "Hide" : "Show"}
                aria-label={layer.visible ? "Hide layer" : "Show layer"}
              >
                <EyeIcon off={!layer.visible} />
              </button>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_SET_LOCKED", id: layer.id, locked: !layer.locked });
                }}
                className={`transition-colors hover:text-white ${layer.locked ? "text-amber-500" : "text-zinc-400"}`}
                title={layer.locked ? "Unlock" : "Lock"}
                aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
              >
                <LockIcon open={!layer.locked} />
              </button>

              {editingId === layer.id ? (
                <input
                  autoFocus
                  defaultValue={layer.name}
                  onBlur={(e) => {
                    doAction({ type: "LAYER_RENAME", id: layer.id, name: e.target.value || layer.name });
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="min-w-0 flex-1 rounded bg-zinc-700 px-1 text-white"
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 truncate ${layer.locked ? "italic text-zinc-500" : ""}`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(layer.id);
                  }}
                >
                  {layer.name}
                </span>
              )}

              {layer.type === "raster" && layer.aiEdit && (
                <span className="text-indigo-400" title="AI edit — reprompt from the panel above">
                  <SparkleIcon />
                </span>
              )}
              {layer.groupId && (
                <span className="text-cyan-400" title="Grouped">
                  <LinkIcon />
                </span>
              )}
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_DELETE", id: layer.id });
                }}
                className="text-zinc-500 transition-colors hover:text-red-400"
                title="Delete"
                aria-label="Delete layer"
              >
                <TrashIcon />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
