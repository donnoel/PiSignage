import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { readInventory } from "../../../../../lib/inventory-store";
import type { PlaylistAsset } from "../../../../../lib/local-playlist";
import { readPlaylistStore, selectPlaylist } from "../../../../../lib/playlist-store";

type RouteContext = {
  params: Promise<{
    deviceId: string;
  }>;
};

type DevicePlaylistAsset = PlaylistAsset & {
  downloadUrl?: string;
  fileName: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const s3 = new S3Client({});
const signedUrlExpiresInSeconds = 15 * 60;

function fileNameForAsset(asset: PlaylistAsset): string {
  const explicitPath = asset.playbackObjectKey ?? asset.sourceObjectKey ?? asset.uri;
  return path.basename(explicitPath);
}

async function signedAsset(asset: PlaylistAsset): Promise<DevicePlaylistAsset> {
  const bucket = asset.storageBucket;
  const key = asset.playbackObjectKey ?? asset.sourceObjectKey;
  const fileName = fileNameForAsset(asset);

  if (!bucket || !key || asset.storageProvider !== "s3") {
    return {
      ...asset,
      fileName
    };
  }

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }),
    { expiresIn: signedUrlExpiresInSeconds }
  );

  return {
    ...asset,
    downloadUrl,
    fileName
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { deviceId } = await context.params;
  const [inventory, playlistStore] = await Promise.all([
    readInventory("playlist-main-playlist"),
    readPlaylistStore()
  ]);
  const device = inventory.devices.items.find((candidate) => candidate.id === deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device was not found." }, { status: 404 });
  }

  const screen = inventory.screens.items.find((candidate) =>
    candidate.deviceId === device.id || candidate.id === device.screenId
  );
  const playlistId = screen?.playlistId ?? device.playlistId;
  if (!playlistId) {
    return NextResponse.json({ error: "Device does not have an assigned playlist." }, { status: 404 });
  }

  const playlist = selectPlaylist(playlistStore, playlistId);
  const assets = await Promise.all(playlist.assets.map(signedAsset));

  return NextResponse.json({
    deviceId,
    playlist: {
      ...playlist,
      assets
    },
    serverTime: new Date().toISOString()
  });
}
