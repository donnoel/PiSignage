import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readMediaFolderStore,
  readMediaStore,
  writeMediaFolderStore
} from "../../lib/local-data-store";
import { readPlaylistStore } from "../../lib/local-playlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeFolderName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

function normalizeFolderId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return typeof value === "string" ? value : "";
}

async function knownMediaIds(): Promise<Set<string>> {
  const [mediaStore, playlistStore] = await Promise.all([readMediaStore(), readPlaylistStore()]);
  const ids = new Set(mediaStore.items.map((item) => item.id));

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      if (asset.uri.startsWith("assets/")) {
        ids.add(`playlist:${asset.assetId}`);
      }
    }
  }

  return ids;
}

export async function GET() {
  await ensureLocalDataFoundation();
  const folderStore = await readMediaFolderStore();

  return NextResponse.json({
    assignments: folderStore.assignments,
    folders: folderStore.items,
    updatedAt: folderStore.updatedAt,
    version: folderStore.version
  });
}

export async function POST(request: Request) {
  await ensureLocalDataFoundation();

  try {
    const body = (await request.json()) as { name?: string };
    const name = normalizeFolderName(body.name);
    if (!name) {
      return NextResponse.json({ error: "Folder name is required." }, { status: 400 });
    }

    const folderStore = await readMediaFolderStore();
    if (folderStore.items.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      return NextResponse.json({ error: "A folder with that name already exists." }, { status: 409 });
    }

    const now = new Date().toISOString();
    const folder = {
      id: `folder-${randomUUID()}`,
      name,
      createdAt: now,
      updatedAt: now
    };

    await writeMediaFolderStore({
      ...folderStore,
      items: [...folderStore.items, folder].sort((a, b) => a.name.localeCompare(b.name)),
      updatedAt: now,
      version: folderStore.version + 1
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-folder-create",
      actor: "local-operator",
      entityId: folder.id,
      entityType: "media",
      message: `Created media folder ${folder.name}.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create folder.";
    console.error("media folder create failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  await ensureLocalDataFoundation();

  try {
    const body = (await request.json()) as {
      folderId?: string | null;
      mediaIds?: unknown;
    };
    const mediaIds = Array.isArray(body.mediaIds)
      ? Array.from(new Set(body.mediaIds.filter((id): id is string => typeof id === "string")))
      : [];
    if (mediaIds.length === 0) {
      return NextResponse.json({ error: "Choose media to move." }, { status: 400 });
    }

    const folderStore = await readMediaFolderStore();
    const folderId = normalizeFolderId(body.folderId);
    const folder = folderId ? folderStore.items.find((candidate) => candidate.id === folderId) : null;
    if (folderId && !folder) {
      return NextResponse.json({ error: "Folder not found." }, { status: 404 });
    }

    const knownIds = await knownMediaIds();
    const unknownId = mediaIds.find((mediaId) => !knownIds.has(mediaId));
    if (unknownId) {
      return NextResponse.json({ error: `Media item ${path.basename(unknownId)} was not found.` }, { status: 404 });
    }

    const now = new Date().toISOString();
    const assignments = { ...folderStore.assignments };
    for (const mediaId of mediaIds) {
      if (folderId) {
        assignments[mediaId] = folderId;
      } else {
        delete assignments[mediaId];
      }
    }

    await writeMediaFolderStore({
      ...folderStore,
      assignments,
      updatedAt: now,
      version: folderStore.version + 1
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-folder-move",
      actor: "local-operator",
      entityId: folderId ?? "unfiled",
      entityType: "media",
      message: `Moved ${mediaIds.length} media item${mediaIds.length === 1 ? "" : "s"} to ${folder?.name ?? "Unfiled"}.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ assignments, folderId, moved: mediaIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not move media.";
    console.error("media folder assignment failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
