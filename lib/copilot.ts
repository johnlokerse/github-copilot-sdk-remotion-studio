import { CopilotClient } from "@github/copilot-sdk";
import { z } from "zod";

export const fallbackModelOptions = ["gpt-5", "claude-sonnet-4.5"] as const;
const DEFAULT_STYLE_COUNT = 4;

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

const styleBriefDraftSchema = z.object({
  styleName: z.string().trim().min(1).max(80),
  styleBrief: z.string().trim().min(20).max(800)
});

export type GeneratedStyleBrief = {
  variantId: string;
  styleName: string;
  styleBrief: string;
};

export type VideoSpecGenerationSuccess = {
  status: "succeeded";
  style: GeneratedStyleBrief;
  spec: GeneratedVideoSpec;
  rawContent: string;
};

export type VideoSpecGenerationFailure = {
  status: "failed";
  style: GeneratedStyleBrief;
  error: string;
};

export type VideoSpecGenerationResult = VideoSpecGenerationSuccess | VideoSpecGenerationFailure;

const fallbackSpec: GeneratedVideoSpec = {
  title: "Generated Remotion Video",
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 300,
  inputProps: {},
  componentCode: ""
};

function getResolvedModel(model?: string): string {
  return model || process.env.COPILOT_MODEL || "gpt-5";
}

function buildStyleBriefGenerationPrompt({
  userPrompt,
  count,
  hasUploadedImage
}: {
  userPrompt: string;
  count: number;
  hasUploadedImage: boolean;
}): string {
  const promptLines = [
    "You are a creative director for Remotion video concepts.",
    `Return ONLY one JSON object with a single key: styles.`,
    `styles must be an array with exactly ${count} objects.`,
    "Each styles item must contain exactly these keys:",
    "styleName, styleBrief",
    "",
    "Rules:",
    "- styleName must be short and descriptive.",
    "- styleBrief must be a concrete production direction with motion, tone, typography, and transitions.",
    "- All styles must be clearly distinct from each other.",
    "- Keep all styles aligned to the user prompt intent.",
    "- Do not include markdown fences or extra keys.",
    ""
  ];

  if (hasUploadedImage) {
    promptLines.push(
      "Uploaded image note:",
      "- The final video variants will receive inputProps.imageDataUrl.",
      "- Include at least one sentence in each styleBrief on how to feature the uploaded image.",
      ""
    );
  }

  promptLines.push("User prompt:", userPrompt);
  return promptLines.join("\n");
}

function buildSpecGenerationPrompt({
  userPrompt,
  style,
  hasUploadedImage
}: {
  userPrompt: string;
  style: GeneratedStyleBrief;
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

  promptLines.push("Creative direction for this variant:");
  promptLines.push(`- Style name: ${style.styleName}`);
  promptLines.push(`- Style brief: ${style.styleBrief}`);
  promptLines.push("");

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

async function runCopilotPrompt({
  prompt,
  model
}: {
  prompt: string;
  model?: string;
}): Promise<string> {
  const client = new CopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
    useLoggedInUser: process.env.GITHUB_TOKEN ? false : true
  });

  let session: Awaited<ReturnType<typeof client.createSession>> | null = null;

  try {
    await client.start();

    session = await client.createSession({
      model: getResolvedModel(model)
    });

    const response = await session.sendAndWait(
      {
        prompt
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

    return content;
  } finally {
    if (session) {
      await session.destroy().catch(() => undefined);
    }

    await client.stop().catch(() => []);
  }
}

function parseStyleBriefs(content: string, count: number): GeneratedStyleBrief[] {
  const parsed = parseJsonCandidate(content);

  let rawStyles: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawStyles = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    "styles" in parsed &&
    Array.isArray((parsed as { styles?: unknown[] }).styles)
  ) {
    rawStyles = (parsed as { styles: unknown[] }).styles;
  } else {
    throw new Error('Copilot did not return a valid "styles" array.');
  }

  if (rawStyles.length !== count) {
    throw new Error(`Expected exactly ${count} styles but received ${rawStyles.length}.`);
  }

  const normalized: GeneratedStyleBrief[] = [];
  const usedStyleNames = new Set<string>();

  rawStyles.forEach((item, index) => {
    const parsedStyle = styleBriefDraftSchema.parse(item);
    const baseName = parsedStyle.styleName.trim() || `Style ${index + 1}`;
    let resolvedName = baseName;
    let suffix = 2;

    while (usedStyleNames.has(resolvedName.toLowerCase())) {
      resolvedName = `${baseName} (${suffix})`;
      suffix += 1;
    }

    usedStyleNames.add(resolvedName.toLowerCase());

    normalized.push({
      variantId: `style-${index + 1}`,
      styleName: resolvedName,
      styleBrief: parsedStyle.styleBrief
    });
  });

  return normalized;
}

export async function generateStyleBriefsWithCopilot({
  prompt,
  model,
  imageDataUrl,
  count = DEFAULT_STYLE_COUNT
}: {
  prompt: string;
  model?: string;
  imageDataUrl?: string;
  count?: number;
}): Promise<GeneratedStyleBrief[]> {
  const rawContent = await runCopilotPrompt({
    model,
    prompt: buildStyleBriefGenerationPrompt({
      userPrompt: prompt,
      count,
      hasUploadedImage: Boolean(imageDataUrl)
    })
  });

  return parseStyleBriefs(rawContent, count);
}

export async function generateVideoSpecForStyle({
  prompt,
  model,
  imageDataUrl,
  style
}: {
  prompt: string;
  model?: string;
  imageDataUrl?: string;
  style: GeneratedStyleBrief;
}): Promise<{ spec: GeneratedVideoSpec; rawContent: string }> {
  const rawContent = await runCopilotPrompt({
    model,
    prompt: buildSpecGenerationPrompt({
      userPrompt: prompt,
      style,
      hasUploadedImage: Boolean(imageDataUrl)
    })
  });

  const parsed = parseJsonCandidate(rawContent);
  const parsedSpec = normalizeSpec(generatedVideoSchema.parse(parsed));
  const spec: GeneratedVideoSpec = {
    ...parsedSpec,
    inputProps: imageDataUrl ? { ...parsedSpec.inputProps, imageDataUrl } : parsedSpec.inputProps
  };

  if (!spec.componentCode.includes("export default")) {
    throw new Error(`Generated component code is missing a default export for "${style.styleName}".`);
  }

  return { spec, rawContent };
}

export async function generateVideoSpecsForStyles({
  prompt,
  model,
  imageDataUrl,
  styles
}: {
  prompt: string;
  model?: string;
  imageDataUrl?: string;
  styles: GeneratedStyleBrief[];
}): Promise<VideoSpecGenerationResult[]> {
  const results = await Promise.all(
    styles.map(async (style): Promise<VideoSpecGenerationResult> => {
      try {
        const { spec, rawContent } = await generateVideoSpecForStyle({
          prompt,
          model,
          imageDataUrl,
          style
        });

        return {
          status: "succeeded",
          style,
          spec,
          rawContent
        };
      } catch (error) {
        return {
          status: "failed",
          style,
          error: error instanceof Error ? error.message : "Unknown error"
        };
      }
    })
  );

  return results;
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
  return generateVideoSpecForStyle({
    prompt,
    model,
    imageDataUrl,
    style: {
      variantId: "style-1",
      styleName: "Primary",
      styleBrief: "Create one polished, high-contrast, motion-forward treatment that follows the user prompt directly."
    }
  });
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
