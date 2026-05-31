"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type VisualConfirmationResponse = {
  error?: string;
  message?: string;
};

export function VisualConfirmationControl() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isSaving || isPending;

  async function confirmVisible() {
    if (isBusy) {
      return;
    }

    setMessage("Saving visual check...");
    setIsSaving(true);

    try {
      const response = await fetch("/api/visual-confirmation", {
        method: "POST"
      });
      const result = (await response.json()) as VisualConfirmationResponse;

      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save visual check.");
      }

      setMessage(result.message ?? "Visual check saved.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save visual check.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
      <button
        type="button"
        disabled={isBusy}
        onClick={confirmVisible}
        className="min-h-10 rounded-md bg-amber-900 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-950 disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {isBusy ? "Saving..." : "I can see the screen"}
      </button>
      {message ? (
        <p className="text-sm font-medium text-amber-900" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
