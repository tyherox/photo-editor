"use client";

import { Fragment } from "react";

// Photoshop/Figma-style measurement gutters along the top and left edges of the
// canvas. Purely visual (pointer-events none) except the corner unit picker, so
// they never interfere with panning, selecting, or measuring. Ticks are computed
// in the chosen unit and re-laid-out on every zoom/pan change.

export type RulerUnit = "px" | "%" | "cm" | "in";
export const RULER_UNITS: RulerUnit[] = ["px", "%", "cm", "in"];

const RULER = 22; // strip thickness, px
const DPI = 96; // assumed pixels-per-inch for physical units (cm/in)
const TARGET_PX = 72; // desired on-screen spacing between major ticks

interface VP {
  zoom: number;
  panX: number;
  panY: number;
}

// "Nice" 1/2/5 × 10ⁿ step at least `raw` in size.
function niceStep(raw: number): number {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}

// How many unit-values one doc-pixel spans, for an axis of length `docLen`.
function unitPerPx(unit: RulerUnit, docLen: number): number {
  switch (unit) {
    case "px":
      return 1;
    case "%":
      return docLen > 0 ? 100 / docLen : 1;
    case "cm":
      return 2.54 / DPI;
    case "in":
      return 1 / DPI;
  }
}

function formatLabel(u: number, decimals: number): string {
  const v = Math.abs(u) < 1e-9 ? 0 : u;
  if (decimals === 0) return String(Math.round(v));
  return v
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

interface Tick {
  pos: number; // local px along the strip
  major: boolean;
  label: string | null;
}

// Build ticks across a strip of `lengthPx`, where the strip's local 0 sits at
// container coordinate `offset`. `pan`/`zoom` map doc → container coords.
function buildTicks(pan: number, zoom: number, lengthPx: number, offset: number, unit: RulerUnit, docLen: number): { ticks: Tick[]; canvas: { start: number; end: number } } {
  const ticks: Tick[] = [];
  if (lengthPx <= 0 || zoom <= 0) return { ticks, canvas: { start: 0, end: 0 } };
  const k = unitPerPx(unit, docLen);
  const dMin = (offset - pan) / zoom; // doc coord at the strip's near edge
  const dMax = (offset + lengthPx - pan) / zoom; // …and far edge
  const uMin = Math.min(dMin, dMax) * k;
  const uMax = Math.max(dMin, dMax) * k;
  const step = niceStep((TARGET_PX * k) / zoom);
  const minor = step / 5;
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const i0 = Math.floor(uMin / minor) - 1;
  const i1 = Math.ceil(uMax / minor) + 1;
  for (let i = i0; i <= i1; i++) {
    const u = i * minor;
    const d = u / k;
    const pos = pan + d * zoom - offset;
    if (pos < -1 || pos > lengthPx + 1) continue;
    const major = i % 5 === 0;
    ticks.push({ pos, major, label: major ? formatLabel(u, decimals) : null });
  }
  // Canvas extent band (doc 0 → docLen), clipped to the strip.
  const start = pan + 0 * zoom - offset;
  const end = pan + docLen * zoom - offset;
  return { ticks, canvas: { start, end } };
}

export default function CanvasRulers({
  vp,
  containerW,
  containerH,
  docWidth,
  docHeight,
  unit,
  onUnitChange,
}: {
  vp: VP;
  containerW: number;
  containerH: number;
  docWidth: number;
  docHeight: number;
  unit: RulerUnit;
  onUnitChange: (u: RulerUnit) => void;
}) {
  if (!containerW || !containerH) return null;

  const topLen = containerW - RULER;
  const leftLen = containerH - RULER;
  const top = buildTicks(vp.panX, vp.zoom, topLen, RULER, unit, docWidth);
  const left = buildTicks(vp.panY, vp.zoom, leftLen, RULER, unit, docHeight);

  const stripBg = "rgba(24,24,27,0.92)"; // zinc-900-ish
  const tickColor = "rgba(161,161,170,0.7)"; // zinc-400
  const labelColor = "#a1a1aa";
  const canvasBand = "rgba(34,211,238,0.10)"; // cyan tint marking the canvas extent

  return (
    <>
      {/* Top (horizontal) ruler */}
      <div className="pointer-events-none absolute z-40" style={{ left: RULER, top: 0, width: topLen, height: RULER, background: stripBg, borderBottom: "1px solid rgba(63,63,70,0.8)" }}>
        <svg width={topLen} height={RULER} style={{ display: "block" }}>
          {top.canvas.end > top.canvas.start && (
            <rect x={Math.max(0, top.canvas.start)} y={0} width={Math.min(topLen, top.canvas.end) - Math.max(0, top.canvas.start)} height={RULER} fill={canvasBand} />
          )}
          {top.ticks.map((t, i) => (
            <Fragment key={i}>
              <line x1={t.pos} y1={t.major ? RULER - 9 : RULER - 5} x2={t.pos} y2={RULER} stroke={tickColor} strokeWidth={1} />
              {t.label !== null && (
                <text x={t.pos + 3} y={9} fontSize={9} fill={labelColor} style={{ userSelect: "none" }}>
                  {t.label}
                </text>
              )}
            </Fragment>
          ))}
        </svg>
      </div>

      {/* Left (vertical) ruler */}
      <div className="pointer-events-none absolute z-40" style={{ left: 0, top: RULER, width: RULER, height: leftLen, background: stripBg, borderRight: "1px solid rgba(63,63,70,0.8)" }}>
        <svg width={RULER} height={leftLen} style={{ display: "block" }}>
          {left.canvas.end > left.canvas.start && (
            <rect x={0} y={Math.max(0, left.canvas.start)} width={RULER} height={Math.min(leftLen, left.canvas.end) - Math.max(0, left.canvas.start)} fill={canvasBand} />
          )}
          {left.ticks.map((t, i) => (
            <Fragment key={i}>
              <line x1={t.major ? RULER - 9 : RULER - 5} y1={t.pos} x2={RULER} y2={t.pos} stroke={tickColor} strokeWidth={1} />
              {t.label !== null && (
                <text x={9} y={t.pos - 3} fontSize={9} fill={labelColor} textAnchor="middle" transform={`rotate(-90 9 ${t.pos - 3})`} style={{ userSelect: "none" }}>
                  {t.label}
                </text>
              )}
            </Fragment>
          ))}
        </svg>
      </div>

      {/* Corner unit picker */}
      <div className="absolute z-40" style={{ left: 0, top: 0, width: RULER, height: RULER, background: stripBg, borderRight: "1px solid rgba(63,63,70,0.8)", borderBottom: "1px solid rgba(63,63,70,0.8)" }}>
        <select
          value={unit}
          onChange={(e) => onUnitChange(e.target.value as RulerUnit)}
          title="Ruler units"
          className="h-full w-full cursor-pointer appearance-none bg-transparent text-center text-[9px] font-medium text-zinc-400 outline-none hover:text-white"
          style={{ lineHeight: `${RULER}px` }}
        >
          {RULER_UNITS.map((u) => (
            <option key={u} value={u} className="bg-zinc-900 text-zinc-200">
              {u}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
