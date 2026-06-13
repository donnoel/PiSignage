import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  ensureLocalDataFoundation,
  readLayoutStore,
  readMediaStore,
  writeLayoutStore
} from "../../lib/local-data-store";
import { apiErrorResponse } from "../../lib/api-error-response";
import {
  defaultLayoutCanvas,
  layoutContractVersion,
  validateLayoutTemplate
} from "../../lib/layout-contract";
import type { LayoutLayer, LayoutTemplate } from "../../lib/layout-contract";
import { readPlaylistStore } from "../../lib/local-playlist";
import { slugify } from "../../lib/media-processing";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultLayoutDurationSeconds = 30;

class LayoutApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type LayoutInput = {
  canvas?: unknown;
  durationSeconds?: unknown;
  id?: unknown;
  layers?: unknown;
  layoutId?: unknown;
  name?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readLayoutInput(request: Request): Promise<LayoutInput> {
  const input = await request.json();
  if (!isRecord(input)) {
    throw new LayoutApiError("Layout request body must be an object.");
  }

  return input;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 120) : "";
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueLayoutId(name: string, existingIds: Set<string>): string {
  const baseId = `layout-${slugify(name) || "template"}`;
  let layoutId = baseId;
  let suffix = 1;

  while (existingIds.has(layoutId)) {
    layoutId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return layoutId;
}

function notRendered(reason: string): LayoutTemplate["render"] {
  return {
    reason,
    status: "not-rendered"
  };
}

function validationError(template: unknown): LayoutApiError | null {
  const result = validateLayoutTemplate(template);
  if (result.ok) {
    return null;
  }

  return new LayoutApiError(result.errors.join(" "), 400);
}

function mediaLayerIds(layers: LayoutLayer[]): string[] {
  return layers.flatMap((layer) => (layer.kind === "media" ? [layer.mediaId] : []));
}

async function knownLayoutMediaIds(): Promise<Set<string>> {
  const [mediaStore, playlistStore] = await Promise.all([readMediaStore(), readPlaylistStore()]);
  const ids = new Set(
    mediaStore.items
      .filter((item) => item.status === "ready")
      .map((item) => item.id)
  );

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      if (asset.uri.startsWith("assets/")) {
        ids.add(`playlist:${asset.assetId}`);
      }
    }
  }

  return ids;
}

async function assertKnownMediaReferences(template: LayoutTemplate): Promise<void> {
  const referencedMediaIds = mediaLayerIds(template.layers);
  if (referencedMediaIds.length === 0) {
    return;
  }

  const knownIds = await knownLayoutMediaIds();
  const missingId = referencedMediaIds.find((mediaId) => !knownIds.has(mediaId));
  if (missingId) {
    throw new LayoutApiError(`Layout media item ${missingId} was not found or is not ready.`, 404);
  }
}

function layoutNameExists(
  layouts: LayoutTemplate[],
  name: string,
  exceptLayoutId?: string
): boolean {
  const normalizedName = name.toLowerCase();
  return layouts.some(
    (layout) =>
      layout.id !== exceptLayoutId &&
      layout.name.trim().toLowerCase() === normalizedName
  );
}

function createTemplate(input: LayoutInput, storeLayouts: LayoutTemplate[]): LayoutTemplate {
  const name = normalizeName(input.name);
  if (!name) {
    throw new LayoutApiError("Layout name is required.");
  }

  if (layoutNameExists(storeLayouts, name)) {
    throw new LayoutApiError("A layout with that name already exists.", 409);
  }

  const timestamp = nowIso();
  const template = {
    canvas: input.canvas ?? { ...defaultLayoutCanvas },
    contractVersion: layoutContractVersion,
    durationSeconds:
      input.durationSeconds === undefined ? defaultLayoutDurationSeconds : input.durationSeconds,
    id: uniqueLayoutId(name, new Set(storeLayouts.map((layout) => layout.id))),
    layers: input.layers,
    name,
    render: notRendered("Saved locally. Render to MP4 before playlist use."),
    updatedAt: timestamp,
    version: 1
  };

  const error = validationError(template);
  if (error) {
    throw error;
  }

  return template as LayoutTemplate;
}

function updateTemplate(previous: LayoutTemplate, input: LayoutInput, storeLayouts: LayoutTemplate[]): LayoutTemplate {
  const rawInput = input as Record<string, unknown>;
  const hasNameChange = hasOwn(rawInput, "name");
  const hasCanvasChange = hasOwn(rawInput, "canvas");
  const hasDurationChange = hasOwn(rawInput, "durationSeconds");
  const hasLayersChange = hasOwn(rawInput, "layers");

  if (!hasNameChange && !hasCanvasChange && !hasDurationChange && !hasLayersChange) {
    throw new LayoutApiError("No layout changes were supplied.");
  }

  const name = hasNameChange ? normalizeName(input.name) : previous.name;
  if (!name) {
    throw new LayoutApiError("Layout name is required.");
  }

  if (layoutNameExists(storeLayouts, name, previous.id)) {
    throw new LayoutApiError("A layout with that name already exists.", 409);
  }

  const template = {
    ...previous,
    canvas: hasCanvasChange ? input.canvas : previous.canvas,
    durationSeconds: hasDurationChange ? input.durationSeconds : previous.durationSeconds,
    layers: hasLayersChange ? input.layers : previous.layers,
    name,
    render: notRendered("Layout changed. Render to MP4 before playlist use."),
    updatedAt: nowIso(),
    version: previous.version + 1
  };

  const error = validationError(template);
  if (error) {
    throw error;
  }

  return template as LayoutTemplate;
}

