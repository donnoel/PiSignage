import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { readCloudHeartbeats } from "../../../../../../../lib/cloud-heartbeat";
import type { PlaylistAsset } from "../../../../../../../lib/local-playlist";
import { readPlaylistStore } from "../../../../../../../lib/playlist-store";

type RouteContext = {
  params: Promise<{
    assetId: string;
    deviceId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const s3 = new S3Client({});
const signedUrlExpiresInSeconds = 15 * 60;

function assetFileName(asset: PlaylistAsset): string {
  return asset.uri.split("/").filter(Boolean).at(-1) ?? asset.assetId;
}

export async function GET(_request: Request, context: RouteContext) {
  const { assetId, deviceId } = await context.params;
  const heartbeats = await readCloudHeartbeats([deviceId]);
  const heartbeat = heartbeats[deviceId]?.heartbeat ?? null;

  if (!heartbeats[deviceId]?.ok || !heartbeat) {
    return NextResponse.json(
      { error: "Beam has no live heartbeat for this screen yet.", localFirst: true },
      { status: 404 }
    );
  }

  if (heartbeat.currentAssetId !== assetId) {
    return NextResponse.json(
      {
        currentAssetId: heartbeat.currentAssetId,
        error: "The requested asset is not the current item reported by this screen."
      },
      { status: 409 }
    );
  }

  if (!heartbeat.currentPlaylistId) {
    return NextResponse.json(
      { error: "The screen has not reported a current playlist yet." },
      { status: 409 }
    );
  }

  const playlistStore = await readPlaylistStore();
  const playlist = playlistStore.items.find((candidate) => candidate.playlistId === heartbeat.currentPlaylistId) ?? null;
  const asset = playlist?.assets.find((candidate) => candidate.assetId === assetId) ?? null;
  if (!playlist || !asset) {
    return NextResponse.json(
      { error: "Beam cannot match the reported current asset to the reported playlist." },
      { status: 404 }
    );
  }

  const bucket = asset.playbackStorageBucket ?? asset.storageBucket ?? asset.sourceStorageBucket;
  const key = asset.playbackObjectKey ?? asset.sourceObjectKey;
  if (!bucket || !key || asset.storageProvider !== "s3") {
    return NextResponse.json(
      { error: "This reported asset is not backed by AWS storage." },
      { status: 409 }
    );
  }

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }),
    { expiresIn: signedUrlExpiresInSeconds }
  );

  return NextResponse.json({
    assetId,
    checksumSha256: asset.checksumSha256 ?? null,
    expiresInSeconds: signedUrlExpiresInSeconds,
    fileName: assetFileName(asset),
    playlistId: playlist.playlistId,
    playlistVersion: playlist.version,
    sizeBytes: asset.sizeBytes ?? null,
    url: downloadUrl
  });
}
