"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "./dashboard-ui";

type DiagnosticItem = {
  detail: string;
  label: string;
  status: "error" | "ok" | "warning";
};

type ActivityRecord = {
  action: string;
  id: string;
  message: string;
  result: "error" | "success" | "warning";
  timestamp: string;
};

type RecoveryStep = {
  detail: string;
  finishedAt: string;
  id: string;
  status: "failed" | "succeeded";
  title: string;
};

type RecoveryRun = {
  finishedAt: string;
  id: string;
  ok: boolean;
  steps: RecoveryStep[];
  summary: string;
};

type TroubleshootingResponse = {
  activity: ActivityRecord[];
  error?: string;
  pi: {
    adminUrl: string | null;
    configured: boolean;
    diagnostics: DiagnosticItem[];
    host: string | null;
    logs: string;
    playerUrl: string | null;
    reachable: boolean;
    sshCommand: string | null;
    sshUrl: string | null;
  };
  recoveryRuns: RecoveryRun[];
};

type ActionResponse = {
  error?: string;
  message?: string;
  piPublish?: {
    message: string;
    ok: boolean;
  };
  playlistVersion?: number;
};

function toneFromDiagnostic(status: DiagnosticItem["status"]): "good" | "muted" | "warn" {
  if (status === "ok") {
    return "good";
  }

  return status === "error" ? "warn" : "muted";
}

