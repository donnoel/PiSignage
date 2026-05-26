import "./styles.css";

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

const image = document.querySelector<HTMLImageElement>("#asset");
const video = document.querySelector<HTMLVideoElement>("#video-asset");
const preloadVideo = document.querySelector<HTMLVideoElement>("#video-preload");
const playlistName = document.querySelector<HTMLSpanElement>("#playlist-name");
const assetStatus = document.querySelector<HTMLSpanElement>("#asset-status");
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen-button");
const locationParameters = new URLSearchParams(window.location.search);

let currentIndex = 0;
let playbackTimer: number | undefined;
let playlistRefreshTimer: number | undefined;
let videoWatchdogTimer: number | undefined;
let activePlaylist: Playlist | null = null;
let activePlaylistUrl: URL | null = null;
let activePlaylistSignature = "";
let visibleVideo: HTMLVideoElement | null = null;
let renderGeneration = 0;
const failedAssetIds = new Set<string>();
const defaultPlaylistUrl = "/playlist.local.json";
const playlistRefreshIntervalMs = 5000;
const videoWatchdogIntervalMs = 10_000;

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
const playerVideo = requireElement(video, "video-asset");
const playerPreloadVideo = requireElement(preloadVideo, "video-preload");
const playerVideos = [playerVideo, playerPreloadVideo];
const playlistNameLabel = requireElement(playlistName, "playlist-name");
const assetStatusLabel = requireElement(assetStatus, "asset-status");
const fullscreenControl = requireElement(fullscreenButton, "fullscreen-button");

function playlistUrlFromLocation(): URL {
  const requestedPlaylist = locationParameters.get("playlist");
  const playlistUrl = new URL(requestedPlaylist ?? defaultPlaylistUrl, window.location.href);

  if (playlistUrl.origin !== window.location.origin) {
    throw new Error("Playlist URL must be same-origin for local playback");
  }

  return playlistUrl;
}

function applyDisplayMode(): void {
  document.body.classList.toggle("signage-display", locationParameters.get("display") === "signage");
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
      (asset.type !== "image" && asset.type !== "video") ||
      typeof asset.uri !== "string"
    ) {
      throw new Error(`Invalid playlist asset: ${source}`);
    }

    if (
      asset.type === "image" &&
      (typeof asset.durationSeconds !== "number" || typeof asset.altText !== "string")
    ) {
      throw new Error(`Invalid image asset: ${source}`);
    }

    if (asset.durationSeconds !== undefined && typeof asset.durationSeconds !== "number") {
      throw new Error(`Invalid asset duration: ${source}`);
    }
  }

  return candidate as Playlist;
}

