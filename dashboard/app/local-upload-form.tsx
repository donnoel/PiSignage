"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type UploadState = {
  message: string;
  kind: "idle" | "success" | "error";
};

type UploadResponse = {
  assetId?: string;
  error?: string;
  piPublish?: {
    enabled: boolean;
    ok: boolean;
    message: string;
  };
};

export function LocalUploadForm() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState("No file selected");
  const [uploadState, setUploadState] = useState<UploadState>({
    message: "Select an MP4 file to append it to the local playlist.",
    kind: "idle"
  });
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setUploadState({ message: "Choose an MP4 file first.", kind: "error" });
      return;
    }

    const formData = new FormData();
    formData.append("video", file);
    setUploadState({ message: `Uploading ${file.name}...`, kind: "idle" });

    try {
      const response = await fetch("/api/local-playlist/upload", {
        method: "POST",
        body: formData
      });
      const result = (await response.json()) as UploadResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Upload failed");
      }

      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setSelectedFileName("No file selected");
      setUploadState({
        message: `Added ${result.assetId ?? file.name} to the local playlist.${publishMessage}`,
        kind: result.piPublish && !result.piPublish.ok ? "error" : "success"
      });
      startTransition(() => router.refresh());
    } catch (error) {
      setUploadState({
        message: error instanceof Error ? error.message : "Upload failed",
        kind: "error"
      });
    }
  }

  const statusClassName =
    uploadState.kind === "error"
      ? "text-sm font-medium text-red-700"
      : uploadState.kind === "success"
        ? "text-sm font-medium text-emerald-700"
        : "text-sm text-zinc-600";

  return (
    <form onSubmit={handleSubmit} className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 p-4">
      <label htmlFor="local-video-upload" className="block text-sm font-medium text-zinc-700">
        Add local MP4
      </label>
      <div className="mt-3 grid gap-3">
        <input
          ref={fileInputRef}
          id="local-video-upload"
          name="video"
          type="file"
          accept="video/mp4,.mp4"
          className="sr-only"
          onChange={(event) => setSelectedFileName(event.currentTarget.files?.[0]?.name ?? "No file selected")}
        />
        <div className="grid gap-2">
          <label
            htmlFor="local-video-upload"
            className="inline-flex min-h-11 w-fit cursor-pointer items-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white focus-within:outline-none focus-within:ring-2 focus-within:ring-teal-600"
          >
            Choose File
          </label>
          <p className="min-w-0 break-words text-sm text-zinc-600">{selectedFileName}</p>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="min-h-11 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {isPending ? "Refreshing" : "Upload and append"}
        </button>
      </div>
      <p className={`mt-3 ${statusClassName}`} role="status" aria-live="polite">
        {uploadState.message}
      </p>
    </form>
  );
}
