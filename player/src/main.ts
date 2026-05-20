import playlistData from "../../sample-content/playlist.local.json";
import welcomeImageUrl from "../../sample-content/assets/welcome.svg?url";
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

const playlist = playlistData as Playlist;
const assetUrlById: Record<string, string> = {
  "asset-welcome": welcomeImageUrl
};

const image = document.querySelector<HTMLImageElement>("#asset");
const playlistName = document.querySelector<HTMLSpanElement>("#playlist-name");
const assetStatus = document.querySelector<HTMLSpanElement>("#asset-status");
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen-button");

let currentIndex = 0;
let playbackTimer: number | undefined;

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

function imageUrlFor(asset: PlaylistAsset): string {
  return assetUrlById[asset.assetId] ?? asset.uri;
}

function showAsset(index: number): void {
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
  playerImage.src = imageUrlFor(asset);
  playerImage.alt = asset.altText;

  window.clearTimeout(playbackTimer);
  playbackTimer = window.setTimeout(() => {
    showAsset((currentIndex + 1) % playlist.assets.length);
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

showAsset(0);
