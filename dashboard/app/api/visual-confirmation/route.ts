import { NextResponse } from "next/server";
import { localStateDirectory, writeFileAtomic } from "../../lib/local-playlist";
import { readPiConfig } from "../../lib/pi-local";

export const dynamic = "force-dynamic";

function visualConfirmationPath(): string {
  return `${localStateDirectory()}/visual-confirmation.json`;
}

export async function POST() {
  const config = readPiConfig();

  if (!config?.host) {
    return NextResponse.json({ error: "Pi host is not configured." }, { status: 400 });
  }

  const confirmedAt = new Date().toISOString();
  await writeFileAtomic(
    visualConfirmationPath(),
    `${JSON.stringify({ confirmedAt, host: config.host }, null, 2)}\n`
  );

  return NextResponse.json({
    confirmedAt,
    message: "Visual check saved."
  });
}
