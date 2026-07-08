"use client";

import { useEffect, useRef, useState } from "react";

export type RemoteScreenAsset = {
  assetId: string;
  assetUrlEndpoint: string | null;
  durationSeconds: number | null;
  fileName: string;
  title: string;
  type: "image" | "video";
};

type RemoteScreenPlayerProps = {
  asset: RemoteScreenAsset | null;
  detail: string;
  hostLabel: string;
  lastReportLabel: string;
  playlistName: string;
  playbackStateLabel: string;
  reportNote: string;
  screenName: string;
};

type SignedAssetState = {
  error: string | null;
  loading: boolean;
  url: string | null;
};

function formatDurationSeconds(value: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const totalSeconds = Math.round(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

export function RemoteScreenPlayer({
  asset,
  detail,
  hostLabel,
  lastReportLabel,
  playlistName,
  playbackStateLabel,
  reportNote,
  screenName
}: RemoteScreenPlayerProps) {
  const durationLabel = formatDurationSeconds(asset?.durationSeconds ?? null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [signedAsset, setSignedAsset] = useState<SignedAssetState>({
    error: null,
    loading: Boolean(asset?.assetUrlEndpoint),
    url: null
  });

  useEffect(() => {
    if (!asset) {
      setSignedAsset({ error: null, loading: false, url: null });
      return;
    }

    if (!asset.assetUrlEndpoint) {
      setSignedAsset({ error: null, loading: false, url: null });
      return;
    }

    const controller = new AbortController();
    setSignedAsset({ error: null, loading: true, url: null });

    fetch(asset.assetUrlEndpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { error?: string; url?: string };
        if (!response.ok || !body.url) {
          throw new Error(body.error ?? "Could not load a signed media URL.");
        }
        setSignedAsset({ error: null, loading: false, url: body.url });
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setSignedAsset({
          error: error instanceof Error ? error.message : "Could not load this media item.",
          loading: false,
          url: null
        });
      });

    return () => controller.abort();
  }, [asset]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !signedAsset.url) {
      return;
    }

    video.load();
    void video.play().catch(() => {
      // Muted autoplay usually works, but controls remain available when it does not.
    });
  }, [signedAsset.url]);

  return (
    <main className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-emerald-300">Beam live report</p>
            <h1 className="mt-1 break-words text-3xl font-semibold">{screenName}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">{detail}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
            <span className="rounded-full border border-white/15 px-3 py-1">{playbackStateLabel}</span>
            <span className="rounded-full border border-white/15 px-3 py-1">Last update {lastReportLabel}</span>
            <span className="rounded-full border border-white/15 px-3 py-1">{hostLabel}</span>
          </div>
        </header>

        <section className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-h-[22rem] items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black">
            {asset && signedAsset.url && asset.type === "video" ? (
              <video
                ref={videoRef}
                className="max-h-[calc(100vh-12rem)] w-full object-contain"
                autoPlay
                controls
                muted
                playsInline
                preload="metadata"
              >
                <source src={signedAsset.url} type="video/mp4" />
              </video>
            ) : null}

            {asset && signedAsset.url && asset.type === "image" ? (
              <img
                alt={asset.title}
                className="max-h-[calc(100vh-12rem)] w-full object-contain"
                src={signedAsset.url}
              />
            ) : null}

            {signedAsset.loading ? (
              <div className="px-5 text-center text-sm font-semibold text-zinc-300">Loading reported media item...</div>
            ) : null}

            {signedAsset.error ? (
              <div className="mx-5 max-w-xl rounded-md border border-red-400/40 bg-red-950/60 p-5 text-sm text-red-100">
                <p className="font-semibold">Beam could not preview the reported media item.</p>
                <p className="mt-2">{signedAsset.error}</p>
              </div>
            ) : null}

            {asset && !signedAsset.loading && !signedAsset.url && !signedAsset.error ? (
              <div className="mx-5 max-w-xl rounded-md border border-white/10 bg-zinc-900 p-5 text-sm text-zinc-200">
                <p className="font-semibold">Current item reported</p>
                <p className="mt-2">{asset.title}</p>
                <p className="mt-2 text-zinc-400">Beam does not have a matching signed media release for this report yet.</p>
              </div>
            ) : null}

            {!asset && !signedAsset.loading ? (
              <div className="mx-5 max-w-xl rounded-md border border-white/10 bg-zinc-900 p-5 text-sm text-zinc-200">
                <p className="font-semibold">No current item reported</p>
                <p className="mt-2">Beam has not received a current media item from this screen yet.</p>
              </div>
            ) : null}
          </div>

          <aside className="rounded-lg border border-white/10 bg-zinc-900 p-5">
            <h2 className="text-lg font-semibold">What Beam knows</h2>
            <dl className="mt-5 grid gap-4 text-sm">
              <div>
                <dt className="text-xs font-semibold uppercase text-zinc-400">Current item</dt>
                <dd className="mt-1 break-words font-semibold text-white">{asset?.title ?? "Not reported"}</dd>
                {durationLabel ? (
                  <dd className="mt-1 text-zinc-400">{durationLabel}</dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase text-zinc-400">Playlist</dt>
                <dd className="mt-1 break-words font-semibold text-white">{playlistName}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase text-zinc-400">Screen</dt>
                <dd className="mt-1 break-words font-semibold text-white">{screenName}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase text-zinc-400">Source</dt>
                <dd className="mt-1 leading-6 text-zinc-300">{reportNote}</dd>
              </div>
            </dl>
          </aside>
        </section>
      </div>
    </main>
  );
}
