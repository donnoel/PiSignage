import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation
} from "../../../lib/local-data-store";
import { readMediaFolderStore, writeMediaFolderStore } from "../../../lib/media-folder-store";

type RouteContext = {
  params: Promise<{
    folderId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: RouteContext) {
  await ensureLocalDataFoundation();
  const { folderId } = await context.params;

  try {
    const folderStore = await readMediaFolderStore();
    const folder = folderStore.items.find((candidate) => candidate.id === folderId);
    if (!folder) {
      return NextResponse.json({ error: "Folder not found." }, { status: 404 });
    }

    const now = new Date().toISOString();
    const assignments = { ...folderStore.assignments };
    for (const [mediaId, assignedFolderId] of Object.entries(assignments)) {
      if (assignedFolderId === folderId) {
        delete assignments[mediaId];
      }
    }

    await writeMediaFolderStore({
      ...folderStore,
      assignments,
      items: folderStore.items.filter((candidate) => candidate.id !== folderId),
      updatedAt: now,
      version: folderStore.version + 1
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-folder-delete",
      actor: "local-operator",
      entityId: folder.id,
      entityType: "media",
      message: `Removed media folder ${folder.name}.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ deleted: true, folder });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not remove folder.";
    console.error("media folder delete failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
