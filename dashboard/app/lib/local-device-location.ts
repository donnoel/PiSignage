import { promises as fs } from "node:fs";
import { deviceLocationPath, writeFileAtomic } from "./local-playlist";

export type DeviceLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: string;
  source: "browser-geolocation";
};

export async function readDeviceLocation(): Promise<DeviceLocation | null> {
  try {
    const value = JSON.parse(await fs.readFile(deviceLocationPath(), "utf8")) as Partial<DeviceLocation>;

    if (
      typeof value.latitude !== "number" ||
      typeof value.longitude !== "number" ||
      !Number.isFinite(value.latitude) ||
      !Number.isFinite(value.longitude) ||
      typeof value.capturedAt !== "string" ||
      value.source !== "browser-geolocation"
    ) {
      return null;
    }

    return {
      latitude: value.latitude,
      longitude: value.longitude,
      accuracyMeters: typeof value.accuracyMeters === "number" && Number.isFinite(value.accuracyMeters)
        ? value.accuracyMeters
        : null,
      capturedAt: value.capturedAt,
      source: value.source
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeDeviceLocation(location: DeviceLocation): Promise<void> {
  await writeFileAtomic(deviceLocationPath(), `${JSON.stringify(location, null, 2)}\n`);
}
