import { NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RenderItem = {
  id: string;
  fileName: string;
  videoUrl: string;
  createdAt: string;
  sizeBytes: number;
};

export async function GET() {
  try {
    const rendersDir = path.join(process.cwd(), "public", "renders");
    const entries = await readdir(rendersDir, { withFileTypes: true });

    const mp4Files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"))
      .map((entry) => entry.name);

    const items: RenderItem[] = await Promise.all(
      mp4Files.map(async (fileName) => {
        const filePath = path.join(rendersDir, fileName);
        const fileStat = await stat(filePath);

        return {
          id: fileName.replace(/\.mp4$/i, ""),
          fileName,
          videoUrl: `/renders/${fileName}`,
          createdAt: fileStat.mtime.toISOString(),
          sizeBytes: fileStat.size
        };
      })
    );

    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return NextResponse.json({
      ok: true,
      items
    });
  } catch {
    return NextResponse.json({
      ok: true,
      items: []
    });
  }
}
