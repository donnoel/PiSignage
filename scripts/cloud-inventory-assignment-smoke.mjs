import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(repoRoot, "dashboard", "app", "lib", "inventory-assignment.ts");
const source = await readFile(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourcePath
});
const moduleContext = {
  exports: {},
  module: { exports: {} }
};
moduleContext.exports = moduleContext.module.exports;
vm.runInNewContext(outputText, moduleContext, { filename: sourcePath });

const {
  assignedPlaylistIdForDevice,
  linkedDevicesForScreen,
  linkedScreensForDevice
} = moduleContext.module.exports;

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function device(overrides) {
  return {
    group: "Pilot",
    host: "c5.local",
    id: "device-c5",
    location: "Study",
    name: "C5 Pi",
    notes: "",
    playerType: "vlc",
    playlistId: null,
    rootPath: "~",
    screenId: null,
    sshUser: "donnoel",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides
  };
}

function screen(overrides) {
  return {
    deviceId: null,
    group: "Pilot",
    id: "screen-c5",
    location: "Study",
    name: "C5",
    notes: "",
    playlistId: null,
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...overrides
  };
}

const linkedDevice = device({ id: "device-c5", playlistId: "playlist-stale", screenId: "screen-c5" });
const linkedScreen = screen({ deviceId: "device-c5", playlistId: "playlist-current" });
const unlinkedDevice = device({ id: "device-c4", host: "c4.local", name: "C4 Pi", screenId: null });
const unlinkedScreen = screen({ id: "screen-c4", name: "C4" });

assert(
  assignedPlaylistIdForDevice(linkedDevice, linkedScreen) === "playlist-current",
  "screen playlist is authoritative when screen and device disagree"
);
assert(
  assignedPlaylistIdForDevice(linkedDevice, null) === "playlist-stale",
  "device playlist is used only when no linked screen assignment exists"
);
assert(
  linkedDevicesForScreen([linkedDevice, unlinkedDevice], linkedScreen).map((item) => item.id).join(",") === "device-c5",
  "linkedDevicesForScreen finds linked devices without unrelated devices"
);
assert(
  linkedScreensForDevice([linkedScreen, unlinkedScreen], linkedDevice).map((item) => item.id).join(",") === "screen-c5",
  "linkedScreensForDevice finds linked screens without unrelated screens"
);
assert(
  linkedDevicesForScreen([linkedDevice, { ...linkedDevice }], linkedScreen).length === 1,
  "linkedDevicesForScreen deduplicates records linked by both ids"
);
assert(
  linkedScreensForDevice([linkedScreen, { ...linkedScreen }], linkedDevice).length === 1,
  "linkedScreensForDevice deduplicates records linked by both ids"
);

if (failures.length > 0) {
  console.error("Cloud inventory assignment smoke failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Cloud inventory assignment smoke checks passed.");
