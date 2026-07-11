"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type PublishHandoffMode = "asset-boundary" | "playlist-boundary";

type PublishResponse = {
  error?: string;
  handoffMode?: PublishHandoffMode;
  playlistVersion?: number;
  piPublish?: {
    assetsChecked?: number;
    assetsCopied?: number;
    assetsRemoved?: number;
    assetsSkipped?: number;
    assetsVerifiedByChecksum?: number;
    assetsVerifiedBySize?: number;
    enabled: boolean;
    ok: boolean;
    message: string;
  };
};

type LocalPublishFormProps = {
  assetCount: number;
  assignedScreenCount: number;
  playlistId: string;
  screenAssignmentHref: string;
};

export function LocalPublishForm({
  assetCount,
  assignedScreenCount,
  playlistId,
  screenAssignmentHref
}: LocalPublishFormProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [publishingMode, setPublishingMode] = useState<PublishHandoffMode | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = Boolean(publishingMode) || isPending;
  const canPublish = assetCount > 0;

  function guideToScreenAssignment() {
    setMessage("Choose at least one screen before publishing.");
    setMessageKind("warning");
    startTransition(() => router.push(screenAssignmentHref));
  }

  async function publishPlaylist(handoffMode: PublishHandoffMode) {
    if (isBusy || !canPublish) {
      if (!canPublish) {
        setMessage("Add media first.");
        setMessageKind("warning");
      }
      return;
    }

    if (assignedScreenCount === 0) {
      guideToScreenAssignment();
      return;
    }

    setMessage(handoffMode === "asset-boundary" ? "Publishing now..." : "Publishing...");
    setMessageKind("idle");
    setPublishingMode(handoffMode);

    try {
      const response = await fetch("/api/local-playlist/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ handoffMode, playlistId })
      });
      const result = (await response.json()) as PublishResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Publish failed.");
      }

      const publishMessage = result.piPublish?.message ?? "Publish saved.";
      setMessage(publishMessage);
      setMessageKind(result.piPublish && !result.piPublish.ok ? "warning" : "success");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Publish failed.");
      setMessageKind("error");
    } finally {
      setPublishingMode(null);
    }
  }

  const messageClassName =
    messageKind === "error"
      ? "mt-2 text-xs font-medium text-red-700"
      : messageKind === "warning"
        ? "mt-2 text-xs font-medium text-amber-800"
        : messageKind === "success"
          ? "mt-2 text-xs font-medium text-emerald-700"
          : "mt-2 text-xs font-medium text-zinc-600";

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <button
          type="button"
          disabled={isBusy || !canPublish}
          onClick={() => void publishPlaylist("playlist-boundary")}
          className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {publishingMode === "playlist-boundary" ? "Publishing..." : "Publish to assigned screens"}
        </button>
        <button
          type="button"
          disabled={isBusy || !canPublish}
          onClick={() => void publishPlaylist("asset-boundary")}
          title="Switch after the current video finishes"
          aria-label="Publish now after the current video finishes"
          className="min-h-11 rounded-md border border-teal-300 bg-white px-4 py-2 text-sm font-semibold text-teal-900 hover:bg-teal-50 disabled:cursor-not-allowed disabled:border-zinc-300 disabled:bg-zinc-100 disabled:text-zinc-500"
        >
          {publishingMode === "asset-boundary" ? "Publishing..." : "Publish now"}
        </button>
      </div>
      {message ? (
        <p className={messageClassName} role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
