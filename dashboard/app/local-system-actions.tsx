"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type SystemActionResponse = {
  error?: string;
  message?: string;
};

export function LocalSystemActions() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isRestarting, setIsRestarting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isRestarting || isPending;

  function refreshStatus() {
    startTransition(() => router.refresh());
  }

  async function restartPlayer() {
    if (isBusy) {
      return;
    }

    setMessage("Restarting VLC field player...");
    setIsRestarting(true);

    try {
      const response = await fetch("/api/local-player/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "restart-vlc" })
      });
      const result = (await response.json()) as SystemActionResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Player restart failed.");
      }

      setMessage(result.message ?? "Restart command sent.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Player restart failed.");
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-semibold">System actions</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-600">
        Local controls for the Pi field player. Keep these narrow while the foundation is being proven.
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={isBusy}
          onClick={restartPlayer}
          className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {isBusy ? "Working..." : "Restart VLC"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={refreshStatus}
          className="min-h-11 rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh status
        </button>
      </div>
      {message ? (
        <p className="mt-3 text-sm font-medium text-zinc-600" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
