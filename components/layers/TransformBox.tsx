"use client";

import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Layer, Transform } from "@/lib/doc/types";
import { cloneLayer, contentSize } from "@/lib/doc/types";
import { useDoc, useDocActions } from "@/lib/doc/DocContext";
import { measureTextLayout } from "@/lib/doc/render";
import { aabbOf, computeSnap, type SnapConfig, type SnapGuide } from "@/lib/doc/snapping";
import {
  beginRotate,
  beginScale,
  beginTextResize,
  computeMove,
  computeRotate,
  computeScale,
  computeTextResize,
  cornersDoc,
  screenToDoc,
  type RotateStart,
  type ScaleHandle,
  type ScaleStart,
  type TextResizeStart,
  type Vec,
} from "@/lib/doc/geometry";

interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

type Interaction =
  | { kind: "move"; worldRect: DOMRect; zoom: number; t0: Transform; pointerDoc0: Vec }
  | { kind: "scale"; worldRect: DOMRect; zoom: number; start: ScaleStart }
  | { kind: "textresize"; worldRect: DOMRect; zoom: number; start: TextResizeStart }
  | { kind: "rotate"; worldRect: DOMRect; zoom: number; start: RotateStart };

const HANDLE = 12; // px
const SNAP_PX = 6; // screen-px snap threshold
const GUIDE_COLOR: Record<SnapGuide["kind"], string> = {
  align: "#ec4899",
  magnet: "#f59e0b",
  spacing: "#a855f7",
  grid: "#3b82f6",
};
const SCALE_HANDLES: ScaleHandle[] = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];
const HANDLE_CURSOR: Record<ScaleHandle, string> = {
  tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize",
  t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
};

