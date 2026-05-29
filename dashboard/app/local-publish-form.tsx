"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type PublishResponse = {
  error?: string;
  playlistVersion?: number;
  piPublish?: {
    enabled: boolean;
    ok: boolean;
    message: string;
  };
};

export function LocalPublishForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isPublishing || isPending;

  async function publishNow() {
    if (isBusy) {
      return;
    }

    setMessage("Publishing playlist to Pi...");
    setMessageKind("idle");
    setIsPublishing(true);

    try {
      const response = await fetch("/api/local-playlist/publish", {
        method: "POST"
      });
      const result = (await response.json()) as PublishResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Publish failed.");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      setMessage(`Playlist v${result.playlistVersion} publish recorded.${publishMessage}`);
      setMessageKind(result.piPublish && !result.piPublish.ok ? "warning" : "success");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Publish failed.");
      setMessageKind("error");
    } finally {
      setIsPublishing(false);
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
    <div className="mt-5 flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-sm font-semibold text-zinc-950">Manual publish</h3>
        <p className="mt-1 text-sm text-zinc-600">Copy the current local playlist to the Pi and let VLC reload it.</p>
        {message ? (
          <p className={messageClassName} role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        disabled={isBusy}
        onClick={publishNow}
        className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {isBusy ? "Publishing..." : "Publish now"}
      </button>
    </div>
  );
}
