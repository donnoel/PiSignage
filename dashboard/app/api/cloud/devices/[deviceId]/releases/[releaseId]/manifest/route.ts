import { NextResponse } from "next/server";
import {
  readCloudRelease,
  releaseTargetsDevice,
  type CloudReleaseAsset
} from "../../../../../../../lib/cloud-release-store";
import { publicUrlForRequest } from "../../../../../../../lib/public-origin";

type RouteContext = {
  params: Promise<{
    deviceId: string;
    releaseId: string;
  }>;
};

type ManifestAsset = CloudReleaseAsset & {
  assetUrlEndpoint: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext) {
  const { deviceId, releaseId } = await context.params;
  const release = await readCloudRelease(releaseId);
  if (!release || !releaseTargetsDevice(release, deviceId)) {
    return NextResponse.json(
      {
        error: "Release manifest is unavailable for this device. Keep using the last known good local cache.",
        localFirst: true
      },
      { status: 404 }
    );
  }

  const assets: ManifestAsset[] = release.assets.map((asset) => ({
    ...asset,
    assetUrlEndpoint: publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/releases/${encodeURIComponent(releaseId)}/assets/${encodeURIComponent(asset.assetId)}/url`
    )
  }));

  return NextResponse.json({
    assetCount: release.assetCount,
    assets,
    createdAt: release.createdAt,
    manifestChecksum: release.manifestChecksum,
    plannedBytes: release.plannedBytes,
    playlist: {
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        altText: asset.altText,
        checksumSha256: asset.checksumSha256,
        durationSeconds: asset.durationSeconds,
        playbackObjectKey: asset.playbackObjectKey,
        playbackStorageBucket: asset.playbackStorageBucket,
        sizeBytes: asset.sizeBytes,
        sourceObjectKey: asset.sourceObjectKey,
        sourceStorageBucket: asset.sourceStorageBucket,
        storageBucket: asset.storageBucket,
        storageProvider: asset.storageProvider,
        type: asset.type,
        uri: asset.uri
      })),
      name: release.playlistName,
      playlistId: release.playlistId,
      updatedAt: release.publishedAt,
      version: release.playlistVersion,
      workspaceId: release.workspaceId
    },
    publishedAt: release.publishedAt,
    releaseId: release.releaseId,
    syncResultUrl: publicUrlForRequest(
      request,
      `/api/cloud/devices/${encodeURIComponent(deviceId)}/releases/${encodeURIComponent(releaseId)}/sync-result`
    )
  });
}
