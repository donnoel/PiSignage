import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  readStoredPlaylist,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      playlistId?: string;
    };
    const { playlist } = await readStoredPlaylist(body.playlistId);
    if (playlist.assets.length === 0) {
      return NextResponse.json(
        { error: "Add media before publishing this playlist." },
        { status: 400 }
      );
    }

    const playlistPath = await ensureLivePlaylistPath();
    await writePlaylist(playlistPath, playlist);
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
