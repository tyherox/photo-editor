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

function LayerProperties({
  layer,
  onStartSplit,
  onExport,
}: {
  layer: Layer;
  onStartSplit: (axis: "x" | "y") => void;
  onExport: (format: "png" | "jpeg") => void;
}) {
  const { doAction, commit } = useDocActions();

  return (
    <div className="flex flex-col gap-2 border-b border-zinc-800 px-3 py-3 text-xs">
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
}: {
  selectedIds: string[];
  onSelect: (id: string | null, additive?: boolean) => void;
  onStartSplit: (axis: "x" | "y") => void;
  onExportLayers: (ids: string[], format: "png" | "jpeg") => void;
  onGroup: () => void;
  onUngroup: () => void;
  canGroup: boolean;
  canUngroup: boolean;
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
            <span>🔒 Layer locked — editing disabled.</span>
            <button
              onClick={() => doAction({ type: "LAYER_SET_LOCKED", id: single.id, locked: false })}
              className="ml-auto rounded bg-zinc-800 px-2 py-1 text-white hover:bg-zinc-700"
            >
              Unlock
            </button>
          </div>
        ) : (
          <LayerProperties layer={single} onStartSplit={onStartSplit} onExport={(format) => onExportLayers([single.id], format)} />
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
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_SET_VISIBLE", id: layer.id, visible: !layer.visible });
                }}
                className="text-zinc-400 hover:text-white"
                title={layer.visible ? "Hide" : "Show"}
              >
                {layer.visible ? "👁" : "🚫"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_SET_LOCKED", id: layer.id, locked: !layer.locked });
                }}
                className="text-zinc-400 hover:text-white"
                title={layer.locked ? "Unlock" : "Lock"}
              >
                {layer.locked ? "🔒" : "🔓"}
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

              {layer.groupId && (
                <span className="text-[10px] text-cyan-400" title="Grouped">
                  ⛓
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  doAction({ type: "LAYER_DELETE", id: layer.id });
                }}
                className="text-zinc-500 hover:text-red-400"
                title="Delete"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
