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

export async function renderRemotionVideo(spec: GeneratedVideoSpec): Promise<RenderResult> {
  const jobId = randomUUID();
  const jobsDir = path.join(process.cwd(), ".generated", "jobs", jobId);
  const entryPoint = path.join(jobsDir, "index.ts");
  const rootFile = path.join(jobsDir, "Root.tsx");
  const componentFile = path.join(jobsDir, "GeneratedVideo.tsx");

  await mkdir(jobsDir, { recursive: true });
  await mkdir(path.join(process.cwd(), "public", "renders"), { recursive: true });

  await Promise.all([
    writeFile(entryPoint, entryFile, "utf8"),
    writeFile(rootFile, buildRootFile(spec), "utf8"),
    writeFile(componentFile, spec.componentCode, "utf8")
  ]);

  const bundled = await bundle({
    entryPoint,
    onProgress: () => undefined,
    ignoreRegisterRootWarning: true
  });

  const composition = await selectComposition({
    id: COMPOSITION_ID,
    serveUrl: bundled,
    inputProps: spec.inputProps
  });

  const outputPath = path.join(process.cwd(), "public", "renders", `${jobId}.mp4`);

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: spec.inputProps,
    overwrite: true,
    logLevel: "error"
  });

  return {
    jobId,
    videoUrl: `/renders/${jobId}.mp4`,
    outputPath
  };
}
