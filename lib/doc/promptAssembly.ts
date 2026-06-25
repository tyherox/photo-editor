// Single source of truth for the FULL instruction text the model receives, so
// the "Advanced" preview can show (and let the user edit) exactly what is sent.
// The API route sends this output verbatim (`rawPrompt: true`) and only owns the
// structural image captions ("Image to edit:", "Reference image:", …).
//
// NOTE: this deliberately does NOT attach a mask or add mask-region guidance —
// that confused isolated edits. It only assembles the text instruction.

export type EditFlow = "isolated" | "context" | "full";

export interface AssembleArgs {
  flow: EditFlow;
  userPrompt: string;
  // True when a reference image is also being sent — adds wording that names
  // which image is the canvas and which is the reference, so the model doesn't
  // confuse the two (captions alone are a weak signal).
  hasReference: boolean;
}

// Seam-blending guidance for isolated crops. Domain-agnostic and non-overriding:
// it must NOT pin colors/lighting/style, which would countermand legitimate
// recolor/relight/restyle edits.
export const SEAM_GUIDANCE =
  "Apply only the change described in the instruction, and blend it seamlessly " +
  "into the surrounding image so the edited region's edges have no visible seams.";

// Names the two images by their captions so the model edits the canvas and treats
// the reference as guidance only — not as something to reproduce or edit.
export const REFERENCE_NOTE =
  "Two images are provided: modify the image labeled \"Image to edit\"; the image " +
  "labeled \"Reference image\" is only a visual reference for this instruction — " +
  "do not edit it or return it as the output.";

const CONTEXT_FRAMING_TAIL =
  " Use the rest of the image as context so the edit matches the scene's lighting, " +
  "color, perspective, and style. Leave everything outside the outline " +
  "pixel-for-pixel identical, and do not draw the magenta outline in your output.";

// Build the exact instruction text sent to the model for a given flow.
export function assemblePrompt({ flow, userPrompt, hasReference }: AssembleArgs): string {
  const p = userPrompt.trim();
  const ref = hasReference ? ` ${REFERENCE_NOTE}` : "";
  switch (flow) {
    case "context":
      return `Edit ONLY the region inside the magenta outline: ${p}.${ref}${CONTEXT_FRAMING_TAIL}`;
    case "isolated":
      return `${p}. ${SEAM_GUIDANCE}${ref}`;
    case "full":
    default:
      return `${p}${ref}`;
  }
}
