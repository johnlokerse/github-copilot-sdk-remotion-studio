import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fallbackModelOptions = ["gpt-5", "claude-sonnet-4.5"];

export async function GET() {
  try {
    const { listAvailableCopilotModels } = await import("@/lib/copilot");
    const models = await listAvailableCopilotModels();

    return NextResponse.json({
      ok: true,
      models
    });
  } catch (error) {
    console.error("/api/models error:", error);

    return NextResponse.json({
      ok: true,
      models: [...fallbackModelOptions]
    });
  }
}
