import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { apiKey, model, prompt, image, mimeType, referenceImage, referenceMimeType } = body;

  if (!apiKey) {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }
  if (!prompt || !image) {
    return NextResponse.json({ error: "Prompt and image are required" }, { status: 400 });
  }

  const geminiModel = model || "gemini-2.5-flash-image";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  let parts: Array<Record<string, unknown>>;

  if (referenceImage) {
    parts = [
      { text: "Image to edit:" },
      {
        inline_data: {
          mime_type: mimeType || "image/png",
          data: image,
        },
      },
      { text: "Reference image:" },
      {
        inline_data: {
          mime_type: referenceMimeType || "image/png",
          data: referenceImage,
        },
      },
      { text: `Instructions: ${prompt}` },
    ];
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
