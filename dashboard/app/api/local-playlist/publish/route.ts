import { NextResponse } from "next/server";
import { ensureLivePlaylistPath, readPlaylist, writePublishStatus } from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";

export const runtime = "nodejs";

export async function POST() {
  try {
    const playlistPath = await ensureLivePlaylistPath();
    const playlist = await readPlaylist(playlistPath);
    const piPublish = await publishPlaylistToPi(playlistPath, playlist, {
      notConfigured: "Pi publish is not configured; playlist stayed local.",
      failure: "Manual publish needs attention."
    });
    await writePublishStatus("publish", playlist, piPublish);

    return NextResponse.json({
      playlistVersion: playlist.version,
      assetCount: playlist.assets.length,
      piPublish
    });
  } catch (error) {
    console.error("manual playlist publish failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed." },
      { status: 500 }
    );
  }
}