function toneFromResult(result: ActivityRecord["result"]): "good" | "muted" | "warn" {
  if (result === "success") {
    return "good";
  }

  return result === "error" ? "warn" : "muted";
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

export function TroubleshootingPanel() {
  const router = useRouter();
  const [data, setData] = useState<TroubleshootingResponse | null>(null);
  const [message, setMessage] = useState("Loading troubleshooting data...");
  const [copyMessage, setCopyMessage] = useState("");
  const [busyAction, setBusyAction] = useState<"publish" | "recover" | "refresh" | "restart" | null>(null);
  const [isPending, startTransition] = useTransition();
  const isBusy = Boolean(busyAction) || isPending;

  async function loadTroubleshooting() {
    setBusyAction((current) => current ?? "refresh");
    try {
      const response = await fetch("/api/local-troubleshooting", { cache: "no-store" });
      const result = (await response.json()) as TroubleshootingResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load troubleshooting data.");
      }
      setData(result);
      setMessage("Troubleshooting data loaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load troubleshooting data.");
      setData(null);
    } finally {
      setBusyAction((current) => (current === "refresh" ? null : current));
    }
  }

  useEffect(() => {
    void loadTroubleshooting();
  }, []);

  async function copySshCommand() {
    if (!data?.pi.sshCommand) {
      return;
    }

    try {
      await navigator.clipboard.writeText(data.pi.sshCommand);
      setCopyMessage("SSH command copied.");
    } catch {
      setCopyMessage("Copy failed. Select the command manually.");
    }
  }

  async function postJson(path: string, body?: unknown): Promise<ActionResponse> {
    const response = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const result = (await response.json()) as ActionResponse;
    if (!response.ok || result.error) {
      throw new Error(result.error ?? "Action failed.");
    }

    return result;
  }

  async function runAction(action: "publish" | "recover" | "restart") {
    if (isBusy) {
      return;
    }

    setBusyAction(action);
    setMessage(
      action === "publish"
        ? "Retrying publish..."
        : action === "restart"
          ? "Restarting VLC..."
          : "Running recovery..."
    );

    try {
      const result =
        action === "publish"
          ? await postJson("/api/local-playlist/publish")
          : await postJson("/api/local-player/actions", {
              action: action === "restart" ? "restart-vlc" : "recover"
            });
      const publishMessage = result.piPublish?.message ? ` ${result.piPublish.message}` : "";
      setMessage(result.message ?? `Playlist v${result.playlistVersion} publish recorded.${publishMessage}`);
      await loadTroubleshooting();
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  const diagnostics = data?.pi.diagnostics ?? [];
  const logs = data?.pi.logs ?? "No logs loaded.";
  const recoveryRuns = data?.recoveryRuns ?? [];
  const activity = data?.activity ?? [];

  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Support tools</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              Diagnostics, recovery controls, Pi access helpers, and recent operational evidence.
            </p>
          </div>
          <StatusPill
            label={data?.pi.reachable ? "Pi reachable" : data?.pi.configured ? "Pi unavailable" : "Pi not configured"}
            tone={data?.pi.reachable ? "good" : "warn"}
          />
        </div>

        <div className="grid gap-4 p-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <h3 className="text-base font-semibold">Access helpers</h3>
            <div className="mt-4 grid gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-zinc-500">SSH</p>
                <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-center">
                  <code className="min-h-10 flex-1 overflow-x-auto rounded-md bg-white px-3 py-2 text-sm text-zinc-900 ring-1 ring-zinc-200">
                    {data?.pi.sshCommand ?? "Pi SSH is not configured"}
                  </code>
                  <button
                    type="button"
                    disabled={!data?.pi.sshCommand}
                    onClick={copySshCommand}
                    className="min-h-10 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Copy
                  </button>
                  {data?.pi.sshUrl ? (
                    <a
                      href={data.pi.sshUrl}
                      className="inline-flex min-h-10 items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800"
                    >
                      Open SSH
                    </a>
                  ) : null}
                </div>
                {copyMessage ? <p className="mt-2 text-xs font-medium text-zinc-600">{copyMessage}</p> : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {data?.pi.playerUrl ? (
                  <a
                    href={data.pi.playerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white"
                  >
                    Open Pi player
                  </a>
                ) : null}
                {data?.pi.adminUrl ? (
                  <a
                    href={data.pi.adminUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-10 items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800"
                  >
                    Open admin UI
                  </a>
                ) : (
                  <span className="inline-flex min-h-10 items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600">
                    Admin UI not configured
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <h3 className="text-base font-semibold">Actions</h3>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void runAction("publish")}
                className="min-h-10 rounded-md bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {busyAction === "publish" ? "Publishing..." : "Retry publish"}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void runAction("restart")}
                className="min-h-10 rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {busyAction === "restart" ? "Restarting..." : "Restart VLC"}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void runAction("recover")}
                className="min-h-10 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {busyAction === "recover" ? "Recovering..." : "Recover"}
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void loadTroubleshooting()}
                className="min-h-10 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busyAction === "refresh" ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            {message ? (
              <p className="mt-3 text-sm font-medium text-zinc-600" role="status" aria-live="polite">
                {message}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Diagnostics</h3>
        </div>
        <ol className="divide-y divide-zinc-200">
          {diagnostics.map((item) => (
            <li key={item.label} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[180px_1fr_auto]">
              <p className="font-semibold text-zinc-950">{item.label}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs leading-5 text-zinc-700">
                {item.detail}
              </pre>
              <div className="md:justify-self-end">
                <StatusPill label={item.status === "ok" ? "OK" : item.status === "error" ? "Error" : "Review"} tone={toneFromDiagnostic(item.status)} />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <h3 className="text-lg font-semibold">Recent Pi logs</h3>
          </div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-5 text-xs leading-5 text-zinc-700">
            {logs}
          </pre>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <h3 className="text-lg font-semibold">Recovery history</h3>
          </div>
          <ol className="divide-y divide-zinc-200">
            {recoveryRuns.map((run) => (
              <li key={run.id} className="p-5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-zinc-950">{formatTimestamp(run.finishedAt)}</p>
                  <StatusPill label={run.ok ? "Completed" : "Needs review"} tone={run.ok ? "good" : "warn"} />
                </div>
                <p className="mt-2 text-zinc-700">{run.summary}</p>
                <p className="mt-1 text-xs text-zinc-500">{run.steps.length} logged steps</p>
              </li>
            ))}
            {recoveryRuns.length === 0 ? (
              <li className="p-5 text-sm text-zinc-600">No recovery runs recorded yet.</li>
            ) : null}
          </ol>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Activity log</h3>
        </div>
        <ol className="divide-y divide-zinc-200">
          {activity.map((item) => (
            <li key={item.id} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[180px_1fr_auto]">
              <div>
                <p className="font-semibold text-zinc-950">{item.action}</p>
                <p className="mt-1 text-xs text-zinc-500">{formatTimestamp(item.timestamp)}</p>
              </div>
              <p className="leading-6 text-zinc-700">{item.message}</p>
              <div className="md:justify-self-end">
                <StatusPill label={item.result} tone={toneFromResult(item.result)} />
              </div>
            </li>
          ))}
          {activity.length === 0 ? (
            <li className="p-5 text-sm text-zinc-600">No activity recorded yet.</li>
          ) : null}
        </ol>
      </section>
    </div>
  );
}
