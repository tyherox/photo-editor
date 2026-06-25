import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { apiKey, model, prompt, image, mimeType, referenceImage, referenceMimeType, mode, contextHintImage, rawPrompt, maskImage, maskMimeType } = body;

  if (!apiKey) {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }
  if (!prompt || !image) {
    return NextResponse.json({ error: "Prompt and image are required" }, { status: 400 });
  }

  const geminiModel = model || "gemini-2.5-flash-image";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  let parts: Array<Record<string, unknown>>;

  // `prompt` is the fully-assembled instruction the client built and showed the
  // user (rawPrompt). For older/raw callers we fall back to the legacy wrapping so
  // behavior is unchanged when the flag is absent.
  if (mode === "context" && contextHintImage) {
    // Context-aware region edit: the model sees the whole scene plus a copy with
    // the edit region outlined, and is told to change only that region. The
    // client composites just the masked pixels back, so the rest is protected.
    const instruction = rawPrompt
      ? prompt
      : `Edit ONLY the region inside the magenta outline: ${prompt}. ` +
        `Use the rest of the image as context so the edit matches the scene's ` +
        `lighting, color, perspective, and style. Leave everything outside the ` +
        `outline pixel-for-pixel identical, and do not draw the magenta outline ` +
        `in your output.`;
    parts = [
      { text: "Image to edit:" },
      { inline_data: { mime_type: mimeType || "image/png", data: image } },
      { text: "The region to edit is outlined in magenta in this copy:" },
      { inline_data: { mime_type: "image/png", data: contextHintImage } },
      { text: instruction },
    ];
    if (referenceImage) {
      parts.push(
        { text: "Reference image:" },
        { inline_data: { mime_type: referenceMimeType || "image/png", data: referenceImage } }
      );
    }
  } else if (referenceImage || maskImage) {
    parts = [
      { text: "Image to edit:" },
      { inline_data: { mime_type: mimeType || "image/png", data: image } },
    ];
    if (maskImage) {
      parts.push(
        { text: "Mask (white marks the area to change, black is off-limits):" },
        { inline_data: { mime_type: maskMimeType || "image/png", data: maskImage } }
      );
    }
    if (referenceImage) {
      parts.push(
        { text: "Reference image:" },
        { inline_data: { mime_type: referenceMimeType || "image/png", data: referenceImage } }
      );
    }
    parts.push({ text: rawPrompt ? prompt : `Instructions: ${prompt}` });
  } else {
    parts = [
      { text: prompt },
      {
        inline_data: {
          mime_type: mimeType || "image/png",
          data: image,
        },
      },
    ];
  }

  const geminiBody = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const geminiRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    let errorMessage = `Gemini API error: ${geminiRes.status}`;
    try {
      const errJson = JSON.parse(errText);
      errorMessage = errJson.error?.message || errorMessage;
    } catch {
      // use default message
    }
    return NextResponse.json({ error: errorMessage }, { status: geminiRes.status });
  }

  const data = await geminiRes.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    return NextResponse.json({ error: "No response from Gemini" }, { status: 500 });
  }

  let resultImage = "";
  let resultMimeType = "image/png";
  let resultText = "";

  for (const part of candidate.content?.parts || []) {
    if (part.inlineData) {
      resultImage = part.inlineData.data;
      resultMimeType = part.inlineData.mimeType || "image/png";
    }
    if (part.text) {
      resultText = part.text;
    }
  }

  if (!resultImage) {
    return NextResponse.json(
      { error: resultText || "Gemini did not return an image" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    image: resultImage,
    mimeType: resultMimeType,
    text: resultText,
  });
}
