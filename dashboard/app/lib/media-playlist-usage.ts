import path from "node:path";
import type { MediaRecord } from "./local-data-store";
import type { PlaylistAsset } from "./local-playlist";
import { readPlaylistStore } from "./playlist-store";

export function playlistAssetFileName(asset: PlaylistAsset): string | null {
  if (!asset.uri.startsWith("assets/")) {
    return null;
  }

  return path.basename(asset.uri);
}

function s3ObjectKeyFromUri(uri: string): string | null {
  if (!uri.startsWith("s3://")) {
    return null;
  }

  const pathStart = uri.indexOf("/", "s3://".length);
  if (pathStart === -1) {
    return null;
  }

  const objectKey = uri.slice(pathStart + 1).trim();
  return objectKey || null;
}

function playlistAssetObjectKey(asset: PlaylistAsset): string | null {
  return asset.playbackObjectKey ?? s3ObjectKeyFromUri(asset.uri);
}

export function playlistAssetMatchesMediaRecord(asset: PlaylistAsset, media: MediaRecord): boolean {
  const fileName = playlistAssetFileName(asset);
  if (fileName && fileName === media.playbackFileName) {
    return true;
  }

  const objectKey = playlistAssetObjectKey(asset);
  return Boolean(objectKey && media.playbackObjectKey && objectKey === media.playbackObjectKey);
}

export async function playlistFileNamesInUse(): Promise<Set<string>> {
  const playlistStore = await readPlaylistStore();
  const fileNames = new Set<string>();

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      const fileName = playlistAssetFileName(asset);
      if (fileName) {
        fileNames.add(fileName);
      }
    }
  }

  return fileNames;
}

export async function playlistUsesFile(fileName: string): Promise<boolean> {
  const fileNames = await playlistFileNamesInUse();
  return fileNames.has(fileName);
}

export async function playlistAssetsForMediaRecord(media: MediaRecord): Promise<PlaylistAsset[]> {
  const playlistStore = await readPlaylistStore();
  const assets: PlaylistAsset[] = [];

  for (const playlist of playlistStore.items) {
    for (const asset of playlist.assets) {
      if (playlistAssetMatchesMediaRecord(asset, media)) {
        assets.push(asset);
      }
    }
  }

  return assets;
}

export async function playlistUsesMediaRecord(media: MediaRecord): Promise<boolean> {
  const assets = await playlistAssetsForMediaRecord(media);
  return assets.length > 0;
}
