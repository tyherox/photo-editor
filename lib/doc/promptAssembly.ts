// Single source of truth for the FULL instruction text the model receives.
//
// Previously the prompt was augmented in two hidden places: the client appended
// seam-blending guidance (maskEdit.ts) and the API route re-wrapped it again
// (region framing, "Instructions:" prefix). The model therefore never saw what
// the user typed, and the user could never see what the model saw.
//
// Everything that is an INSTRUCTION to the model is assembled here so the UI can
// show (and optionally let the user edit) the exact text before it's sent. The
// API route now treats this output verbatim (`rawPrompt: true`) and only owns
// the structural image captions ("Image to edit:", "Reference image:", …).

export type EditFlow = "isolated" | "context" | "full";

export interface AssembleArgs {
  flow: EditFlow;
  userPrompt: string;
  hasReference: boolean;
  // Isolated only: a black/white mask is attached alongside the crop so the model
  // edits only the marked shape instead of the whole rectangular crop.
  maskAware?: boolean;
}

// Seam-blending guidance. Deliberately domain-agnostic and non-overriding: it
// must NOT tell the model to keep colors/lighting/style fixed (that would
// countermand legitimate recolor/relight/restyle edits). The single guardrail —
// "only what the instruction describes" — keeps it from rewriting the region.
export const SEAM_GUIDANCE =
  "Apply only the change described in the instruction, and blend it seamlessly " +
  "into the surrounding image so the edited region's edges have no visible seams.";

const MASK_GUIDANCE =
  "Change only the area marked in white in the attached mask; leave everything " +
  "else in the image unchanged.";

// Whole-scene region framing: the model sees the full image plus a copy with the
// region ringed in magenta, edits only inside the ring, and the caller composites
// just the masked pixels back.
const CONTEXT_FRAMING_TAIL =
  " Use the rest of the image as context so the edit matches the scene's " +
  "lighting, color, perspective, and style. Leave everything outside the outline " +
  "pixel-for-pixel identical, and do not draw the magenta outline in your output.";

// Build the exact instruction text sent to the model for a given flow.
export function assemblePrompt({ flow, userPrompt, maskAware }: AssembleArgs): string {
  const p = userPrompt.trim();
  switch (flow) {
    case "context":
      return `Edit ONLY the region inside the magenta outline: ${p}.${CONTEXT_FRAMING_TAIL}`;
    case "isolated":
      return maskAware
        ? `${p}. ${MASK_GUIDANCE} ${SEAM_GUIDANCE}`
        : `${p}. ${SEAM_GUIDANCE}`;
    case "full":
    default:
      // The model sees the whole flattened scene and edits it freely — no region
      // framing to add, so the user's instruction stands on its own.
      return p;
  }
}