export default function TransformBox({
  layer,
  viewport,
  getWorldRect,
  snap,
  onSelect,
}: {
  layer: Layer;
  viewport: Viewport;
  getWorldRect: () => DOMRect | null;
  snap: SnapConfig;
  onSelect?: (id: string | null, additive?: boolean) => void;
}) {
  const doc = useDoc();
  const { doAction, commit } = useDocActions();
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);

  // Local content box (text height is measured to match the rendered block).
  const size = useMemo(() => {
    if (layer.type === "text") return { w: layer.boxWidth, h: measureTextLayout(layer).height };
    return contentSize(layer);
  }, [layer]);

  const { zoom, panX, panY } = viewport;
  const toPx = (p: Vec) => ({ x: panX + p.x * zoom, y: panY + p.y * zoom });

  const corners = cornersDoc(layer.transform, size.w, size.h);
  const tl = toPx(corners.tl);
  const tr = toPx(corners.tr);
  const br = toPx(corners.br);
  const bl = toPx(corners.bl);
  const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pts: Record<ScaleHandle, Vec> = {
    tl, tr, br, bl,
    t: mid(tl, tr), r: mid(tr, br), b: mid(br, bl), l: mid(bl, tl),
  };

  // Rotate handle sits beyond the top edge, along center→topMid.
  const topMid = mid(tl, tr);
  const center = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
  let dir = { x: topMid.x - center.x, y: topMid.y - center.y };
  const len = Math.hypot(dir.x, dir.y);
  dir = len < 1 ? { x: 0, y: -1 } : { x: dir.x / len, y: dir.y / len };
  const rotatePos = { x: topMid.x + dir.x * 28, y: topMid.y + dir.y * 28 };

  // --- Interaction start (pointer-down on body / a handle / rotate) ---------
  function startMove(e: ReactPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    const pointerDoc0 = screenToDoc(e.clientX, e.clientY, worldRect, zoom);
    // Alt/Option-drag duplicates (Figma-style): drop a copy just above the
    // original, select it, and drag the copy — the original stays put. The
    // LAYER_ADD coalesces with the move, so it's a single undo step.
    let t0 = layer.transform;
    if (e.altKey && onSelect) {
      const clone = cloneLayer(layer);
      const at = doc.layers.findIndex((l) => l.id === layer.id) + 1;
      doAction({ type: "LAYER_ADD", layer: clone, at }, true);
      onSelect(clone.id);
      t0 = clone.transform;
    }
    setInteraction({ kind: "move", worldRect, zoom, t0, pointerDoc0 });
  }

  function startScale(handle: ScaleHandle) {
    return (e: ReactPointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const worldRect = getWorldRect();
      if (!worldRect) return;
      // Text: resize the wrap width (reflow), never stretch the glyphs.
      if (layer.type === "text") {
        const start = beginTextResize(layer.transform, size.w, handle);
        if (start) setInteraction({ kind: "textresize", worldRect, zoom, start });
        return;
      }
      setInteraction({ kind: "scale", worldRect, zoom, start: beginScale(layer.transform, size.w, size.h, handle) });
    };
  }

  function startRotate(e: ReactPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    const pointerDoc = screenToDoc(e.clientX, e.clientY, worldRect, zoom);
    setInteraction({ kind: "rotate", worldRect, zoom, start: beginRotate(layer.transform, size.w, size.h, pointerDoc) });
  }

  // --- Interaction move/end (handled by a full-window capture overlay) ------
  function onOverlayMove(e: ReactPointerEvent) {
    if (!interaction) return;
    const p = screenToDoc(e.clientX, e.clientY, interaction.worldRect, interaction.zoom);
    let next: Transform;
    if (interaction.kind === "move") {
      next = computeMove(interaction.t0, interaction.pointerDoc0, p);
      // Snap the moving layer's bbox per axis (Alt temporarily bypasses).
      if (snap.enabled && !e.altKey) {
        const bb = aabbOf(next, size.w, size.h);
        const { dx, dy, guides: g } = computeSnap(
          [bb.minX, bb.cx, bb.maxX],
          [bb.minY, bb.cy, bb.maxY],
          doc,
          [layer.id],
          snap,
          SNAP_PX / interaction.zoom
        );
        next = { ...next, x: next.x + dx, y: next.y + dy };
        setGuides(g);
      } else {
        setGuides([]);
      }
    } else if (interaction.kind === "scale") {
      // Snap the dragged corner/edge to alignment targets (skip when aspect-locked
      // with Shift, or bypassed with Alt). Only the axes the handle controls snap.
      let pp = p;
      if (snap.enabled && !e.altKey && !e.shiftKey) {
        const controlsX = interaction.start.fx !== 0.5;
        const controlsY = interaction.start.fy !== 0.5;
        const { dx, dy, guides: g } = computeSnap(
          controlsX ? [p.x] : [],
          controlsY ? [p.y] : [],
          doc,
          [layer.id],
          snap,
          SNAP_PX / interaction.zoom
        );
        pp = { x: p.x + dx, y: p.y + dy };
        setGuides(g);
      } else {
        setGuides([]);
      }
      next = computeScale(interaction.start, pp, e.shiftKey);
    } else if (interaction.kind === "textresize") {
      // Snap the dragged edge along x to alignment targets (Alt bypasses).
      let pp = p;
      if (snap.enabled && !e.altKey) {
        const { dx, dy, guides: g } = computeSnap([p.x], [], doc, [layer.id], snap, SNAP_PX / interaction.zoom);
        pp = { x: p.x + dx, y: p.y + dy };
        setGuides(g);
      } else {
        setGuides([]);
      }
      const { boxWidth, transform } = computeTextResize(interaction.start, pp);
      doAction({ type: "LAYER_PATCH_TEXT", id: layer.id, patch: { boxWidth } }, true);
      doAction({ type: "LAYER_SET_TRANSFORM", id: layer.id, transform }, true);
      return;
    } else {
      next = computeRotate(interaction.start, p, e.shiftKey);
    }
    doAction({ type: "LAYER_SET_TRANSFORM", id: layer.id, transform: next }, true);
  }

  function onOverlayUp() {
    commit();
    setInteraction(null);
    setGuides([]);
  }

  if (layer.locked) return null;

  return (
    <>
      {/* Selection outline (constant stroke, in container px space) */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <polygon
          points={`${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`}
          fill="none"
          stroke="#22d3ee"
          strokeWidth={1.5}
        />
        <line x1={topMid.x} y1={topMid.y} x2={rotatePos.x} y2={rotatePos.y} stroke="#22d3ee" strokeWidth={1.5} />
      </svg>

      {/* Move body — a rotated/scaled rect exactly over the layer */}
      <div
        onPointerDown={startMove}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: size.w,
          height: size.h,
          transformOrigin: "0 0",
          transform: `translate(${panX + layer.transform.x * zoom}px, ${panY + layer.transform.y * zoom}px) rotate(${layer.transform.rotation}rad) scale(${layer.transform.scaleX * zoom}, ${layer.transform.scaleY * zoom})`,
          cursor: "move",
          touchAction: "none",
        }}
      />

      {/* Scale handles. Text only resizes width, so drop the top/bottom edges. */}
      {(layer.type === "text" ? SCALE_HANDLES.filter((h) => h !== "t" && h !== "b") : SCALE_HANDLES).map((h) => (
        <div
          key={h}
          onPointerDown={startScale(h)}
          style={{
            position: "absolute",
            left: pts[h].x - HANDLE / 2,
            top: pts[h].y - HANDLE / 2,
            width: HANDLE,
            height: HANDLE,
            background: "#fff",
            border: "1.5px solid #0891b2",
            borderRadius: 2,
            cursor: HANDLE_CURSOR[h],
            touchAction: "none",
          }}
        />
      ))}

      {/* Rotate handle */}
      <div
        onPointerDown={startRotate}
        style={{
          position: "absolute",
          left: rotatePos.x - HANDLE / 2,
          top: rotatePos.y - HANDLE / 2,
          width: HANDLE,
          height: HANDLE,
          background: "#22d3ee",
          border: "1.5px solid #0891b2",
          borderRadius: "50%",
          cursor: "grab",
          touchAction: "none",
        }}
      />

      {/* Snap alignment guides (container space, constant width). */}
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <div
            key={i}
            className="pointer-events-none absolute z-[55]"
            style={{ left: panX + g.value * zoom, top: 0, width: 1.5, height: "100%", background: GUIDE_COLOR[g.kind] }}
          />
        ) : (
          <div
            key={i}
            className="pointer-events-none absolute z-[55]"
            style={{ top: panY + g.value * zoom, left: 0, height: 1.5, width: "100%", background: GUIDE_COLOR[g.kind] }}
          />
        )
      )}

      {/* Full-window capture while interacting — robust to fast drags. */}
      {interaction && (
        <div
          className="fixed inset-0 z-[60]"
          style={{ cursor: interaction.kind === "rotate" ? "grabbing" : "default", touchAction: "none" }}
          onPointerMove={onOverlayMove}
          onPointerUp={onOverlayUp}
          onPointerLeave={onOverlayUp}
        />
      )}
    </>
  );
}
