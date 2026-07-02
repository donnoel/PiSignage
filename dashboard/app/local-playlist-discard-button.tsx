"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type DiscardDraftResponse = {
  action?: "deleted" | "restored";
  error?: string;
  nextPlaylistId?: string;
};

type LocalPlaylistDiscardButtonProps = {
  name: string;
  playlistId: string;
};

export function LocalPlaylistDiscardButton({ name, playlistId }: LocalPlaylistDiscardButtonProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"idle" | "success" | "error">("idle");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function discardDraft() {
    if (isBusy) {
      return;
    }

    const confirmed = window.confirm(
      `Discard draft changes to "${name}"?\n\nBeam will restore the last published version when one exists. If this playlist has never been published, Beam will delete the draft.\n\nThis does not publish a change to any screen.`
    );
    if (!confirmed) {
      return;
    }

    setMessage("Discarding draft...");
    setMessageKind("idle");
    setIsSaving(true);

    try {
      const response = await fetch("/api/local-playlists", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ discardDraft: true, playlistId })
      });
      const result = (await response.json()) as DiscardDraftResponse;

      if (!response.ok || !result.nextPlaylistId) {
        throw new Error(result.error ?? "Could not discard draft.");
      }

      setMessage(result.action === "deleted" ? "Draft deleted." : "Draft discarded.");
      setMessageKind("success");
      startTransition(() => {
        router.push(`/?view=playlist&playlist=${encodeURIComponent(result.nextPlaylistId as string)}&playlistStep=publish`);
        router.refresh();
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not discard draft.");
      setMessageKind("error");
    } finally {
      setIsSaving(false);
    }
  }

  const messageClassName =
    messageKind === "error"
      ? "mt-2 text-xs font-medium text-red-700"
      : messageKind === "success"
        ? "mt-2 text-xs font-medium text-emerald-700"
        : "mt-2 text-xs font-medium text-zinc-600";

  return (
    <div>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => void discardDraft()}
        className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
      >
        {isBusy ? "Discarding..." : "Discard draft"}
      </button>
      {message ? (
        <p className={messageClassName} role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