async function loadPlaylist(playlistUrl: URL): Promise<Playlist> {
  const cacheBustedPlaylistUrl = new URL(playlistUrl);
  cacheBustedPlaylistUrl.searchParams.set("t", Date.now().toString());
  const response = await fetch(cacheBustedPlaylistUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Playlist load failed: ${response.status}`);
  }

  return parsePlaylist(await response.json(), playlistUrl.pathname);
}

function assetUrlFor(asset: PlaylistAsset, playlistUrl: URL): string {
  const assetUrl = new URL(asset.uri, playlistUrl);

  if (assetUrl.origin !== window.location.origin) {
    throw new Error(`Asset URL must be same-origin: ${asset.assetId}`);
  }

  return assetUrl.toString();
}

function playlistSignature(playlist: Playlist): string {
  return JSON.stringify({
    playlistId: playlist.playlistId,
    version: playlist.version,
    assets: playlist.assets
  });
}

function activeAsset(): PlaylistAsset | undefined {
  return activePlaylist?.assets[currentIndex];
}

function clearVideoWatchdog(): void {
  window.clearTimeout(videoWatchdogTimer);
  videoWatchdogTimer = undefined;
}

function hideImage(): void {
  playerImage.classList.add("hidden");
  playerImage.removeAttribute("src");
  playerImage.alt = "";
}

function resetVideo(videoElement: HTMLVideoElement): void {
  videoElement.pause();
  videoElement.classList.add("hidden");
  videoElement.removeAttribute("src");
  videoElement.removeAttribute("aria-label");
  delete videoElement.dataset.assetId;
  videoElement.load();
}

function hideVideos(): void {
  clearVideoWatchdog();
  for (const videoElement of playerVideos) {
    resetVideo(videoElement);
  }
  visibleVideo = null;
}

function prepareVideo(
  videoElement: HTMLVideoElement,
  asset: PlaylistAsset,
  playlistUrl: URL
): void {
  resetVideo(videoElement);
  videoElement.src = assetUrlFor(asset, playlistUrl);
  videoElement.dataset.assetId = asset.assetId;
  videoElement.setAttribute("aria-label", asset.altText ?? asset.assetId);
  videoElement.load();
}

function nextPlayableIndex(afterIndex: number): number | null {
  if (!activePlaylist || activePlaylist.assets.length === 0) {
    return null;
  }

  for (let offset = 1; offset <= activePlaylist.assets.length; offset += 1) {
    const nextIndex = (afterIndex + offset) % activePlaylist.assets.length;
    if (!failedAssetIds.has(activePlaylist.assets[nextIndex].assetId)) {
      return nextIndex;
    }
  }

  return null;
}

function showNoPlayableAssets(): void {
  window.clearTimeout(playbackTimer);
  assetStatusLabel.textContent = "No playable assets available";
  hideImage();
  hideVideos();
}

function advanceAsset(): void {
  const nextIndex = nextPlayableIndex(currentIndex);
  if (nextIndex === null) {
    showNoPlayableAssets();
    return;
  }

  showAsset(nextIndex);
}

function failActiveAsset(assetId: string, reason: string): void {
  if (activeAsset()?.assetId !== assetId || failedAssetIds.has(assetId)) {
    return;
  }

  failedAssetIds.add(assetId);
  console.error(`Playback failed for ${assetId}: ${reason}`);
  assetStatusLabel.textContent = `Skipping unavailable asset ${assetId}`;
  clearVideoWatchdog();

  if (visibleVideo?.dataset.assetId === assetId) {
    resetVideo(visibleVideo);
    visibleVideo = null;
  }

  advanceAsset();
}

function startVideoWatchdog(videoElement: HTMLVideoElement): void {
  const assetId = videoElement.dataset.assetId;
  if (!assetId || activeAsset()?.assetId !== assetId) {
    return;
  }

  clearVideoWatchdog();
  videoWatchdogTimer = window.setTimeout(() => {
    failActiveAsset(assetId, "video stalled before playback resumed");
  }, videoWatchdogIntervalMs);
}

function preloadFollowingAsset(): void {
  if (!activePlaylist || !activePlaylistUrl) {
    return;
  }

  const nextIndex = nextPlayableIndex(currentIndex);
  if (nextIndex === null) {
    return;
  }

  const nextAsset = activePlaylist.assets[nextIndex];
  if (nextAsset.type === "video") {
    const standbyVideo = visibleVideo === playerVideo ? playerPreloadVideo : playerVideo;
    if (standbyVideo.dataset.assetId !== nextAsset.assetId) {
      prepareVideo(standbyVideo, nextAsset, activePlaylistUrl);
    }
    return;
  }

  const preloadImage = new Image();
  preloadImage.src = assetUrlFor(nextAsset, activePlaylistUrl);
}

function showImageAsset(asset: PlaylistAsset, playlistUrl: URL): void {
  renderGeneration += 1;
  hideVideos();
  playerImage.src = assetUrlFor(asset, playlistUrl);
  playerImage.alt = asset.altText ?? asset.assetId;
  playerImage.classList.remove("hidden");
  preloadFollowingAsset();
}

async function showVideoAsset(asset: PlaylistAsset, playlistUrl: URL): Promise<void> {
  const generation = ++renderGeneration;
  const nextVideo =
    playerVideos.find(
      (videoElement) =>
        videoElement !== visibleVideo && videoElement.dataset.assetId === asset.assetId
    ) ?? (visibleVideo === playerVideo ? playerPreloadVideo : playerVideo);

  if (nextVideo.dataset.assetId !== asset.assetId) {
    prepareVideo(nextVideo, asset, playlistUrl);
  }

  nextVideo.currentTime = 0;
  startVideoWatchdog(nextVideo);

  try {
    await nextVideo.play();
  } catch (error) {
    if (generation === renderGeneration) {
      failActiveAsset(
        asset.assetId,
        error instanceof Error ? error.message : "browser refused video playback"
      );
    }
    return;
  }

  if (generation !== renderGeneration) {
    nextVideo.pause();
    return;
  }

  clearVideoWatchdog();
  hideImage();
  nextVideo.classList.remove("hidden");
  if (visibleVideo && visibleVideo !== nextVideo) {
    resetVideo(visibleVideo);
  }
  visibleVideo = nextVideo;
  preloadFollowingAsset();
}

function showAsset(index: number): void {
  if (!activePlaylist || !activePlaylistUrl) {
    return;
  }

  const playlist = activePlaylist;
  const playlistUrl = activePlaylistUrl;

  if (playlist.assets.length === 0) {
    playlistNameLabel.textContent = playlist.name;
    assetStatusLabel.textContent = "No assets in playlist";
    currentIndex = 0;
    window.clearTimeout(playbackTimer);
    hideImage();
    hideVideos();
    return;
  }

  const asset = playlist.assets[index] ?? playlist.assets[0];
  currentIndex = index;
  playlistNameLabel.textContent = playlist.name;
  assetStatusLabel.textContent = `Playing ${asset.assetId}`;

  window.clearTimeout(playbackTimer);
  if (asset.type === "video") {
    void showVideoAsset(asset, playlistUrl);
  } else {
    showImageAsset(asset, playlistUrl);
    playbackTimer = window.setTimeout(() => {
      advanceAsset();
    }, Math.max(asset.durationSeconds ?? 1, 1) * 1000);
  }
}

function applyPlaylist(playlist: Playlist, playlistUrl: URL): void {
  const nextSignature = playlistSignature(playlist);

  if (nextSignature === activePlaylistSignature) {
    return;
  }

  const currentAssetId = activePlaylist?.assets[currentIndex]?.assetId;
  const wasPlaying = activePlaylist !== null;
  activePlaylist = playlist;
  activePlaylistUrl = playlistUrl;
  activePlaylistSignature = nextSignature;
  failedAssetIds.clear();

  if (!wasPlaying) {
    showAsset(0);
    return;
  }

  const matchingIndex = playlist.assets.findIndex((asset) => asset.assetId === currentAssetId);

  if (matchingIndex >= 0) {
    currentIndex = matchingIndex;
    playlistNameLabel.textContent = playlist.name;
    preloadFollowingAsset();
    return;
  }

  showAsset(Math.min(currentIndex, Math.max(playlist.assets.length - 1, 0)));
}

async function refreshPlaylist(playlistUrl: URL): Promise<void> {
  try {
    applyPlaylist(await loadPlaylist(playlistUrl), playlistUrl);
  } catch (error) {
    console.error("Playlist refresh failed; keeping last valid playlist", error);
  }
}

playerImage.addEventListener("error", () => {
  const asset = activeAsset();
  if (asset?.type === "image") {
    failActiveAsset(asset.assetId, "image failed to load");
  }
});

for (const videoElement of playerVideos) {
  videoElement.addEventListener("ended", () => {
    if (videoElement === visibleVideo && videoElement.dataset.assetId === activeAsset()?.assetId) {
      advanceAsset();
    }
  });
  videoElement.addEventListener("playing", () => {
    if (videoElement.dataset.assetId === activeAsset()?.assetId) {
      clearVideoWatchdog();
    }
  });
  videoElement.addEventListener("waiting", () => {
    if (videoElement === visibleVideo) {
      startVideoWatchdog(videoElement);
    }
  });
  videoElement.addEventListener("stalled", () => {
    if (videoElement === visibleVideo) {
      startVideoWatchdog(videoElement);
    }
  });
  videoElement.addEventListener("error", () => {
    const assetId = videoElement.dataset.assetId;
    if (assetId && assetId === activeAsset()?.assetId) {
      failActiveAsset(assetId, "video failed to load or decode");
    }
  });
}

fullscreenControl.addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
});

document.addEventListener("fullscreenchange", () => {
  const isFullscreen = document.fullscreenElement !== null;
  document.body.classList.toggle("is-fullscreen", isFullscreen);
  fullscreenControl.textContent = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
});

async function startPlayback(): Promise<void> {
  applyDisplayMode();
  const playlistUrl = playlistUrlFromLocation();
  playlistNameLabel.textContent = "Loading playlist";
  assetStatusLabel.textContent = playlistUrl.pathname;

  const playlist = await loadPlaylist(playlistUrl);
  applyPlaylist(playlist, playlistUrl);
  playlistRefreshTimer = window.setInterval(() => {
    void refreshPlaylist(playlistUrl);
  }, playlistRefreshIntervalMs);
}

startPlayback().catch((error: unknown) => {
  window.clearTimeout(playbackTimer);
  window.clearInterval(playlistRefreshTimer);
  playlistNameLabel.textContent = "Playback unavailable";
  assetStatusLabel.textContent = error instanceof Error ? error.message : "Unknown playback error";
  hideImage();
  hideVideos();
  console.error(error);
});
