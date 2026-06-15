import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { readInventory, resetCommandForDevice } from "../../../../../lib/inventory-store";
import type { PlaylistAsset } from "../../../../../lib/local-playlist";
import { readPlaylistStore, selectPlaylist } from "../../../../../lib/playlist-store";
import { publicUrlForRequest } from "../../../../../lib/public-origin";

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

export async function GET(request: Request, context: RouteContext) {
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
  const resetStatusUrl = publicUrlForRequest(
    request,
    `/api/cloud/devices/${encodeURIComponent(deviceId)}/reset-result`
  );
  const command = resetCommandForDevice(device, resetStatusUrl);
  const publishedPlaylistId = screen?.publishedPlaylistId ?? device.publishedPlaylistId ?? null;
  const publishedPlaylistVersion = screen?.publishedPlaylistVersion ?? device.publishedPlaylistVersion ?? null;
  const playlistId = publishedPlaylistId;
  if (!playlistId) {
    if (command) {
      return NextResponse.json({
        command,
        deviceId,
        playlist: null,
        serverTime: new Date().toISOString()
      });
    }

    return NextResponse.json({ error: "No playlist has been manually published to this device." }, { status: 404 });
  }

  const playlist = selectPlaylist(playlistStore, playlistId);
  if (typeof publishedPlaylistVersion === "number" && playlist.version !== publishedPlaylistVersion) {
    if (command) {
      return NextResponse.json({
        command,
        deviceId,
        playlist: null,
        playlistError: {
          error: "A newer playlist draft exists, but it has not been manually published to this device.",
          publishedPlaylistId: playlistId,
          publishedPlaylistVersion,
          savedPlaylistVersion: playlist.version
        },
        serverTime: new Date().toISOString()
      });
    }

    return NextResponse.json(
      {
        error: "A newer playlist draft exists, but it has not been manually published to this device.",
        publishedPlaylistId: playlistId,
        publishedPlaylistVersion,
        savedPlaylistVersion: playlist.version
      },
      { status: 409 }
    );
  }
  const assets = await Promise.all(playlist.assets.map(signedAsset));

  return NextResponse.json({
    command,
    deviceId,
    playlist: {
      ...playlist,
      assets
    },
    publishedAt: screen?.publishedAt ?? device.publishedAt ?? null,
    serverTime: new Date().toISOString()
  });
}