function layoutResponse(
  store: { items: LayoutTemplate[]; updatedAt: string; version: number },
  context: { activeWorkspaceId: string; userId: string }
) {
  return {
    activeWorkspaceId: context.activeWorkspaceId,
    layouts: store.items,
    updatedAt: store.updatedAt,
    userId: context.userId,
    version: store.version
  };
}

function errorResponse(error: unknown, fallback: string) {
  const status = error instanceof LayoutApiError ? error.status : 500;
  return apiErrorResponse(error, fallback, status);
}

export async function GET(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);
    const store = await readLayoutStore();
    const searchParams = new URL(request.url).searchParams;
    const layoutId = searchParams.get("layoutId") ?? searchParams.get("id");

    if (layoutId) {
      const layout = store.items.find((item) => item.id === layoutId);
      if (!layout) {
        return NextResponse.json({ error: "Layout was not found." }, { status: 404 });
      }

      return NextResponse.json({
        activeWorkspaceId: context.activeWorkspaceId,
        layout,
        userId: context.userId
      });
    }

    return NextResponse.json(layoutResponse(store, context));
  } catch (error) {
    console.error("layout read failed", error);
    return errorResponse(error, "Layout read failed.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const input = await readLayoutInput(request);
    const store = await readLayoutStore();
    const layout = createTemplate(input, store.items);
    await assertKnownMediaReferences(layout);

    const timestamp = layout.updatedAt;
    const nextStore = {
      ...store,
      items: [...store.items, layout],
      updatedAt: timestamp,
      version: store.version + 1
    };
    await writeLayoutStore(nextStore);
    await appendActivityRecord({
      id: randomUUID(),
      action: "layout-create",
      actor: "local-operator",
      entityId: layout.id,
      entityType: "layout",
      message: `Created layout ${layout.name}. Saved locally; render before playlist use.`,
      result: "success",
      timestamp
    });

    return NextResponse.json(
      {
        layout,
        message: "Saved locally. Render this layout before adding it to a playlist."
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("layout create failed", error);
    return errorResponse(error, "Layout create failed.");
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const input = await readLayoutInput(request);
    const layoutId = normalizeId(input.layoutId ?? input.id);
    if (!layoutId) {
      return NextResponse.json({ error: "Choose a layout." }, { status: 400 });
    }

    const store = await readLayoutStore();
    const index = store.items.findIndex((item) => item.id === layoutId);
    if (index === -1) {
      return NextResponse.json({ error: "Layout was not found." }, { status: 404 });
    }

    const layout = updateTemplate(store.items[index], input, store.items);
    await assertKnownMediaReferences(layout);

    const nextItems = [...store.items];
    nextItems[index] = layout;
    const nextStore = {
      ...store,
      items: nextItems,
      updatedAt: layout.updatedAt,
      version: store.version + 1
    };
    await writeLayoutStore(nextStore);
    await appendActivityRecord({
      id: randomUUID(),
      action: "layout-update",
      actor: "local-operator",
      entityId: layout.id,
      entityType: "layout",
      message: `Updated layout ${layout.name}. Saved locally; render before playlist use.`,
      result: "success",
      timestamp: layout.updatedAt
    });

    return NextResponse.json({
      layout,
      message: "Saved locally. Render this layout before adding it to a playlist."
    });
  } catch (error) {
    console.error("layout update failed", error);
    return errorResponse(error, "Layout update failed.");
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureLocalDataFoundation();
    const input = await readLayoutInput(request);
    const layoutId = normalizeId(input.layoutId ?? input.id);
    if (!layoutId) {
      return NextResponse.json({ error: "Choose a layout." }, { status: 400 });
    }

    const store = await readLayoutStore();
    const layout = store.items.find((item) => item.id === layoutId);
    if (!layout) {
      return NextResponse.json({ error: "Layout was not found." }, { status: 404 });
    }

    const timestamp = nowIso();
    const nextStore = {
      ...store,
      items: store.items.filter((item) => item.id !== layoutId),
      updatedAt: timestamp,
      version: store.version + 1
    };
    await writeLayoutStore(nextStore);
    await appendActivityRecord({
      id: randomUUID(),
      action: "layout-delete",
      actor: "local-operator",
      entityId: layout.id,
      entityType: "layout",
      message: `Deleted layout ${layout.name}. No playlist or screen publish was changed.`,
      result: "success",
      timestamp
    });

    return NextResponse.json({
      layoutId: layout.id,
      message: "Deleted locally. No playlist or screen publish was changed."
    });
  } catch (error) {
    console.error("layout delete failed", error);
    return errorResponse(error, "Layout delete failed.");
  }
}
