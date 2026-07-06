"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ScreenSnapshotButtonProps = {
  disabled?: boolean;
  deviceId: string | null;
};

export function ScreenSnapshotButton({ disabled = false, deviceId }: ScreenSnapshotButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const busy = disabled || isPending || !deviceId;

  async function queueSnapshot() {
    if (!deviceId || busy) {
      return;
    }

    setMessage("Snapshot queued.");
    const response = await fetch(`/api/cloud/devices/${encodeURIComponent(deviceId)}/actions`, {
      body: JSON.stringify({ action: "screen-snapshot" }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!response.ok) {
      setMessage(body.error ?? "Snapshot could not be queued.");
      return;
    }

    setMessage(body.message ?? "Snapshot queued.");
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="beam-preview-button inline-flex min-h-10 shrink-0 items-center justify-center rounded-md px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={busy}
        onClick={queueSnapshot}
        title="Capture a live snapshot from the selected Pi display"
      >
        Snapshot
      </button>
      {message ? <p className="max-w-40 text-right text-xs font-semibold text-white/80">{message}</p> : null}
    </div>
  );
}
