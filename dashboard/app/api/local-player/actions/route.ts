import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

type PiConfig = {
  host: string;
  user: string;
  password?: string;
};

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function readPiConfig(): PiConfig | null {
  const host = process.env.PISIGNAGE_PI_HOST?.trim();

  if (!host) {
    return null;
  }

  return {
    host,
    user: process.env.PISIGNAGE_PI_USER?.trim() || "donnoel",
    password: process.env.PISIGNAGE_PI_PASSWORD
  };
}

function quoteTclListValue(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

async function runCommand(command: string, args: string[], password?: string): Promise<void> {
  if (!password) {
    await execFileAsync(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return;
  }

  const commandArgs = [command, ...args].map(quoteTclListValue).join(" ");
  const expectScript = `
set timeout 30
set password ${quoteTclListValue(password)}
set commandArgs [list ${commandArgs}]
spawn {*}$commandArgs
expect {
  -nocase "*password:*" { send -- "$password\\r"; exp_continue }
  -nocase "*permission denied*" { exit 13 }
  timeout { exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`;

  await execFileAsync("expect", ["-c", expectScript], {
    timeout: 35_000,
    maxBuffer: 1024 * 1024
  });
}

async function runSsh(config: PiConfig, remoteCommand: string): Promise<void> {
  await runCommand(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      ...(config.password ? [] : ["-o", "BatchMode=yes"]),
      `${config.user}@${config.host}`,
      remoteCommand
    ],
    config.password
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string };

    if (body.action !== "restart-vlc") {
      return NextResponse.json({ error: "Unsupported player action." }, { status: 400 });
    }

    const config = readPiConfig();
    if (!config) {
      return NextResponse.json({ error: "Pi SSH is not configured." }, { status: 400 });
    }

    await runSsh(config, "systemctl --user restart pisignage-vlc.service");

    return NextResponse.json({
      message: `Restarted VLC field player on ${config.host}.`
    });
  } catch (error) {
    console.error("local player action failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Player action failed." },
      { status: 500 }
    );
  }
}
