import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  readPlaylist,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import type { Playlist } from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";

type PlaylistEditAction = "move-up" | "move-down" | "remove";

export const runtime = "nodejs";

function updatePlaylist(playlist: Playlist, action: PlaylistEditAction, assetId: string): Playlist {
  const index = playlist.assets.findIndex((asset) => asset.assetId === assetId);

  if (index === -1) {
    throw new Error("Playlist item was not found.");
  }

  const assets = [...playlist.assets];

  if (action === "remove") {
    if (assets.length <= 1) {
      throw new Error("At least one playlist item is required.");
    }

    assets.splice(index, 1);
  } else if (action === "move-up") {
    if (index === 0) {
      throw new Error("Playlist item is already first.");
    }

    [assets[index - 1], assets[index]] = [assets[index], assets[index - 1]];
  } else if (action === "move-down") {
    if (index === assets.length - 1) {
      throw new Error("Playlist item is already last.");
    }

    [assets[index], assets[index + 1]] = [assets[index + 1], assets[index]];
  }

  return {
    ...playlist,
    version: playlist.version + 1,
    updatedAt: new Date().toISOString(),
    assets
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string; assetId?: string };

    if (
      body.action !== "move-up" &&
      body.action !== "move-down" &&
      body.action !== "remove"
    ) {
      return NextResponse.json({ error: "Unsupported playlist action." }, { status: 400 });
    }

    if (!body.assetId) {
      return NextResponse.json({ error: "Missing playlist item." }, { status: 400 });
    }

    const playlistPath = await ensureLivePlaylistPath();
    const playlist = await readPlaylist(playlistPath);
    const nextPlaylist = updatePlaylist(playlist, body.action, body.assetId);

    await writePlaylist(playlistPath, nextPlaylist);
    const piPublish = await publishPlaylistToPi(playlistPath, nextPlaylist, {
      notConfigured: "Pi publish is not configured; playlist was updated locally only.",
      failure: "Playlist was updated locally, but Pi publish failed. Check Pi connectivity."
    });
    await writePublishStatus(body.action, nextPlaylist, piPublish);

    return NextResponse.json({
      playlistVersion: nextPlaylist.version,
      assetCount: nextPlaylist.assets.length,
      piPublish
    });
  } catch (error) {
    console.error("local playlist edit failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Playlist edit failed." },
      { status: 500 }
    );
  }
}
