import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  prompt: z.string().trim().min(10).max(2000),
  model: z.string().trim().min(1).max(100).optional(),
  variantCount: z.union([z.literal(1), z.literal(4)]).optional(),
  imageDataUrl: z
    .union([
      z
        .string()
        .max(10_000_000)
        .refine((value) => /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(value), "Unsupported image format."),
      z.null()
    ])
    .optional()
});

type ServerLogEntry = {
  at: string;
  step: string;
  detail?: string;
};

type VariantSuccessResponse = {
  variantId: string;
  styleName: string;
  styleBrief: string;
  status: "succeeded";
  jobId: string;
  videoUrl: string;
  metadata: {
    title: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
  };
};

type VariantFailureResponse = {
  variantId: string;
  styleName: string;
  styleBrief: string;
  status: "failed";
  error: string;
};

type VariantResponse = VariantSuccessResponse | VariantFailureResponse;

export async function POST(request: Request) {
  const requestId = randomUUID();
  const logs: ServerLogEntry[] = [];
  const log = (step: string, detail?: string) => {
    logs.push({
      at: new Date().toISOString(),
      step,
      ...(detail ? { detail } : {})
    });
  };

  try {
    log("request.received", `requestId=${requestId}`);

    log("module.load.start", "Loading Copilot and Remotion modules");
    const [{ generateStyleBriefsWithCopilot, generateVideoSpecsForStyles }, { renderRemotionVideoVariants }] = await Promise.all([
      import("@/lib/copilot"),
      import("@/lib/remotion")
    ]);
    log("module.load.done");

    log("request.parse.start");
    const body = await request.json();
    const { prompt, model, variantCount, imageDataUrl } = requestSchema.parse(body);
    const normalizedImageDataUrl = imageDataUrl ?? undefined;
    const resolvedVariantCount = variantCount ?? 1;
    log(
      "request.parse.done",
      `Prompt length: ${prompt.length}. Image attached: ${normalizedImageDataUrl ? "yes" : "no"}. Variants: ${resolvedVariantCount}`
    );

    log("copilot.styles.generate.start", `Model: ${model || process.env.COPILOT_MODEL || "gpt-5"}`);
    const styleBriefs = await generateStyleBriefsWithCopilot({
      prompt,
      model,
      imageDataUrl: normalizedImageDataUrl,
      count: resolvedVariantCount
    });
    log("copilot.styles.generate.done", styleBriefs.map((style) => style.styleName).join(" | "));

    for (const [index, style] of styleBriefs.entries()) {
      log(`copilot.variant.${index + 1}.generate.start`, style.styleName);
    }

    const specResults = await generateVideoSpecsForStyles({
      prompt,
      model,
      imageDataUrl: normalizedImageDataUrl,
      styles: styleBriefs
    });

    for (const [index, result] of specResults.entries()) {
      if (result.status === "succeeded") {
        log(
          `copilot.variant.${index + 1}.generate.done`,
          `${result.spec.width}x${result.spec.height} @ ${result.spec.fps}fps, ${result.spec.durationInFrames} frames`
        );
      } else {
        log(`copilot.variant.${index + 1}.generate.failed`, result.error);
      }
    }

    const renderInputs = specResults
      .filter((result) => result.status === "succeeded")
      .map((result) => {
        log(`remotion.variant.${result.style.variantId.replace("style-", "")}.render.start`, result.style.styleName);
        return {
          requestId,
          variantId: result.style.variantId,
          styleName: result.style.styleName,
          spec: result.spec
        };
      });

    const renderResults = await renderRemotionVideoVariants(renderInputs);

    const renderResultByVariantId = new Map(renderResults.map((result) => [result.variantId, result] as const));
    renderResults.forEach((result) => {
      const variantNumber = result.variantId.replace("style-", "");
      if (result.status === "succeeded") {
        log(`remotion.variant.${variantNumber}.render.done`, `jobId=${result.jobId}`);
      } else {
        log(`remotion.variant.${variantNumber}.render.failed`, result.error);
      }
    });

    const specResultByVariantId = new Map(specResults.map((result) => [result.style.variantId, result] as const));

    const variants: VariantResponse[] = styleBriefs.map((styleBrief) => {
      const specResult = specResultByVariantId.get(styleBrief.variantId);
      if (!specResult) {
        return {
          variantId: styleBrief.variantId,
          styleName: styleBrief.styleName,
          styleBrief: styleBrief.styleBrief,
          status: "failed",
          error: "Video spec generation did not return a result."
        };
      }

      if (specResult.status === "failed") {
        return {
          variantId: styleBrief.variantId,
          styleName: styleBrief.styleName,
          styleBrief: styleBrief.styleBrief,
          status: "failed",
          error: specResult.error
        };
      }

      const renderResult = renderResultByVariantId.get(styleBrief.variantId);
      if (!renderResult || renderResult.status === "failed") {
        return {
          variantId: styleBrief.variantId,
          styleName: styleBrief.styleName,
          styleBrief: styleBrief.styleBrief,
          status: "failed",
          error: renderResult?.error || "Render did not complete for this style."
        };
      }

      return {
        variantId: styleBrief.variantId,
        styleName: styleBrief.styleName,
        styleBrief: styleBrief.styleBrief,
        status: "succeeded",
        jobId: renderResult.jobId,
        videoUrl: renderResult.videoUrl,
        metadata: renderResult.metadata
      };
    });

    const successfulVariants = variants.filter((variant): variant is VariantSuccessResponse => variant.status === "succeeded");
    const firstSuccessfulVariant = successfulVariants[0];

    if (!firstSuccessfulVariant) {
      return NextResponse.json(
        {
          ok: false,
          requestId,
          error: "All style variants failed to render.",
          variants,
          logs
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        requestId,
        jobId: firstSuccessfulVariant.jobId,
        videoUrl: firstSuccessfulVariant.videoUrl,
        metadata: firstSuccessfulVariant.metadata,
        variants,
        logs
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      log("request.parse.failed", error.issues[0]?.message || "Invalid request payload.");

      return NextResponse.json(
        {
          ok: false,
          requestId,
          error: error.issues[0]?.message || "Invalid request payload.",
          logs
        },
        { status: 400 }
      );
    }

    log("request.failed", error instanceof Error ? error.message : "Unknown error");

    console.error("/api/generate error:", error);

    const message = error instanceof Error ? error.message : "Unknown error";
    const payload: { ok: false; error: string; logs: ServerLogEntry[]; requestId: string; stack?: string } = {
      ok: false,
      error: message,
      requestId,
      logs
    };

    if (process.env.NODE_ENV !== "production" && error instanceof Error && error.stack) {
      payload.stack = error.stack;
    }

    return NextResponse.json(payload, { status: 500 });
  }
}
