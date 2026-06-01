import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  appendActivityRecord,
  appendRecoveryRun,
  type RecoveryRun,
  type RecoveryStep,
  readRecoveryStore
} from "../../../lib/local-data-store";
import { quoteRemoteShell, readPiConfig, runSsh } from "../../../lib/pi-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nowIso(): string {
  return new Date().toISOString();
}

function detailFromOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return "OK";
  }

  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}...` : trimmed;
}

async function runRecoverStep(
  config: NonNullable<ReturnType<typeof readPiConfig>>,
  title: string,
  command: string,
  timeoutMs = 30_000
): Promise<RecoveryStep> {
  const startedAt = nowIso();

  try {
    const stdout = await runSsh(config, command, { timeoutMs });
    return {
      detail: detailFromOutput(stdout),
      finishedAt: nowIso(),
      id: randomUUID(),
      startedAt,
      status: "succeeded",
      title
    };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
      id: randomUUID(),
      startedAt,
      status: "failed",
      title
    };
  }
}

async function logRecoveryStep(step: RecoveryStep): Promise<void> {
  await appendActivityRecord({
    id: randomUUID(),
    action: "recovery-step",
    actor: "local-operator",
    entityId: step.id,
    entityType: "system",
    message: `${step.title}: ${step.status}. ${step.detail}`,
    result: step.status === "succeeded" ? "success" : "error",
    timestamp: step.finishedAt
  });
}

async function runRecoverWorkflow(config: NonNullable<ReturnType<typeof readPiConfig>>): Promise<RecoveryRun> {
  const startedAt = nowIso();
  const displayOutput = process.env.PISIGNAGE_DISPLAY_OUTPUT?.trim() || "HDMI-A-1";
  const displayMode = process.env.PISIGNAGE_DISPLAY_RESOLUTION?.trim() || "1920x1080@60.000000";
  const playlistPath = path.posix.join(config.root, "sample-content", "playlist.local.json");
  const mediaPath = path.posix.join(config.root, "sample-content", "assets");
  const quotedDisplayOutput = quoteRemoteShell(displayOutput);
  const quotedDisplayMode = quoteRemoteShell(displayMode);
  const quotedPlaylistPath = quoteRemoteShell(playlistPath);
  const quotedMediaPath = quoteRemoteShell(mediaPath);

  const steps: RecoveryStep[] = [];
  async function executeStep(title: string, command: string, timeoutMs?: number): Promise<void> {
    const step = await runRecoverStep(config, title, command, timeoutMs);
    steps.push(step);
    await logRecoveryStep(step);
  }

  await executeStep("Check SSH connectivity", "echo recover-connected");
  await executeStep(
    "Collect service state before restart",
    "systemctl --user show pisignage-vlc.service --property=ActiveState --property=SubState --property=NRestarts 2>/dev/null || true"
  );
  await executeStep("Restart VLC service", "systemctl --user restart pisignage-vlc.service", 45_000);
  await executeStep("Verify VLC service active", "systemctl --user is-active pisignage-vlc.service", 20_000);
  await executeStep(
    "Re-apply display mode",
    `/usr/bin/wlr-randr --output ${quotedDisplayOutput} --mode ${quotedDisplayMode} 2>/dev/null || echo display-mode-not-confirmed`
  );
  await executeStep(
    "Collect player status snapshot",
    "cat ~/.local/state/pisignage/player-status.json 2>/dev/null || echo status-file-missing"
  );
  await executeStep(
    "Collect playlist and media sync footprint",
    `printf 'playlist-sha='; sha256sum ${quotedPlaylistPath} 2>/dev/null || echo playlist-missing; printf '\\nasset-files='; find ${quotedMediaPath} -maxdepth 1 -type f 2>/dev/null | wc -l`
  );
  await executeStep(
    "Collect boot and health evidence",
    "printf 'boot='; cat /proc/sys/kernel/random/boot_id 2>/dev/null || true; printf '\\nuptime='; uptime -p 2>/dev/null || uptime; printf '\\nthermals='; vcgencmd measure_temp 2>/dev/null || true; printf ' '; vcgencmd get_throttled 2>/dev/null || true"
  );

  const criticalTitles = new Set([
    "Check SSH connectivity",
    "Restart VLC service",
    "Verify VLC service active"
  ]);
  const criticalFailed = steps.some((step) => criticalTitles.has(step.title) && step.status === "failed");
  const ok = !criticalFailed;
  const run: RecoveryRun = {
    finishedAt: nowIso(),
    id: randomUUID(),
    ok,
    startedAt,
    steps,
    summary: ok
      ? "Recover completed. VLC service is active and evidence was refreshed."
      : "Recover completed with failures. Review step log for details.",
    triggeredBy: "local-operator"
  };

  await appendRecoveryRun(run);
  await appendActivityRecord({
    id: randomUUID(),
    action: "recover-run",
    actor: "local-operator",
    entityId: run.id,
    entityType: "system",
    message: run.summary,
    result: run.ok ? "success" : "error",
    timestamp: run.finishedAt
  });

  return run;
}

export async function GET() {
  const store = await readRecoveryStore();
  return NextResponse.json({
    latestRun: store.runs[0] ?? null
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string };

    if (body.action !== "restart-vlc" && body.action !== "recover") {
      return NextResponse.json({ error: "Unsupported player action." }, { status: 400 });
    }

    const config = readPiConfig();
    if (!config) {
      return NextResponse.json({ error: "Pi SSH is not configured." }, { status: 400 });
    }

    if (body.action === "restart-vlc") {
      await runSsh(config, "systemctl --user restart pisignage-vlc.service", { timeoutMs: 30_000 });
      await appendActivityRecord({
        id: randomUUID(),
        action: "restart-vlc",
        actor: "local-operator",
        entityId: config.host,
        entityType: "system",
        message: `Restarted VLC field player on ${config.host}.`,
        result: "success",
        timestamp: nowIso()
      });

      return NextResponse.json({
        message: `Restarted VLC field player on ${config.host}.`
      });
    }

    const run = await runRecoverWorkflow(config);
    return NextResponse.json({
      message: run.summary,
      run
    });
  } catch (error) {
    console.error("local player action failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Player action failed." },
      { status: 500 }
    );
  }
}
