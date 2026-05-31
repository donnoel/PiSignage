import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readMediaStore,
  writeMediaStore
} from "../../../lib/local-data-store";

type RouteContext = {
  params: Promise<{
    mediaId: string;
  }>;
};

export const dynamic = "force-dynamic";

function parseTags(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 48))
    )
  );
}

export async function GET(_request: Request, context: RouteContext) {
  await ensureLocalDataFoundation();
  const { mediaId } = await context.params;
  const mediaStore = await readMediaStore();
  const item = mediaStore.items.find((candidate) => candidate.id === mediaId);

  if (!item) {
    return NextResponse.json({ error: "Media item not found." }, { status: 404 });
  }

  return NextResponse.json({ item });
}

export async function PATCH(request: Request, context: RouteContext) {
  await ensureLocalDataFoundation();
  const { mediaId } = await context.params;

  try {
    const body = (await request.json()) as {
      description?: string;
      tags?: string;
      title?: string;
    };

    const mediaStore = await readMediaStore();
    const index = mediaStore.items.findIndex((candidate) => candidate.id === mediaId);

    if (index === -1) {
      return NextResponse.json({ error: "Media item not found." }, { status: 404 });
    }

    const current = mediaStore.items[index];
    const nextTitle = typeof body.title === "string" ? body.title.trim().slice(0, 120) : current.title;
    if (!nextTitle) {
      return NextResponse.json({ error: "Title is required." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const updated = {
      ...current,
      title: nextTitle,
      description:
        typeof body.description === "string"
          ? body.description.trim().slice(0, 5000)
          : current.description,
      tags: Object.prototype.hasOwnProperty.call(body, "tags") ? parseTags(body.tags) : current.tags,
      updatedAt: now
    };

    const nextItems = [...mediaStore.items];
    nextItems[index] = updated;
    await writeMediaStore({
      ...mediaStore,
      items: nextItems,
      version: mediaStore.version + 1,
      updatedAt: now
    });

    await appendActivityRecord({
      id: randomUUID(),
      action: "media-update",
      actor: "local-operator",
      entityId: updated.id,
      entityType: "media",
      message: `Updated metadata for ${updated.playbackFileName}.`,
      result: "success",
      timestamp: now
    });

    return NextResponse.json({ item: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update media item.";
    console.error("media store update failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
