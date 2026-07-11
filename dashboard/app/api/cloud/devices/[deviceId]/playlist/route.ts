import { NextResponse } from "next/server";
import {
  readCloudRelease,
  releaseTargetsDevice,
  type CloudReleaseRecord
} from "../../../../../lib/cloud-release-store";
import { commandForDevice, readInventory } from "../../../../../lib/inventory-store";
import { readScheduleStore, type ScheduleStore } from "../../../../../lib/local-data-store";
import { publicUrlForRequest } from "../../../../../lib/public-origin";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function scheduleStoreForDevice(scheduleStore: ScheduleStore, screenId: string | null | undefined) {
  const localScreenId = "screen-primary";
  const items = screenId
    ? scheduleStore.items
        .filter((schedule) => schedule.screenIds.includes(screenId))
        .map((schedule) => ({
          ...schedule,
          screenIds: [localScreenId]
        }))
    : [];

  return {
    items,
    updatedAt: scheduleStore.updatedAt,
    version: scheduleStore.version
  };
}

function releaseSummary(request: Request, deviceId: string, release: CloudReleaseRecord) {
  return {
    assetCount: release.assetCount,
    manifestChecksum: release.manifestChecksum,
    manifestUrl: publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/releases/${encodeURIComponent(release.releaseId)}/manifest`
    ),
    plannedBytes: release.plannedBytes,
    playlistId: release.playlistId,
    playlistName: release.playlistName,
    playlistVersion: release.playlistVersion,
    publishedAt: release.publishedAt,
    publishHandoffMode: release.publishHandoffMode,
    releaseId: release.releaseId
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const { searchParams } = new URL(request.url);
  const currentReleaseId = searchParams.get("currentReleaseId");
  const currentManifestChecksum = searchParams.get("manifestChecksum");
  const [inventory, scheduleStore] = await Promise.all([
    readInventory("playlist-main-playlist"),
    readScheduleStore()
  ]);
  const device = inventory.devices.items.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device was not found." }, { status: 404 });
  }

  const screen = inventory.screens.items.find((candidate) =>
    candidate.deviceId === device.id || candidate.id === device.screenId
  );
  const schedule = scheduleStoreForDevice(scheduleStore, screen?.id ?? device.screenId);
  const resetStatusUrl = publicUrlForRequest(
    request,
    `/api/cloud/devices/${encodeURIComponent(deviceId)}/reset-result`
  );
  const actionStatusUrl = publicUrlForRequest(
    request,
    `/api/cloud/devices/${encodeURIComponent(deviceId)}/actions-result`
  );
  const diagnosticsStatusUrl = publicUrlForRequest(
    request,
    `/api/cloud/devices/${encodeURIComponent(deviceId)}/diagnostics-result`
  );
  const command = commandForDevice(device, { actionStatusUrl, diagnosticsStatusUrl, resetStatusUrl });
  const desiredReleaseId = screen?.desiredReleaseId ?? device.desiredReleaseId ?? null;
  const desiredManifestChecksum =
    screen?.desiredReleaseManifestChecksum ?? device.desiredReleaseManifestChecksum ?? null;

  if (!desiredReleaseId) {
    if (command) {
      return NextResponse.json({
        command,
        deviceId,
        localFirst: true,
        playlist: null,
        release: null,
        schedule,
        serverTime: new Date().toISOString()
      });
    }

    if (scheduleStore.version > 0) {
      return NextResponse.json({
        command: null,
        deviceId,
        localFirst: true,
        playlist: null,
        release: null,
        schedule,
        serverTime: new Date().toISOString()
      });
    }

    return NextResponse.json(
      {
        error: "No release has been manually published to this device. Keep using the last known good local cache.",
        localFirst: true
      },
      { status: 404 }
    );
  }

  const release = await readCloudRelease(desiredReleaseId);
  if (!release || !releaseTargetsDevice(release, deviceId)) {
    return NextResponse.json(
      {
        error: "The published release is unavailable for this device. Keep using the last known good local cache.",
        localFirst: true,
        releaseId: desiredReleaseId
      },
      { status: 404 }
    );
  }

  const unchanged =
    currentReleaseId === release.releaseId &&
    currentManifestChecksum === release.manifestChecksum &&
    desiredManifestChecksum === release.manifestChecksum;

  return NextResponse.json({
    command,
    deviceId,
    playlist: null,
    release: releaseSummary(request, deviceId, release),
    schedule,
    serverTime: new Date().toISOString(),
    unchanged
  });
}
