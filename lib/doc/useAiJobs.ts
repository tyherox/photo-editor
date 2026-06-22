"use client";

import { useEffect, useRef, useState } from "react";
import { boxesOverlap, type BBox } from "@/lib/crop-inpaint-stitch";
import type { AreaBackend } from "./maskEdit";
import type { LoadProgress } from "@/lib/local-inpaint";

const GEMINI_CONCURRENCY = 3; // local MI-GAN is single-session → serial (1)

export interface Reservation {
  id: string;
  bbox: BBox;
  // "review": result is generated and awaiting accept/reject — the region stays
  // reserved so a new edit can't overlap something the user is still judging.
  kind: "running" | "review" | "frozen";
}

export interface PatchResult {
  bbox: BBox;
  patch: HTMLCanvasElement;
}

export interface JobContext {
  signal: AbortSignal;
  onProgress: (p: LoadProgress) => void;
}

// Public view of a job (no internal run thunk / controller).
export interface AiJob {
  id: string;
  backend: AreaBackend;
  prompt: string;
  bbox: BBox;
  status: "queued" | "running" | "review" | "error";
  error?: string;
  progress?: string;
  // Set once status === "review": the feathered patches awaiting accept/reject,
  // plus a one-time data-URL encoding of each for the preview overlay (stable
  // reference so the preview <img> doesn't reload on unrelated re-renders).
  result?: PatchResult[];
  resultSrcs?: { bbox: BBox; src: string }[];
}

interface InternalJob extends AiJob {
  freeze: boolean;
  run: (ctx: JobContext) => Promise<PatchResult[]>;
  controller?: AbortController;
}

export interface LaunchOpts {
  backend: AreaBackend; // schedules the concurrency lane (gemini parallel, local serial)
  prompt: string; // for display
  bbox: BBox; // reserved area
  freeze: boolean;
  run: (ctx: JobContext) => Promise<PatchResult[]>;
}

