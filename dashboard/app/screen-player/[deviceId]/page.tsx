import Link from "next/link";
import { assignedPlaylistIdForDevice } from "../../lib/inventory-assignment";
import { readCloudHeartbeats } from "../../lib/cloud-heartbeat";
import type { CloudHeartbeat } from "../../lib/cloud-heartbeat";
import { readCloudRelease, releaseTargetsDevice, type CloudReleaseRecord } from "../../lib/cloud-release-store";
import { readInventory } from "../../lib/inventory-store";
import type { DeviceRecord, ScreenRecord } from "../../lib/local-data-store";
import type { Playlist, PlaylistAsset } from "../../lib/local-playlist";
import { readPlaylistStore } from "../../lib/playlist-store";
import { RemoteScreenPlayer, type RemoteScreenAsset } from "../remote-screen-player";

type ScreenPlayerPageProps = {
  params: Promise<{
    deviceId: string;
  }>;
};

export const dynamic = "force-dynamic";

function formatStatusAge(value: string | null | undefined): string {
  if (!value) {
    return "not reported";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "not reported";
  }

  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function playerFallback(title: string, detail: string) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-white">
      <section className="w-full max-w-xl rounded-lg border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <p className="text-xs font-semibold uppercase text-emerald-300">Beam live report</p>
        <h1 className="mt-3 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-300">{detail}</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-10 items-center rounded-md bg-white px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
        >
          Back to Beam
        </Link>
      </section>
    </main>
  );
}

function assetUrlEndpoint(deviceId: string, releaseId: string, assetId: string): string {
  return `/api/cloud/devices/${encodeURIComponent(deviceId)}/releases/${encodeURIComponent(releaseId)}/assets/${encodeURIComponent(assetId)}/url`;
}

function currentAssetUrlEndpoint(deviceId: string, assetId: string): string {
  return `/api/cloud/devices/${encodeURIComponent(deviceId)}/current-assets/${encodeURIComponent(assetId)}/url`;
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function pilotDeviceIdFor(device: DeviceRecord, screen: ScreenRecord | null): string | null {
  const identity = [device.id, device.host, device.name, screen?.name].join(" ");
  const match = identity.match(/\bC([1-5])\b/i);
  return match ? `device-c${match[1]}-aws-pilot` : null;
}

function screenForDevice(device: DeviceRecord, screens: ScreenRecord[]): ScreenRecord | null {
  return screens.find((candidate) =>
    candidate.deviceId === device.id || candidate.id === device.screenId
  ) ?? null;
}

function resolveDevice(
  requestedId: string,
  devices: DeviceRecord[],
  screens: ScreenRecord[]
): { device: DeviceRecord; screen: ScreenRecord | null } | null {
  const exactDevice = devices.find((candidate) => candidate.id === requestedId);
  if (exactDevice) {
    return { device: exactDevice, screen: screenForDevice(exactDevice, screens) };
  }

  const exactScreen = screens.find((candidate) => candidate.id === requestedId || candidate.deviceId === requestedId);
  if (exactScreen) {
    const linkedDevice = devices.find((candidate) =>
      candidate.id === exactScreen.deviceId || candidate.screenId === exactScreen.id
    );
    if (linkedDevice) {
      return { device: linkedDevice, screen: exactScreen };
    }
  }

  for (const device of devices) {
    const screen = screenForDevice(device, screens);
    if (pilotDeviceIdFor(device, screen) === requestedId) {
      return { device, screen };
    }
  }

  return null;
}

function displayTitleFromPlaylistAsset(asset: PlaylistAsset): string {
  return asset.altText?.trim() || asset.uri.split("/").filter(Boolean).at(-1) || asset.assetId;
}

function remoteAssetFromPlaylist(asset: PlaylistAsset, deviceId: string | null): RemoteScreenAsset {
  return {
    assetId: asset.assetId,
    assetUrlEndpoint: deviceId ? currentAssetUrlEndpoint(deviceId, asset.assetId) : null,
    durationSeconds: asset.durationSeconds ?? null,
    fileName: asset.uri.split("/").filter(Boolean).at(-1) ?? asset.uri,
    title: displayTitleFromPlaylistAsset(asset),
    type: asset.type
  };
}

function remoteAssetFromRelease(release: CloudReleaseRecord, releaseDeviceId: string, assetId: string): RemoteScreenAsset | null {
  const asset = release.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) {
    return null;
  }

  return {
    assetId: asset.assetId,
    assetUrlEndpoint: assetUrlEndpoint(releaseDeviceId, release.releaseId, asset.assetId),
    durationSeconds: asset.durationSeconds ?? null,
    fileName: asset.fileName,
    title: asset.altText || asset.fileName,
    type: asset.type
  };
}

