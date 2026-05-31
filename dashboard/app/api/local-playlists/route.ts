import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appendActivityRecord } from "../../lib/local-data-store";
import { readPlaylistStore, writePlaylistStore } from "../../lib/local-playlist";
import type { Playlist } from "../../lib/local-playlist";
import { slugify } from "../../lib/media-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nowIso(): string {
  return new Date().toISOString();
}

function uniquePlaylistId(name: string, existingIds: Set<string>): string {
  const baseId = `playlist-${slugify(name) || "new-loop"}`;
  let playlistId = baseId;
  let suffix = 1;

  while (existingIds.has(playlistId)) {
    playlistId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return playlistId;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
    };
    const name = body.name?.trim().slice(0, 80);

    if (!name) {
      return NextResponse.json({ error: "Enter a playlist name." }, { status: 400 });
    }

    const store = await readPlaylistStore();
    const timestamp = nowIso();
    const playlist: Playlist = {
      playlistId: uniquePlaylistId(name, new Set(store.items.map((item) => item.playlistId))),
      name,
      version: 1,
      updatedAt: timestamp,
      assets: []
    };

    await writePlaylistStore({
      ...store,
      items: [...store.items, playlist],
      updatedAt: timestamp,
      version: store.version + 1
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "playlist-create",
      actor: "local-operator",
      entityId: playlist.playlistId,
      entityType: "playlist",
      message: `Created playlist ${playlist.name}.`,
      result: "success",
      timestamp
    });

    return NextResponse.json({ playlist });
  } catch (error) {
    console.error("playlist create failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Playlist create failed." },
      { status: 500 }
    );
  }
}
