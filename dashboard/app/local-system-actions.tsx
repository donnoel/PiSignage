"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type RecoveryStep = {
  detail: string;
  finishedAt: string;
  id: string;
  startedAt: string;
  status: "failed" | "succeeded";
  title: string;
};

type RecoveryRun = {
  finishedAt: string;
  id: string;
  startedAt: string;
  steps: RecoveryStep[];
  summary: string;
  triggeredBy: string;
  ok: boolean;
};

type SystemActionResponse = {
  error?: string;
  latestRun?: RecoveryRun | null;
  message?: string;
  run?: RecoveryRun;
};

export function LocalSystemActions() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [latestRun, setLatestRun] = useState<RecoveryRun | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = isRestarting || isRecovering || isPending;

  useEffect(() => {
    let active = true;

    async function loadLatestRun() {
      try {
        const response = await fetch("/api/local-player/actions", { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const result = (await response.json()) as SystemActionResponse;
        if (active) {
          setLatestRun(result.latestRun ?? null);
        }
      } catch {
        // Keep controls usable even if recovery history cannot load.
      }
    }

    void loadLatestRun();
    return () => {
      active = false;
    };
  }, []);

  function refreshStatus() {
    startTransition(() => router.refresh());
  }

  function formatTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
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

  async function runRecover() {
    if (isBusy) {
      return;
    }

    setMessage("Running recovery...");
    setIsRecovering(true);

    try {
      const response = await fetch("/api/local-player/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "recover" })
      });
      const result = (await response.json()) as SystemActionResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Recover failed.");
      }

      setLatestRun(result.run ?? null);
      setMessage(result.message ?? "Recover completed.");
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Recover failed.");
    } finally {
      setIsRecovering(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-semibold">System actions</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-600">
        Local controls for the Pi field player. Use Recover to restart playback safely and capture step-by-step evidence.
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
          disabled={isBusy}
          onClick={runRecover}
          className="min-h-11 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-300"
        >
          {isRecovering ? "Recovering..." : "Recover"}
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
      {latestRun ? (
        <section className="mt-4 border-t border-zinc-200 pt-4" aria-label="Latest recovery run">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-900">Latest recover run</h3>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                latestRun.ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
              }`}
            >
              {latestRun.ok ? "Completed" : "Needs review"}
            </span>
            <p className="text-xs text-zinc-500">{formatTimestamp(latestRun.finishedAt)}</p>
          </div>
          <p className="mt-2 text-sm text-zinc-700">{latestRun.summary}</p>
          <ol className="mt-3 space-y-2">
            {latestRun.steps.map((step) => (
              <li key={step.id} className="rounded-md border border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900">{step.title}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      step.status === "succeeded" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    {step.status === "succeeded" ? "Success" : "Failed"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-600">{step.detail}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
