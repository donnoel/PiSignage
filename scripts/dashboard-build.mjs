#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dashboardRoot = path.join(repoRoot, "dashboard");
const nextEnvPath = path.join(dashboardRoot, "next-env.d.ts");
const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
const previousNextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;

try {
  const result = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      PISIGNAGE_NEXT_DIST_DIR: ".next-build"
    },
    stdio: "inherit"
  });

  process.exitCode = result.status ?? 1;
} finally {
  if (previousNextEnv !== null && existsSync(nextEnvPath)) {
    writeFileSync(nextEnvPath, previousNextEnv);
  }
}