// Generic async generation scheduler: a queue of jobs, per-region reservations,
// concurrency caps, and cancellation — agnostic to what each job does (the
// caller supplies a `run` thunk). State lives in refs (read synchronously by the
// scheduler); React mirrors are exposed for rendering so consumers never read a ref.
export function useAiJobs(onPatches: (patches: PatchResult[]) => void) {
  const jobsRef = useRef<InternalJob[]>([]);
  const resRef = useRef<Reservation[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);

  const onPatchesRef = useRef(onPatches);
  useEffect(() => {
    onPatchesRef.current = onPatches;
  });

  function sync() {
    setJobs(
      jobsRef.current.map((j) => ({
        id: j.id,
        backend: j.backend,
        prompt: j.prompt,
        bbox: j.bbox,
        status: j.status,
        error: j.error,
        progress: j.progress,
        result: j.result,
        resultSrcs: j.resultSrcs,
      }))
    );
    setReservations(resRef.current.map((r) => ({ ...r })));
  }

  function runJob(job: InternalJob) {
    job.controller = new AbortController();
    job
      .run({
        signal: job.controller.signal,
        onProgress: (p) => {
          job.progress =
            p.status === "downloading"
              ? `Downloading model… ${Math.round((p.progress ?? 0) * 100)}%`
              : p.status === "initializing"
                ? "Initializing…"
                : undefined;
          sync();
        },
      })
      .then((patches) => {
        // Don't commit yet — hold the result for review. The region stays
        // reserved (kind "review") so nothing can overlap it until the user
        // accepts or rejects. Commit happens in accept().
        const j = jobsRef.current.find((x) => x.id === job.id);
        if (j) {
          j.status = "review";
          j.result = patches;
          j.resultSrcs = patches.map((p) => ({ bbox: p.bbox, src: p.patch.toDataURL() }));
          j.progress = undefined;
        }
        resRef.current = resRef.current.map((r) => (r.id === job.id ? { ...r, kind: "review" } : r));
      })
      .catch((e: unknown) => {
        if (job.controller?.signal.aborted) {
          jobsRef.current = jobsRef.current.filter((j) => j.id !== job.id);
          resRef.current = resRef.current.filter((r) => r.id !== job.id);
        } else {
          const j2 = jobsRef.current.find((j) => j.id === job.id);
          if (j2) {
            j2.status = "error";
            j2.error = e instanceof Error ? e.message : String(e);
            j2.progress = undefined;
          }
          // Free the region on error so the user can retry it.
          resRef.current = resRef.current.filter((r) => r.id !== job.id);
        }
      })
      .finally(() => {
        sync();
        pump();
      });
  }

  function pump() {
    const runningGemini = jobsRef.current.filter((j) => j.status === "running" && j.backend === "gemini").length;
    let slots = GEMINI_CONCURRENCY - runningGemini;
    let localBusy = jobsRef.current.some((j) => j.status === "running" && j.backend === "local");
    for (const job of jobsRef.current) {
      if (job.status !== "queued") continue;
      if (job.backend === "gemini") {
        if (slots <= 0) continue;
        slots--;
      } else {
        if (localBusy) continue;
        localBusy = true;
      }
      job.status = "running";
      runJob(job);
    }
    sync();
  }

  function overlapsReserved(bbox: BBox): boolean {
    return resRef.current.some((r) => boxesOverlap(r.bbox, bbox));
  }

  // Returns the job id, or null if the region overlaps a reserved (in-flight or
  // frozen) area.
  function launch(opts: LaunchOpts): string | null {
    if (overlapsReserved(opts.bbox)) return null;
    const id = crypto.randomUUID();
    jobsRef.current = [
      ...jobsRef.current,
      { id, backend: opts.backend, prompt: opts.prompt, bbox: opts.bbox, status: "queued", freeze: opts.freeze, run: opts.run },
    ];
    resRef.current = [...resRef.current, { id, bbox: opts.bbox, kind: "running" }];
    pump();
    return id;
  }

  function cancel(id: string) {
    const job = jobsRef.current.find((j) => j.id === id);
    job?.controller?.abort();
    jobsRef.current = jobsRef.current.filter((j) => j.id !== id);
    resRef.current = resRef.current.filter((r) => r.id !== id);
    sync();
    pump();
  }

  // Commit a reviewed result as layer(s), then freeze-or-free its region exactly
  // as the auto-commit path used to.
  function accept(id: string) {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job || job.status !== "review" || !job.result) return;
    onPatchesRef.current(job.result);
    jobsRef.current = jobsRef.current.filter((j) => j.id !== id);
    resRef.current = job.freeze
      ? resRef.current.map((r) => (r.id === id ? { ...r, kind: "frozen" } : r))
      : resRef.current.filter((r) => r.id !== id);
    sync();
    pump();
  }

  // Discard a reviewed result and free its region.
  function reject(id: string) {
    jobsRef.current = jobsRef.current.filter((j) => j.id !== id);
    resRef.current = resRef.current.filter((r) => r.id !== id);
    sync();
    pump();
  }

  // Re-run a job's original thunk (same prompt/snapshot/bbox) — from a result the
  // user didn't like, or from an error. Its region stays reserved while it reruns.
  function retry(id: string) {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    job.status = "queued";
    job.result = undefined;
    job.resultSrcs = undefined;
    job.error = undefined;
    job.progress = undefined;
    resRef.current = resRef.current.some((r) => r.id === id)
      ? resRef.current.map((r) => (r.id === id ? { ...r, kind: "running" } : r))
      : [...resRef.current, { id, bbox: job.bbox, kind: "running" }];
    sync();
    pump();
  }

  function unfreeze(id: string) {
    resRef.current = resRef.current.filter((r) => !(r.id === id && r.kind === "frozen"));
    sync();
  }

  return { jobs, reservations, launch, cancel, accept, reject, retry, unfreeze, overlapsReserved };
}
