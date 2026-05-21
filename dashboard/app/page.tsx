import { promises as fs } from "node:fs";
import path from "node:path";
import { LocalUploadForm } from "./local-upload-form";

export const dynamic = "force-dynamic";

type PlaylistAsset = {
  assetId: string;
  type: "image" | "video";
  uri: string;
  durationSeconds?: number;
  altText?: string;
};

type Playlist = {
  playlistId: string;
  name: string;
  version: number;
  updatedAt: string;
  assets: PlaylistAsset[];
};

type Heartbeat = {
  deviceId: string;
  timestamp: string;
  appVersion: string;
  currentPlaylistId: string;
  currentAssetId: string | null;
  diskFreeBytes: number | null;
  networkOnline: boolean;
};

type DashboardState = {
  screen: {
    id: string;
    name: string;
    deviceId: string;
    status: "Online" | "Offline";
    statusDetail: string;
    lastHeartbeat: string;
  };
  playlist: {
    id: string;
    name: string;
    assetCount: number;
    currentAsset: string;
    version: number;
    updatedAt: string;
    assets: PlaylistAsset[];
  };
  device: {
    appVersion: string;
    diskFree: string;
    networkOnline: string;
  };
};

const screenName = "Lobby TV";
const screenId = "screen-lobby";
const fallbackDeviceId = "device-local-demo";

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

async function readJsonFile<TValue>(filePath: string): Promise<TValue | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as TValue;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function assetLabel(playlist: Playlist, assetId: string | null | undefined): string {
  if (!assetId) {
    return "No current asset reported";
  }

  const asset = playlist.assets.find((candidate) => candidate.assetId === assetId);
  return asset?.altText ?? assetId;
}

function formatTimestamp(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "No heartbeat yet";
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number") {
    return "Not reported";
  }

  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: "gigabyte"
  }).format(value / 1_000_000_000);
}

async function loadDashboardState(): Promise<DashboardState> {
  const root = repoRoot();
  const playlistPath = path.join(root, "sample-content", "playlist.local.json");
  const heartbeatPath = path.join(root, "device-agent", "local-state", "heartbeat.json");
  const playlist = await readJsonFile<Playlist>(playlistPath);

  if (!playlist) {
    throw new Error(`Missing local playlist: ${playlistPath}`);
  }

  const heartbeat = await readJsonFile<Heartbeat>(heartbeatPath);
  const status = heartbeat?.networkOnline ? "Online" : "Offline";
  const statusDetail = heartbeat
    ? `Device heartbeat loaded from local state. Network reported ${status.toLowerCase()}.`
    : "No local heartbeat file yet. Run npm run agent:heartbeat to create one.";

  return {
    screen: {
      id: screenId,
      name: screenName,
      deviceId: heartbeat?.deviceId ?? fallbackDeviceId,
      status,
      statusDetail,
      lastHeartbeat: formatTimestamp(heartbeat?.timestamp)
    },
    playlist: {
      id: playlist.playlistId,
      name: playlist.name,
      assetCount: playlist.assets.length,
      currentAsset: assetLabel(playlist, heartbeat?.currentAssetId),
      version: playlist.version,
      updatedAt: formatTimestamp(playlist.updatedAt),
      assets: playlist.assets
    },
    device: {
      appVersion: heartbeat?.appVersion ?? "Not reported",
      diskFree: formatBytes(heartbeat?.diskFreeBytes),
      networkOnline: heartbeat?.networkOnline ? "Yes" : "No"
    }
  };
}

export default async function DashboardPage() {
  const { screen, playlist, device } = await loadDashboardState();
  const statusClassName =
    screen.status === "Online"
      ? "w-fit rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800"
      : "w-fit rounded-full bg-zinc-200 px-3 py-1 text-sm font-semibold text-zinc-800";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2 border-b border-zinc-200 pb-6">
        <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">
          Local proof of concept
        </p>
        <h1 className="text-4xl font-bold text-zinc-950">PiSignage Dashboard</h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-700">
          One local screen, one local playlist, and one local heartbeat state path. Cloud
          integrations are intentionally deferred.
        </p>
      </header>

      <section aria-labelledby="screen-heading" className="grid gap-4 md:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 id="screen-heading" className="text-2xl font-semibold text-zinc-950">
                {screen.name}
              </h2>
              <p className="mt-1 text-sm text-zinc-600">Device ID: {screen.deviceId}</p>
            </div>
            <p
              aria-label={`Screen status: ${screen.status}. ${screen.statusDetail}`}
              className={statusClassName}
            >
              {screen.status}
            </p>
          </div>

          <dl className="mt-8 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm font-medium text-zinc-500">Last heartbeat</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">{screen.lastHeartbeat}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-zinc-500">Assigned playlist</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">{playlist.name}</dd>
            </div>
            <div>
            <dt className="text-sm font-medium text-zinc-500">Playback mode</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-950">Local playlist</dd>
            </div>
          </dl>
          <p className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
            {screen.statusDetail}
          </p>
        </div>

        <aside aria-labelledby="scope-heading" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 id="scope-heading" className="text-xl font-semibold text-zinc-950">
            Current Scope
          </h2>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-700">
            <li>One account and one screen.</li>
            <li>Local heartbeat status only.</li>
            <li>No AWS deployment.</li>
            <li>No billing, analytics, or fleet controls.</li>
          </ul>
        </aside>
      </section>

      <section aria-labelledby="playlist-heading" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="playlist-heading" className="text-2xl font-semibold text-zinc-950">
              {playlist.name}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              Playlist ID: {playlist.id} · Version {playlist.version}
            </p>
          </div>
          <p className="text-sm font-medium text-zinc-700">
            {playlist.assetCount} {playlist.assetCount === 1 ? "asset" : "assets"}
          </p>
        </div>

        <dl className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-sm font-medium text-zinc-500">Current asset</dt>
            <dd className="mt-1 text-lg font-semibold text-zinc-950">{playlist.currentAsset}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-sm font-medium text-zinc-500">Playlist updated</dt>
            <dd className="mt-1 text-lg font-semibold text-zinc-950">{playlist.updatedAt}</dd>
          </div>
        </dl>
        <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="text-sm font-semibold text-zinc-700">Playlist assets</h3>
          <ul className="mt-3 divide-y divide-zinc-200 text-sm text-zinc-700">
            {playlist.assets.map((asset) => (
              <li key={asset.assetId} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-medium text-zinc-950">{asset.altText ?? asset.assetId}</span>
                <span>
                  {asset.type} · {asset.uri}
                  {asset.durationSeconds ? ` · ${asset.durationSeconds}s` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <LocalUploadForm />
      </section>

      <section aria-labelledby="device-heading" className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 id="device-heading" className="text-2xl font-semibold text-zinc-950">
          Device Heartbeat
        </h2>
        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-sm font-medium text-zinc-500">App version</dt>
            <dd className="mt-1 text-lg font-semibold text-zinc-950">{device.appVersion}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-sm font-medium text-zinc-500">Disk free</dt>
            <dd className="mt-1 text-lg font-semibold text-zinc-950">{device.diskFree}</dd>
          </div>
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <dt className="text-sm font-medium text-zinc-500">Network online</dt>
            <dd className="mt-1 text-lg font-semibold text-zinc-950">{device.networkOnline}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
