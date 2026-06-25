"use client";

import { useEffect, useState } from "react";
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

type TroubleshootingScreen = {
  deviceHost: string | null;
  deviceId: string | null;
  deviceName: string | null;
  group: string;
  id: string;
  location: string;
  name: string;
  playlistName: string | null;
};

type TroubleshootingPanelProps = {
  screens: TroubleshootingScreen[];
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

function diagnosticByLabel(items: DiagnosticItem[], label: string): DiagnosticItem | null {
  return items.find((item) => item.label === label) ?? null;
}

function extractLineValue(detail: string, key: string): string | null {
  const line = detail
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${key}=`));

  return line?.slice(key.length + 1).trim() || null;
}

function extractDisplayMode(detail: string): string | null {
  const connector = detail.match(/Connector\s+\d+\s+\(\d+\)\s+([A-Z0-9-]+)/);
  const mode = detail.match(/(\d{3,4}x\d{3,4}@\d+(?:\.\d+)?)/);

  if (connector?.[1] && mode?.[1]) {
    return `${connector[1]} ${mode[1]}`;
  }

  return mode?.[1] ?? connector?.[1] ?? null;
}

function summarizePlayer(detail: string): string {
  if (detail.includes("player-status-missing")) {
    return "Status file missing";
  }

  try {
    const parsed = JSON.parse(detail) as {
      currentAssetId?: string;
      currentPlaylistId?: string;
      mode?: string;
      state?: string;
      status?: string;
    };
    const state = parsed.state ?? parsed.status ?? parsed.mode;
    const asset = parsed.currentAssetId;

    if (state && asset) {
      return `${state}: ${asset}`;
    }

    return state ?? asset ?? parsed.currentPlaylistId ?? "Status file present";
  } catch {
    return detail.trim() ? "Status file present" : "Not reported";
  }
}

function networkRouteInterface(detail: string): string | null {
  return detail.match(/^defaultRoute=.*\bdev\s+(\S+)/m)?.[1] ?? null;
}

function networkInterfaceIsUp(detail: string, iface: "eth0" | "wlan0"): boolean {
  const state = extractLineValue(detail, `${iface}OperState`);
  if (state === "up") {
    return true;
  }

  return detail
    .split("\n")
    .some((line) => line.trim().startsWith(`${iface} `) && line.includes(" UP "));
}

function summarizeNetwork(detail: string): string {
  const routeInterface = networkRouteInterface(detail);
  const ethernetUp = networkInterfaceIsUp(detail, "eth0");
  const wifiUp = networkInterfaceIsUp(detail, "wlan0");

  if (ethernetUp && wifiUp && routeInterface) {
    return `Both connected (${routeInterface} route)`;
  }

  if (routeInterface === "eth0") {
    return "Ethernet active";
  }

  if (routeInterface === "wlan0") {
    return "Wi-Fi active";
  }

  if (ethernetUp && wifiUp) {
    return "Both connected";
  }

  if (ethernetUp) {
    return "Ethernet connected";
  }

  if (wifiUp) {
    return "Wi-Fi connected";
  }

  return "No active network route";
}

function summarizeDiagnostic(item: DiagnosticItem | null): string {
  if (!item) {
    return "Not reported";
  }

  if (item.label === "VLC service") {
    const activeState = extractLineValue(item.detail, "ActiveState");
    const subState = extractLineValue(item.detail, "SubState");
    const restarts = extractLineValue(item.detail, "NRestarts");
    const state = [activeState, subState].filter(Boolean).join(" / ");

    return [state || "Not reported", restarts ? `${restarts} restarts` : null].filter(Boolean).join(", ");
  }

  if (item.label === "Player status") {
    return summarizePlayer(item.detail);
  }

  if (item.label === "Network") {
    return summarizeNetwork(item.detail);
  }

  if (item.label === "Display") {
    return extractDisplayMode(item.detail) ?? "Display evidence unavailable";
  }

  if (item.label === "Health") {
    const uptime = extractLineValue(item.detail, "uptime");
    const temp = extractLineValue(item.detail, "temp")?.replace(/^temp=/, "");
    const throttle = extractLineValue(item.detail, "throttle")?.replace(/^throttled=/, "");

    return [uptime, temp, throttle ? `throttle ${throttle}` : null].filter(Boolean).join(", ") || "Not reported";
  }

  return item.detail;
}

function guidanceForDiagnostic(item: DiagnosticItem | null): string {
  if (!item) {
    return "No evidence returned by the last refresh.";
  }

  if (item.status === "ok") {
    return "Evidence looks healthy from the last refresh.";
  }

  if (item.label === "Pi SSH") {
    return "Check Pi power, network, SSH settings, and dashboard/.env.local.";
  }

  if (item.label === "VLC service") {
    return "Try Restart VLC first, then Recover if playback does not return.";
  }

  if (item.label === "Player status") {
    return "Recover can reload the playlist and refresh player evidence.";
  }

  if (item.label === "Network") {
    return "Confirms whether Beam is reaching the Pi through Ethernet or Wi-Fi without exposing Wi-Fi credentials.";
  }

  if (item.label === "Display") {
    return "Confirm the TV is connected and the Pi display stack is reporting a mode.";
  }

  if (item.label === "Health") {
    return "Review temperature, throttle, and uptime before heavier recovery steps.";
  }

  return "Review the raw evidence before taking action.";
}

function actionLabel(action: ActivityRecord["action"]): string {
  return action
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isTroubleshootingActivity(item: ActivityRecord): boolean {
  return /publish|recover|recovery|restart|player|vlc|troubleshoot/i.test(`${item.action} ${item.message}`);
}

function dedupeActivity(items: ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>();
  const deduped: ActivityRecord[] = [];

  for (const item of items) {
    const key = `${item.action}|${item.message}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function screenCountLabel(count: number): string {
  return `${count} ${count === 1 ? "screen" : "screens"}`;
}

function recoveryTone(run: RecoveryRun | null): "good" | "muted" | "warn" {
  if (!run) {
    return "muted";
  }

  return run.ok ? "good" : "warn";
}

function normalizeIdentity(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function unavailableStateCards(screen: TroubleshootingScreen | null): Array<{
  detail: string;
  label: string;
  tone: "good" | "muted" | "warn";
  value: string;
}> {
  const screenName = screen?.name ?? "Selected screen";
  const host = screen?.deviceHost ?? "No Pi host saved";

  return [
    {
      detail: `${screenName} is saved in local inventory at ${host}. Beam has not collected live diagnostics from this Pi yet.`,
      label: "Pi access",
      tone: "muted",
      value: "Inventory only"
    },
    {
      detail: "Service state is not available until this screen has a live diagnostics path.",
      label: "VLC service",
      tone: "muted",
      value: "No live evidence"
    },
    {
      detail: "Network route evidence is not available until this screen has a live diagnostics path.",
      label: "Network",
      tone: "muted",
      value: "Not reported"
    },
    {
      detail: "Playback may continue locally, but Beam has not received a player status report from this screen.",
      label: "Player status",
      tone: "muted",
      value: "Not reported"
    },
    {
      detail: "Display mode is not available until this Pi reports diagnostics.",
      label: "Display",
      tone: "muted",
      value: "Not reported"
    },
    {
      detail: "Temperature, throttle, and uptime are not available for this screen yet.",
      label: "Health",
      tone: "muted",
      value: "Not reported"
    },
    {
      detail: "Recovery history is currently tied to the configured live Pi, not this inventory-only screen.",
      label: "Last recovery",
      tone: "muted",
      value: "No screen-specific run"
    }
  ];
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

export function TroubleshootingPanel({ screens }: TroubleshootingPanelProps) {
  const [data, setData] = useState<TroubleshootingResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [screenFilter, setScreenFilter] = useState("");
  const [selectedScreenId, setSelectedScreenId] = useState<string | null>(screens[0]?.id ?? null);

  async function loadTroubleshooting() {
    try {
      const response = await fetch("/api/local-troubleshooting", { cache: "no-store" });
      const result = (await response.json()) as TroubleshootingResponse;
      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not load troubleshooting data.");
      }
      setData(result);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load troubleshooting data.");
      setData(null);
    }
  }

  useEffect(() => {
    void loadTroubleshooting();
  }, []);

  const diagnostics = data?.pi.diagnostics ?? [];
  const logs = data?.pi.logs ?? "No logs loaded.";
  const recoveryRuns = data?.recoveryRuns ?? [];
  const latestRecovery = recoveryRuns[0] ?? null;
  const troubleshootingActivity = dedupeActivity((data?.activity ?? []).filter(isTroubleshootingActivity)).slice(0, 8);
  const serviceDiagnostic = diagnosticByLabel(diagnostics, "VLC service");
  const networkDiagnostic = diagnosticByLabel(diagnostics, "Network");
  const playerDiagnostic = diagnosticByLabel(diagnostics, "Player status");
  const displayDiagnostic = diagnosticByLabel(diagnostics, "Display");
  const healthDiagnostic = diagnosticByLabel(diagnostics, "Health");
  const filteredScreens = screens.filter((screen) => {
    const query = screenFilter.trim().toLowerCase();
    if (!query) {
      return true;
    }

    return [screen.name, screen.location, screen.group, screen.deviceHost, screen.deviceName, screen.playlistName]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(query));
  });
  const selectedScreen =
    screens.find((screen) => screen.id === selectedScreenId) ?? filteredScreens[0] ?? screens[0] ?? null;
  const liveHost = normalizeIdentity(data?.pi.host ?? null);
  const selectedHost = normalizeIdentity(selectedScreen?.deviceHost ?? null);
  const selectedHasLiveDiagnostics = Boolean(liveHost && selectedHost && liveHost === selectedHost);
  const liveStateCards: {
    detail: string;
    label: string;
    tone: "good" | "muted" | "warn";
    value: string;
  }[] = [
    {
      detail: data?.pi.configured ? data?.pi.host ?? "Pi host configured" : "Add Pi SSH settings to enable diagnostics.",
      label: "Pi access",
      tone: data?.pi.reachable ? "good" : "warn",
      value: data?.pi.reachable ? "Reachable" : data?.pi.configured ? "Unavailable" : "Not configured"
    },
    {
      detail: guidanceForDiagnostic(serviceDiagnostic),
      label: "VLC service",
      tone: serviceDiagnostic ? toneFromDiagnostic(serviceDiagnostic.status) : "muted",
      value: summarizeDiagnostic(serviceDiagnostic)
    },
    {
      detail: guidanceForDiagnostic(networkDiagnostic),
      label: "Network",
      tone: networkDiagnostic ? toneFromDiagnostic(networkDiagnostic.status) : "muted",
      value: summarizeDiagnostic(networkDiagnostic)
    },
    {
      detail: guidanceForDiagnostic(playerDiagnostic),
      label: "Player status",
      tone: playerDiagnostic ? toneFromDiagnostic(playerDiagnostic.status) : "muted",
      value: summarizeDiagnostic(playerDiagnostic)
    },
    {
      detail: guidanceForDiagnostic(displayDiagnostic),
      label: "Display",
      tone: displayDiagnostic ? toneFromDiagnostic(displayDiagnostic.status) : "muted",
      value: summarizeDiagnostic(displayDiagnostic)
    },
    {
      detail: guidanceForDiagnostic(healthDiagnostic),
      label: "Health",
      tone: healthDiagnostic ? toneFromDiagnostic(healthDiagnostic.status) : "muted",
      value: summarizeDiagnostic(healthDiagnostic)
    },
    {
      detail: latestRecovery ? latestRecovery.summary : "No recovery run has been recorded yet.",
      label: "Last recovery",
      tone: recoveryTone(latestRecovery),
      value: latestRecovery ? formatTimestamp(latestRecovery.finishedAt) : "None recorded"
    }
  ];
  const stateCards = selectedHasLiveDiagnostics ? liveStateCards : unavailableStateCards(selectedScreen);
  const selectedScreenName = selectedScreen?.name ?? "selected screen";
  const currentStateDetail = selectedHasLiveDiagnostics
    ? `Latest live evidence for ${selectedScreenName}.`
    : `${selectedScreenName} is selected, but live diagnostics are not connected for this screen yet.`;
  const selectedStatusLabel = selectedHasLiveDiagnostics
    ? data?.pi.reachable
      ? "Live evidence"
      : "Live target unavailable"
    : "Inventory only";
  const selectedStatusTone: "muted" | "warn" = selectedHasLiveDiagnostics && !data?.pi.reachable ? "warn" : "muted";
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Screen scope</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              Select the screen to inspect or recover. Evidence and actions apply to the selected Pi.
            </p>
          </div>
          <StatusPill label={screenCountLabel(screens.length)} tone="muted" />
        </div>
        <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <label htmlFor="recovery-screen-filter" className="text-xs font-semibold uppercase text-zinc-500">
              Search screens
            </label>
            <input
              id="recovery-screen-filter"
              type="search"
              value={screenFilter}
              onChange={(event) => setScreenFilter(event.target.value)}
              placeholder="Search by screen, location, group, host, or playlist"
              className="mt-2 min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-teal-500"
            />
            <div className="mt-3 max-h-96 overflow-auto rounded-md border border-zinc-200">
              <ol className="divide-y divide-zinc-200">
                {filteredScreens.map((screen) => {
                  const isSelected = selectedScreen?.id === screen.id;
                  const isLive = Boolean(
                    liveHost && normalizeIdentity(screen.deviceHost) && liveHost === normalizeIdentity(screen.deviceHost)
                  );

                  return (
                    <li key={screen.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedScreenId(screen.id)}
                        aria-pressed={isSelected}
                        className={`grid w-full gap-2 px-4 py-3 text-left text-sm sm:grid-cols-[minmax(0,1fr)_auto] ${
                          isSelected ? "bg-teal-50" : "bg-white hover:bg-zinc-50"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-zinc-950">{screen.name}</span>
                          <span className="mt-1 block truncate text-xs text-zinc-600">
                            {screen.location} · {screen.group} · {screen.playlistName ?? "No playlist assigned"}
                          </span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <StatusPill label={isLive ? "Live diagnostics" : "Inventory only"} tone={isLive ? "muted" : "muted"} />
                          <span className="text-xs font-medium text-zinc-500">{screen.deviceHost ?? "No Pi host"}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {filteredScreens.length === 0 ? (
                  <li className="px-4 py-6 text-sm text-zinc-600">No screens match this search.</li>
                ) : null}
              </ol>
            </div>
          </div>

          <aside className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-xs font-semibold uppercase text-zinc-500">Selected screen</p>
            {selectedScreen ? (
              <>
                <h3 className="mt-2 text-lg font-semibold text-zinc-950">{selectedScreen.name}</h3>
                <dl className="mt-3 space-y-2 text-sm text-zinc-700">
                  <div>
                    <dt className="font-semibold text-zinc-900">Location</dt>
                    <dd>{selectedScreen.location}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-900">Pi host</dt>
                    <dd>{selectedScreen.deviceHost ?? "Not configured"}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-zinc-900">Playlist</dt>
                    <dd>{selectedScreen.playlistName ?? "No playlist assigned"}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-sm leading-6 text-zinc-600">
                  {selectedHasLiveDiagnostics
                    ? "The evidence and recovery controls below match this screen's configured Pi."
                    : "This screen is listed from local inventory. Live diagnostics are not connected for this Pi yet."}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-zinc-600">Add screens before using this view as a recovery queue.</p>
            )}
          </aside>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Current state</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">{currentStateDetail}</p>
          </div>
          <div className="self-start">
            <StatusPill
              label={selectedStatusLabel}
              tone={selectedStatusTone}
            />
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {stateCards.map((card) => (
            <div key={card.label} className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-semibold uppercase text-zinc-500">{card.label}</p>
                <StatusPill
                  label={card.tone === "good" ? "Healthy" : card.tone === "warn" ? "Needs review" : "No data"}
                  tone={card.tone}
                />
              </div>
              <p className="mt-3 break-words text-lg font-semibold leading-snug text-zinc-950">{card.value}</p>
              <p className="mt-2 text-sm leading-5 text-zinc-600">{card.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 p-5">
          <h3 className="text-lg font-semibold">Diagnostic evidence</h3>
          {loadError ? (
            <p className="mt-2 text-sm font-medium text-amber-800" role="status" aria-live="polite">{loadError}</p>
          ) : null}
        </div>
        <ol className="divide-y divide-zinc-200">
          {selectedHasLiveDiagnostics && diagnostics.length > 0 ? diagnostics.map((item) => (
            <li key={item.label} className="grid gap-3 px-5 py-4 text-sm lg:grid-cols-[180px_1fr_auto]">
              <div>
                <p className="font-semibold text-zinc-950">{item.label}</p>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{guidanceForDiagnostic(item)}</p>
              </div>
              <div>
                <p className="rounded-md bg-zinc-50 px-3 py-2 font-medium leading-6 text-zinc-800">
                  {summarizeDiagnostic(item)}
                </p>
                <details className="mt-2 rounded-md border border-zinc-200 bg-white">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-600">
                    View raw evidence
                  </summary>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-700">
                    {item.detail}
                  </pre>
                </details>
              </div>
              <div className="lg:justify-self-end">
                <StatusPill
                  label={item.status === "ok" ? "Healthy" : item.status === "error" ? "Error" : "Review"}
                  tone={toneFromDiagnostic(item.status)}
                />
              </div>
            </li>
          )) : null}
          {selectedHasLiveDiagnostics && diagnostics.length === 0 ? (
            <li className="p-5 text-sm text-zinc-600">No diagnostic evidence loaded yet.</li>
          ) : null}
          {!selectedHasLiveDiagnostics ? (
            <li className="p-5 text-sm text-zinc-600">Live diagnostic evidence is unavailable for this inventory-only screen.</li>
          ) : null}
        </ol>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <h3 className="text-lg font-semibold">Recent Pi logs</h3>
          </div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-5 text-xs leading-5 text-zinc-700">
            {selectedHasLiveDiagnostics ? logs : "Live Pi logs are unavailable for this inventory-only screen."}
          </pre>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <h3 className="text-lg font-semibold">Recovery history</h3>
          </div>
          <ol className="divide-y divide-zinc-200">
            {recoveryRuns.map((run) => (
              <li key={run.id} className="p-5 text-sm">
                <details>
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-zinc-950">{formatTimestamp(run.finishedAt)}</p>
                      <StatusPill label={run.ok ? "Completed" : "Needs review"} tone={run.ok ? "good" : "warn"} />
                    </div>
                    <p className="mt-2 text-zinc-700">{run.summary}</p>
                    <p className="mt-1 text-xs font-medium text-zinc-500">{run.steps.length} logged steps. Select to inspect.</p>
                  </summary>
                  <ol className="mt-4 space-y-3 border-t border-zinc-200 pt-4">
                    {run.steps.map((step) => (
                      <li key={step.id} className="grid gap-2 rounded-md bg-zinc-50 p-3 sm:grid-cols-[1fr_auto]">
                        <div>
                          <p className="font-semibold text-zinc-900">{step.title}</p>
                          <p className="mt-1 text-xs leading-5 text-zinc-600">{step.detail}</p>
                        </div>
                        <StatusPill label={step.status === "succeeded" ? "Done" : "Failed"} tone={step.status === "succeeded" ? "muted" : "warn"} />
                      </li>
                    ))}
                  </ol>
                </details>
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
          <h3 className="text-lg font-semibold">Troubleshooting activity</h3>
        </div>
        <ol className="divide-y divide-zinc-200">
          {troubleshootingActivity.map((item) => (
            <li key={item.id} className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[180px_1fr_auto]">
              <div>
                <p className="font-semibold text-zinc-950">{actionLabel(item.action)}</p>
                <p className="mt-1 text-xs text-zinc-500">{formatTimestamp(item.timestamp)}</p>
              </div>
              <p className="leading-6 text-zinc-700">{item.message}</p>
              <div className="md:justify-self-end">
                <StatusPill label={item.result} tone={toneFromResult(item.result)} />
              </div>
            </li>
          ))}
          {troubleshootingActivity.length === 0 ? (
            <li className="p-5 text-sm text-zinc-600">No troubleshooting activity recorded yet.</li>
          ) : null}
        </ol>
      </section>
    </div>
  );
}