function playbackStateLabel(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "No live report";
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function matchingHeartbeat(
  candidateDeviceIds: string[],
  heartbeats: Awaited<ReturnType<typeof readCloudHeartbeats>>
): { heartbeat: CloudHeartbeat; heartbeatDeviceId: string } | null {
  for (const candidate of candidateDeviceIds) {
    const heartbeat = heartbeats[candidate]?.heartbeat;
    if (heartbeats[candidate]?.ok && heartbeat) {
      return { heartbeat, heartbeatDeviceId: candidate };
    }
  }

  return null;
}

function releaseMatchesHeartbeat(release: CloudReleaseRecord, heartbeat: CloudHeartbeat): boolean {
  if (heartbeat.currentPlaylistId && release.playlistId !== heartbeat.currentPlaylistId) {
    return false;
  }

  if (typeof heartbeat.playlistVersion === "number" && release.playlistVersion !== heartbeat.playlistVersion) {
    return false;
  }

  return true;
}

async function readHeartbeatMatchedRelease(
  releaseId: string | null | undefined,
  candidateDeviceIds: string[],
  heartbeat: CloudHeartbeat | null
): Promise<{ release: CloudReleaseRecord; releaseDeviceId: string } | null> {
  if (!releaseId || !heartbeat) {
    return null;
  }

  const release = await readCloudRelease(releaseId);
  if (!release || !releaseMatchesHeartbeat(release, heartbeat)) {
    return null;
  }

  const releaseDeviceId = candidateDeviceIds.find((candidate) => releaseTargetsDevice(release, candidate)) ?? null;
  return releaseDeviceId ? { release, releaseDeviceId } : null;
}

function playlistLabel(heartbeat: CloudHeartbeat | null, release: CloudReleaseRecord | null, playlist: Playlist | null): string {
  if (release) {
    return `${release.playlistName} v${release.playlistVersion}`;
  }

  if (playlist) {
    return `${playlist.name} v${playlist.version}`;
  }

  if (heartbeat?.currentPlaylistId) {
    const versionLabel = typeof heartbeat.playlistVersion === "number" ? ` v${heartbeat.playlistVersion}` : "";
    return `${heartbeat.currentPlaylistId}${versionLabel}`;
  }

  return "Not reported";
}

export default async function ScreenPlayerPage({ params }: ScreenPlayerPageProps) {
  const { deviceId } = await params;
  const [inventory, playlistStore] = await Promise.all([
    readInventory("playlist-main-playlist"),
    readPlaylistStore()
  ]);
  const resolved = resolveDevice(deviceId, inventory.devices.items, inventory.screens.items);
  if (!resolved) {
    return playerFallback("Screen not found", "Beam could not find that device in the current workspace.");
  }

  const { device, screen } = resolved;
  const candidateDeviceIds = uniqueValues([device.id, pilotDeviceIdFor(device, screen), deviceId]);
  const heartbeats = await readCloudHeartbeats(candidateDeviceIds);
  const heartbeatMatch = matchingHeartbeat(candidateDeviceIds, heartbeats);
  const heartbeat = heartbeatMatch?.heartbeat ?? null;
  const reportedAssetId = heartbeat?.currentAssetId ?? null;
  const reportedPlaylist = heartbeat?.currentPlaylistId
    ? playlistStore.items.find((playlist) => playlist.playlistId === heartbeat.currentPlaylistId) ?? null
    : null;
  const assignedPlaylistId = assignedPlaylistIdForDevice(device, screen);
  const assignedPlaylist = assignedPlaylistId
    ? playlistStore.items.find((playlist) => playlist.playlistId === assignedPlaylistId) ?? null
    : null;
  const releaseId = screen?.desiredReleaseId ?? device.desiredReleaseId;
  const matchedRelease = await readHeartbeatMatchedRelease(releaseId, candidateDeviceIds, heartbeat);
  const playlistForMetadata = reportedPlaylist ?? assignedPlaylist;
  const playlistAsset = reportedAssetId
    ? playlistForMetadata?.assets.find((asset) => asset.assetId === reportedAssetId) ?? null
    : null;
  const releaseAsset = reportedAssetId && matchedRelease
    ? remoteAssetFromRelease(matchedRelease.release, matchedRelease.releaseDeviceId, reportedAssetId)
    : null;
  const currentAsset = releaseAsset ?? (playlistAsset ? remoteAssetFromPlaylist(playlistAsset, heartbeatMatch?.heartbeatDeviceId ?? null) : null);
  const hasPlayableCurrentAsset = Boolean(currentAsset?.assetUrlEndpoint);
  const displayPlaylistLabel = playlistLabel(heartbeat, matchedRelease?.release ?? null, playlistForMetadata);
  const screenName = screen?.name ?? device.name;
  const hostLabel = (heartbeat?.localIpAddress ?? device.host.trim()) || "No host";
  let detail = `Beam found ${screenName}, but it has not received a live Pi report for this screen yet.`;
  if (heartbeat) {
    detail = reportedAssetId
      ? currentAsset
        ? `The Pi reports ${currentAsset.title} as the current item.`
        : "The Pi reported a current item id, but Beam cannot match it to the reported playlist yet."
      : "The Pi checked in, but it has not reported a current media item yet.";
  }
  const reportNote = heartbeat
    ? hasPlayableCurrentAsset
      ? "Latest Pi heartbeat selected the starting item. Beam can start this confidence player on the reported asset, but exact playback timestamp is not reported yet."
      : "Latest Pi heartbeat is the source of truth. Beam found the reported item metadata but cannot load playable media for it yet."
    : "Saved inventory is the only source available. No live Pi heartbeat has been received for this screen.";

  return (
    <RemoteScreenPlayer
      asset={currentAsset}
      detail={detail}
      hostLabel={hostLabel}
      lastReportLabel={formatStatusAge(heartbeat?.receivedAt ?? heartbeat?.timestamp)}
      playlistName={displayPlaylistLabel}
      playbackStateLabel={playbackStateLabel(heartbeat?.playbackState)}
      reportNote={reportNote}
      screenName={screenName}
    />
  );
}
