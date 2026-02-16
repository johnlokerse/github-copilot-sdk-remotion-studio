import { CopilotClient } from "@github/copilot-sdk";
import { z } from "zod";

export const fallbackModelOptions = ["gpt-5", "claude-sonnet-4.5"] as const;

const generatedVideoSchema = z.object({
  title: z.string().min(1).max(120).default("Generated Remotion Video"),
  width: z.number().int().min(320).max(3840).default(1280),
  height: z.number().int().min(240).max(2160).default(720),
  fps: z.number().int().min(12).max(60).default(30),
  durationInFrames: z.number().int().min(45).max(1800).default(300),
  inputProps: z.record(z.unknown()).default({}),
  componentCode: z.string().min(40)
});

export type GeneratedVideoSpec = z.infer<typeof generatedVideoSchema>;

const fallbackSpec: GeneratedVideoSpec = {
  title: "Generated Remotion Video",
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 300,
  inputProps: {},
  componentCode: ""
};

function buildGenerationPrompt({
  userPrompt,
  hasUploadedImage
}: {
  userPrompt: string;
  hasUploadedImage: boolean;
}): string {
  const promptLines = [
    "You are a Remotion video generator.",
    "Return ONLY one JSON object with exactly these keys:",
    "title, width, height, fps, durationInFrames, inputProps, componentCode",
    "",
    "Rules:",
    "- componentCode must be valid TSX.",
    "- componentCode must default export a React component named GeneratedVideo.",
    "- Use only imports from react and remotion.",
    "- Do not use external URLs, file system APIs, or third-party packages.",
    "- Keep it visual, animated, and aligned to the user prompt.",
    "- Ensure syntax is valid and ready to compile.",
    "- durationInFrames should match the content timing and be between 6 and 12 seconds.",
    "- Keep visible motion throughout the full clip (no long static freeze).",
    "- Use inline styles only.",
    "- Do not wrap in markdown code fences.",
    ""
  ];

  if (hasUploadedImage) {
    promptLines.push(
      "Uploaded image requirements:",
      "- An uploaded image is available in inputProps.imageDataUrl (data URL).",
      "- The component must read imageDataUrl from props and render it visibly in the video.",
      "- Use Img from remotion or an img element with src={imageDataUrl}.",
      "- Keep the image on screen long enough to be clearly visible.",
      "- Do not add extra thumbnail/watermark-style overlays unless explicitly requested.",
      ""
    );
  }

  promptLines.push("User prompt:", userPrompt);
  return promptLines.join("\n");
}

function parseJsonCandidate(content: string): unknown {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with fallback extraction.
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenceRegex)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error("Copilot did not return parseable JSON.");
}

function normalizeSpec(spec: GeneratedVideoSpec): GeneratedVideoSpec {
  const normalizedFps = Math.max(12, Math.min(60, spec.fps || fallbackSpec.fps));
  const minSeconds = 6;
  const normalizedDuration = Math.max(
    45,
    Math.min(1800, spec.durationInFrames || fallbackSpec.durationInFrames),
    Math.ceil(normalizedFps * minSeconds)
  );

  return {
    title: spec.title || fallbackSpec.title,
    width: Math.max(320, Math.min(3840, spec.width || fallbackSpec.width)),
    height: Math.max(240, Math.min(2160, spec.height || fallbackSpec.height)),
    fps: normalizedFps,
    durationInFrames: normalizedDuration,
    inputProps: spec.inputProps || {},
    componentCode: spec.componentCode
  };
}

function extractAssistantContent(rawResponse: unknown): string {
  if (!rawResponse) return "";

  if (
    typeof rawResponse === "object" &&
    rawResponse !== null &&
    "data" in rawResponse &&
    typeof (rawResponse as { data?: { content?: unknown } }).data?.content === "string"
  ) {
    return (rawResponse as { data: { content: string } }).data.content;
  }

  return "";
}

export async function generateVideoSpecWithCopilot({
  prompt,
  model,
  imageDataUrl
}: {
  prompt: string;
  model?: string;
  imageDataUrl?: string;
}): Promise<{ spec: GeneratedVideoSpec; rawContent: string }> {
  const client = new CopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
    useLoggedInUser: process.env.GITHUB_TOKEN ? false : true
  });

  let session: Awaited<ReturnType<typeof client.createSession>> | null = null;

  try {
    await client.start();

    session = await client.createSession({
      model: model || process.env.COPILOT_MODEL || "gpt-5"
    });

    const response = await session.sendAndWait(
      {
        prompt: buildGenerationPrompt({
          userPrompt: prompt,
          hasUploadedImage: Boolean(imageDataUrl)
        })
      },
      4 * 60 * 1000
    );

    let content = extractAssistantContent(response);

    if (!content) {
      const messages = await session.getMessages();
      const lastAssistantMessage = [...messages]
        .reverse()
        .find((message) => message.type === "assistant.message");

      if (
        lastAssistantMessage &&
        "data" in lastAssistantMessage &&
        typeof lastAssistantMessage.data?.content === "string"
      ) {
        content = lastAssistantMessage.data.content;
      }
    }

    if (!content) {
      throw new Error("Copilot did not return any content.");
    }

    const parsed = parseJsonCandidate(content);
    const parsedSpec = normalizeSpec(generatedVideoSchema.parse(parsed));
    const spec: GeneratedVideoSpec = {
      ...parsedSpec,
      inputProps: imageDataUrl ? { ...parsedSpec.inputProps, imageDataUrl } : parsedSpec.inputProps
    };

    if (!spec.componentCode.includes("export default")) {
      throw new Error("Generated component code is missing a default export.");
    }

    return { spec, rawContent: content };
  } finally {
    if (session) {
      await session.destroy().catch(() => undefined);
    }

    await client.stop().catch(() => []);
  }
}

export async function listAvailableCopilotModels(): Promise<string[]> {
  const client = new CopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
    useLoggedInUser: process.env.GITHUB_TOKEN ? false : true
  });

  try {
    await client.start();
    const models = await client.listModels();
    const ids = models
      .map((modelInfo) => modelInfo.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    return ids.length > 0 ? ids : [...fallbackModelOptions];
  } finally {
    await client.stop().catch(() => []);
  }
}
