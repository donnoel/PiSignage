import "./styles.css";

type PlaylistAsset = {
  assetId: string;
  type: "image";
  uri: string;
  durationSeconds: number;
  altText: string;
};

type Playlist = {
  playlistId: string;
  name: string;
  version: number;
  updatedAt: string;
  assets: PlaylistAsset[];
};

const image = document.querySelector<HTMLImageElement>("#asset");
const playlistName = document.querySelector<HTMLSpanElement>("#playlist-name");
const assetStatus = document.querySelector<HTMLSpanElement>("#asset-status");
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen-button");

let currentIndex = 0;
let playbackTimer: number | undefined;
const defaultPlaylistUrl = "/playlist.local.json";

function requireElement<TElement extends Element>(
  element: TElement | null,
  name: string
): TElement {
  if (!element) {
    throw new Error(`Missing player element: ${name}`);
  }

  return element;
}

const playerImage = requireElement(image, "asset");
const playlistNameLabel = requireElement(playlistName, "playlist-name");
const assetStatusLabel = requireElement(assetStatus, "asset-status");
const fullscreenControl = requireElement(fullscreenButton, "fullscreen-button");

function playlistUrlFromLocation(): URL {
  const requestedPlaylist = new URLSearchParams(window.location.search).get("playlist");
  const playlistUrl = new URL(requestedPlaylist ?? defaultPlaylistUrl, window.location.href);

  if (playlistUrl.origin !== window.location.origin) {
    throw new Error("Playlist URL must be same-origin for local playback");
  }

  return playlistUrl;
}

function parsePlaylist(value: unknown, source: string): Playlist {
  const candidate = value as Partial<Playlist>;

  if (
    typeof candidate.playlistId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "number" ||
    typeof candidate.updatedAt !== "string" ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error(`Invalid playlist shape: ${source}`);
  }

  for (const asset of candidate.assets) {
    if (
      typeof asset.assetId !== "string" ||
      asset.type !== "image" ||
      typeof asset.uri !== "string" ||
      typeof asset.durationSeconds !== "number" ||
      typeof asset.altText !== "string"
    ) {
      throw new Error(`Invalid playlist asset: ${source}`);
    }
  }

  return candidate as Playlist;
}

async function loadPlaylist(playlistUrl: URL): Promise<Playlist> {
  const response = await fetch(playlistUrl);

  if (!response.ok) {
    throw new Error(`Playlist load failed: ${response.status}`);
  }

  return parsePlaylist(await response.json(), playlistUrl.pathname);
}

function imageUrlFor(asset: PlaylistAsset, playlistUrl: URL): string {
  const assetUrl = new URL(asset.uri, playlistUrl);

  if (assetUrl.origin !== window.location.origin) {
    throw new Error(`Asset URL must be same-origin: ${asset.assetId}`);
  }

  return assetUrl.toString();
}

function showAsset(playlist: Playlist, playlistUrl: URL, index: number): void {
  if (playlist.assets.length === 0) {
    playlistNameLabel.textContent = playlist.name;
    assetStatusLabel.textContent = "No assets in playlist";
    playerImage.removeAttribute("src");
    playerImage.alt = "No playlist asset is available";
    return;
  }

  const asset = playlist.assets[index] ?? playlist.assets[0];
  currentIndex = index;
  playlistNameLabel.textContent = playlist.name;
  assetStatusLabel.textContent = `Playing ${asset.assetId}`;
  playerImage.src = imageUrlFor(asset, playlistUrl);
  playerImage.alt = asset.altText;

  window.clearTimeout(playbackTimer);
  playbackTimer = window.setTimeout(() => {
    showAsset(playlist, playlistUrl, (currentIndex + 1) % playlist.assets.length);
  }, Math.max(asset.durationSeconds, 1) * 1000);
}

fullscreenControl.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
});

document.addEventListener("fullscreenchange", () => {
  fullscreenControl.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
});

async function startPlayback(): Promise<void> {
  const playlistUrl = playlistUrlFromLocation();
  playlistNameLabel.textContent = "Loading playlist";
  assetStatusLabel.textContent = playlistUrl.pathname;

  const playlist = await loadPlaylist(playlistUrl);
  showAsset(playlist, playlistUrl, 0);
}

startPlayback().catch((error: unknown) => {
  window.clearTimeout(playbackTimer);
  playlistNameLabel.textContent = "Playback unavailable";
  assetStatusLabel.textContent = error instanceof Error ? error.message : "Unknown playback error";
  playerImage.removeAttribute("src");
  playerImage.alt = "Playlist failed to load";
  console.error(error);
});
