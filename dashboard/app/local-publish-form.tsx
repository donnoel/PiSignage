"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type PublishResponse = {
  error?: string;
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
  assignmentTargetId: string;
  playlistId: string;
};

export function LocalPublishForm({
  assetCount,
  assignedScreenCount,
  assignmentTargetId,
  playlistId
}: LocalPublishFormProps) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"idle" | "success" | "warning" | "error">("idle");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isBusy = isPublishing || isPending;
  const canPublish = assetCount > 0;

  function guideToScreenAssignment() {
    const target = document.getElementById(assignmentTargetId);

    setMessage("Choose at least one screen before publishing.");
    setMessageKind("warning");

    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    target.classList.add("ring-2", "ring-amber-300", "ring-offset-2", "ring-offset-[#f3f6f8]");
    window.setTimeout(() => {
      target.classList.remove("ring-2", "ring-amber-300", "ring-offset-2", "ring-offset-[#f3f6f8]");
    }, 2200);
  }

  async function publishNow() {
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

    setMessage("Publishing...");
    setMessageKind("idle");
    setIsPublishing(true);

    try {
      const response = await fetch("/api/local-playlist/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ playlistId })
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
    <div className="mt-4 border-t border-zinc-200 pt-4">
      <button
        type="button"
        disabled={isBusy || !canPublish}
        onClick={publishNow}
        className="min-h-11 w-full rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {isBusy ? "Publishing..." : "Publish"}
      </button>
      {message ? (
        <p className={messageClassName} role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
