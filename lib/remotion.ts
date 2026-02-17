import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GeneratedVideoSpec } from "@/lib/copilot";

type RenderResult = {
  jobId: string;
  videoUrl: string;
  outputPath: string;
};

export type RenderVariantInput = {
  requestId: string;
  variantId: string;
  styleName: string;
  spec: GeneratedVideoSpec;
};

export type RenderVariantSuccess = {
  status: "succeeded";
  variantId: string;
  styleName: string;
  jobId: string;
  videoUrl: string;
  outputPath: string;
  metadata: {
    title: string;
    width: number;
    height: number;
    fps: number;
    durationInFrames: number;
  };
};

export type RenderVariantFailure = {
  status: "failed";
  variantId: string;
  styleName: string;
  error: string;
};

export type RenderVariantResult = RenderVariantSuccess | RenderVariantFailure;

const COMPOSITION_ID = "GeneratedVideo";

function buildRootFile(spec: GeneratedVideoSpec): string {
  return `import React from "react";
import { Composition } from "remotion";
import GeneratedVideo from "./GeneratedVideo";

const defaultProps = ${JSON.stringify(spec.inputProps, null, 2)};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="${COMPOSITION_ID}"
      component={GeneratedVideo}
      durationInFrames={${spec.durationInFrames}}
      fps={${spec.fps}}
      width={${spec.width}}
      height={${spec.height}}
      defaultProps={defaultProps}
    />
  );
};
`;
}

const entryFile = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
`;

function toSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "style";
}

export async function renderRemotionVideoVariant(input: RenderVariantInput): Promise<RenderVariantSuccess> {
  const slug = toSlug(input.styleName);
  const jobId = `${input.requestId}-${input.variantId}-${slug}`;
  const jobsDir = path.join(process.cwd(), ".generated", "jobs", input.requestId, input.variantId);
  const entryPoint = path.join(jobsDir, "index.ts");
  const rootFile = path.join(jobsDir, "Root.tsx");
  const componentFile = path.join(jobsDir, "GeneratedVideo.tsx");

  await mkdir(jobsDir, { recursive: true });
  await mkdir(path.join(process.cwd(), "public", "renders"), { recursive: true });

  await Promise.all([
    writeFile(entryPoint, entryFile, "utf8"),
    writeFile(rootFile, buildRootFile(input.spec), "utf8"),
    writeFile(componentFile, input.spec.componentCode, "utf8")
  ]);

  const bundled = await bundle({
    entryPoint,
    onProgress: () => undefined,
    ignoreRegisterRootWarning: true
  });

  const composition = await selectComposition({
    id: COMPOSITION_ID,
    serveUrl: bundled,
    inputProps: input.spec.inputProps
  });

  const outputPath = path.join(process.cwd(), "public", "renders", `${jobId}.mp4`);

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: input.spec.inputProps,
    overwrite: true,
    logLevel: "error"
  });

  return {
    status: "succeeded",
    variantId: input.variantId,
    styleName: input.styleName,
    jobId,
    videoUrl: `/renders/${jobId}.mp4`,
    outputPath,
    metadata: {
      title: input.spec.title,
      width: input.spec.width,
      height: input.spec.height,
      fps: input.spec.fps,
      durationInFrames: input.spec.durationInFrames
    }
  };
}

export async function renderRemotionVideoVariants(variants: RenderVariantInput[]): Promise<RenderVariantResult[]> {
  const results = await Promise.all(
    variants.map(async (variant): Promise<RenderVariantResult> => {
      try {
        return await renderRemotionVideoVariant(variant);
      } catch (error) {
        return {
          status: "failed",
          variantId: variant.variantId,
          styleName: variant.styleName,
          error: error instanceof Error ? error.message : "Unknown render error"
        };
      }
    })
  );

  return results;
}

export async function renderRemotionVideo(spec: GeneratedVideoSpec): Promise<RenderResult> {
  const requestId = randomUUID();
  const variantResult = await renderRemotionVideoVariant({
    requestId,
    variantId: "style-1",
    styleName: "Primary",
    spec
  });

  return {
    jobId: variantResult.jobId,
    videoUrl: variantResult.videoUrl,
    outputPath: variantResult.outputPath
  };
}
