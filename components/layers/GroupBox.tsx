"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { cloneLayer, contentSize, newId, type Layer, type Transform } from "@/lib/doc/types";
import { useDoc, useDocActions } from "@/lib/doc/DocContext";
import { measureTextLayout } from "@/lib/doc/render";
import { screenToDoc, type Vec } from "@/lib/doc/geometry";
import { aabbOf, computeSnap, type SnapConfig, type SnapGuide } from "@/lib/doc/snapping";

interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

const SNAP_PX = 6;
const GUIDE_COLOR: Record<SnapGuide["kind"], string> = {
  align: "#ec4899",
  magnet: "#f59e0b",
  spacing: "#a855f7",
  grid: "#3b82f6",
};

function sizeOf(layer: Layer) {
  return layer.type === "text" ? { w: layer.boxWidth, h: measureTextLayout(layer).height } : contentSize(layer);
}

// Bounding box around a multi-layer selection that moves all members together
// (snap-aware). Single-layer transforms still use TransformBox.
export default function GroupBox({
  layers,
  viewport,
  getWorldRect,
  snap,
  onSelect,
}: {
  layers: Layer[];
  viewport: Viewport;
  getWorldRect: () => DOMRect | null;
  snap: SnapConfig;
  onSelect?: (id: string | null, additive?: boolean) => void;
}) {
  const doc = useDoc();
  const { doAction, commit } = useDocActions();
  const { zoom, panX, panY } = viewport;
  const toPx = (p: Vec): Vec => ({ x: panX + p.x * zoom, y: panY + p.y * zoom });

  const boxes = layers.map((l) => {
    const s = sizeOf(l);
    return aabbOf(l.transform, s.w, s.h);
  });
  const minX = Math.min(...boxes.map((b) => b.minX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const maxY = Math.max(...boxes.map((b) => b.maxY));
  const tl = toPx({ x: minX, y: minY });

  const [drag, setDrag] = useState<{
    worldRect: DOMRect;
    pointer0: Vec;
    members: { id: string; transform: Transform }[];
    u0: { minX: number; minY: number; maxX: number; maxY: number };
  } | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);

  const startMove = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    // Alt/Option-drag duplicates the whole selection (Figma-style) and drags the
    // copies. A shared group is reproduced as a fresh group; a loose multi-select
    // copies as a loose multi-select. Copies start unlocked so they can move.
    // LAYER_ADDs coalesce into one undo step.
    let members = layers.map((l) => ({ id: l.id, transform: l.transform }));
    if (e.altKey && onSelect) {
      const grouped = layers.every((l) => l.groupId && l.groupId === layers[0].groupId);
      const groupId = grouped ? newId() : undefined;
      const clones = layers.map((l) => cloneLayer(l, { groupId, locked: false }));
      clones.forEach((c) => doAction({ type: "LAYER_ADD", layer: c }, true));
      clones.forEach((c, i) => onSelect(c.id, i > 0));
      members = clones.map((c) => ({ id: c.id, transform: c.transform }));
    } else {
      // Locked layers stay put even when part of a multi-selection.
      members = members.filter((m) => !layers.find((l) => l.id === m.id)?.locked);
      if (members.length === 0) return;
    }
    setDrag({
      worldRect,
      pointer0: screenToDoc(e.clientX, e.clientY, worldRect, zoom),
      members,
      u0: { minX, minY, maxX, maxY },
    });
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = screenToDoc(e.clientX, e.clientY, drag.worldRect, zoom);
    let dx = p.x - drag.pointer0.x;
    let dy = p.y - drag.pointer0.y;
    if (snap.enabled && !e.altKey) {
      const cx = (drag.u0.minX + drag.u0.maxX) / 2;
      const cy = (drag.u0.minY + drag.u0.maxY) / 2;
      const { dx: sdx, dy: sdy, guides: g } = computeSnap(
        [drag.u0.minX + dx, cx + dx, drag.u0.maxX + dx],
        [drag.u0.minY + dy, cy + dy, drag.u0.maxY + dy],
        doc,
        drag.members.map((m) => m.id),
        snap,
        SNAP_PX / zoom
      );
      dx += sdx;
      dy += sdy;
      setGuides(g);
    } else {
      setGuides([]);
    }
    for (const m of drag.members) {
      doAction({ type: "LAYER_SET_TRANSFORM", id: m.id, transform: { ...m.transform, x: m.transform.x + dx, y: m.transform.y + dy } }, true);
    }
  };

  const onUp = () => {
    commit();
    setDrag(null);
    setGuides([]);
  };

  return (
    <>
      <div
        onPointerDown={startMove}
        className="absolute"
        style={{
          left: tl.x,
          top: tl.y,
          width: (maxX - minX) * zoom,
          height: (maxY - minY) * zoom,
          border: "1.5px solid #22d3ee",
          background: "rgba(34,211,238,0.06)",
          cursor: "move",
          touchAction: "none",
        }}
      />
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <div key={i} className="pointer-events-none absolute z-[55]" style={{ left: panX + g.value * zoom, top: 0, width: 1.5, height: "100%", background: GUIDE_COLOR[g.kind] }} />
        ) : (
          <div key={i} className="pointer-events-none absolute z-[55]" style={{ top: panY + g.value * zoom, left: 0, height: 1.5, width: "100%", background: GUIDE_COLOR[g.kind] }} />
        )
      )}
      {drag && (
        <div className="fixed inset-0 z-[60]" style={{ cursor: "move", touchAction: "none" }} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
      )}
    </>
  );
}
