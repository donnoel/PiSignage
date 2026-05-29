import { NextResponse } from "next/server";
import { readPiConfig, runSsh } from "../../../lib/pi-local";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string };

    if (body.action !== "restart-vlc") {
      return NextResponse.json({ error: "Unsupported player action." }, { status: 400 });
    }

    const config = readPiConfig();
    if (!config) {
      return NextResponse.json({ error: "Pi SSH is not configured." }, { status: 400 });
    }

    await runSsh(config, "systemctl --user restart pisignage-vlc.service", { timeoutMs: 30_000 });

    return NextResponse.json({
      message: `Restarted VLC field player on ${config.host}.`
    });
  } catch (error) {
    console.error("local player action failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Player action failed." },
      { status: 500 }
    );
  }
}
