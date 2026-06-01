import { NextResponse } from "next/server";
import {
  ensureLocalDataFoundation,
  readActivityStore,
  readRecoveryStore
} from "../../lib/local-data-store";
import { readPiConfig, runSsh } from "../../lib/pi-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DiagnosticItem = {
  detail: string;
  label: string;
  status: "error" | "ok" | "warning";
};

function textBetween(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return "";
  }

  return value.slice(startIndex + start.length, endIndex).trim();
}

function trimmedOrUnavailable(value: string, fallback = "Not reported"): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function cleanTroubleshootingOutput(value: string): string {
  const markerIndex = value.lastIndexOf("__SERVICE__");
  return markerIndex === -1 ? value : value.slice(markerIndex);
}

function normalizePiLogs(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-- No entries --" || trimmed === "logs-unavailable") {
    return "No recent Pi log entries were reported.";
  }

  return trimmed;
}

function statusFromService(value: string): DiagnosticItem["status"] {
  return value.includes("ActiveState=active") ? "ok" : "warning";
}

async function readPiDiagnostics() {
  const config = readPiConfig();
  const configured = Boolean(config);
  const playerUrl =
    process.env.PISIGNAGE_PLAYER_URL?.trim() ||
    (config?.host ? `http://${config.host}:5173/?playlist=/playlist.local.json` : null);

  if (!config) {
    return {
      configured,
      diagnostics: [
        {
          detail: "Add Pi SSH settings in dashboard/.env.local.",
          label: "Pi SSH",
          status: "warning" as const
        }
      ],
      host: null,
      logs: "Pi SSH is not configured.",
      playerUrl,
      reachable: false,
      sshCommand: null,
      sshUrl: null
    };
  }

  const command = [
    "printf '__SERVICE__\\n'",
    "systemctl --user show pisignage-vlc.service --property=ActiveState --property=SubState --property=NRestarts 2>/dev/null || true",
    "printf '\\n__PLAYER__\\n'",
    "cat ~/.local/state/pisignage/player-status.json 2>/dev/null || echo player-status-missing",
    "printf '\\n__DISPLAY__\\n'",
    "kmsprint 2>/dev/null | sed -n '1,20p' || true",
    "printf '\\n__HEALTH__\\n'",
    "printf 'uptime='; uptime -p 2>/dev/null || uptime; printf '\\ntemp='; vcgencmd measure_temp 2>/dev/null || true; printf '\\nthrottle='; vcgencmd get_throttled 2>/dev/null || true",
    "printf '\\n__LOGS__\\n'",
    "journalctl --user -u pisignage-vlc.service -n 60 --no-pager 2>/dev/null || echo logs-unavailable"
  ].join("; ");

  try {
    const stdout = cleanTroubleshootingOutput(await runSsh(config, command, { timeoutMs: 10_000 }));
    const service = textBetween(stdout, "__SERVICE__", "__PLAYER__");
    const player = textBetween(stdout, "__PLAYER__", "__DISPLAY__");
    const display = textBetween(stdout, "__DISPLAY__", "__HEALTH__");
    const health = textBetween(stdout, "__HEALTH__", "__LOGS__");
    const logsIndex = stdout.indexOf("__LOGS__");
    const logs = logsIndex === -1 ? "" : stdout.slice(logsIndex + "__LOGS__".length).trim();

    const diagnostics: DiagnosticItem[] = [
      {
        detail: `Connected to ${config.user}@${config.host}.`,
        label: "Pi SSH",
        status: "ok"
      },
      {
        detail: trimmedOrUnavailable(service),
        label: "VLC service",
        status: statusFromService(service)
      },
      {
        detail: trimmedOrUnavailable(player),
        label: "Player status",
        status: player.includes("player-status-missing") ? "warning" : "ok"
      },
      {
        detail: trimmedOrUnavailable(display),
        label: "Display",
        status: display.trim() ? "ok" : "warning"
      },
      {
        detail: trimmedOrUnavailable(health),
        label: "Health",
        status: health.trim() ? "ok" : "warning"
      }
    ];

    return {
      configured,
      diagnostics,
      host: config.host,
      logs: normalizePiLogs(logs),
      playerUrl,
      reachable: true,
      sshCommand: `ssh ${config.user}@${config.host}`,
      sshUrl: `ssh://${config.user}@${config.host}`
    };
  } catch (error) {
    return {
      configured,
      diagnostics: [
        {
          detail: error instanceof Error ? error.message : "Pi diagnostics failed.",
          label: "Pi SSH",
          status: "error" as const
        }
      ],
      host: config.host,
      logs: "Pi logs are unavailable because SSH diagnostics failed.",
      playerUrl,
      reachable: false,
      sshCommand: `ssh ${config.user}@${config.host}`,
      sshUrl: `ssh://${config.user}@${config.host}`
    };
  }
}

export async function GET() {
  await ensureLocalDataFoundation();
  const [activityStore, recoveryStore, pi] = await Promise.all([
    readActivityStore(),
    readRecoveryStore(),
    readPiDiagnostics()
  ]);

  return NextResponse.json({
    activity: activityStore.items.slice(0, 20),
    pi,
    recoveryRuns: recoveryStore.runs.slice(0, 10)
  });
}
