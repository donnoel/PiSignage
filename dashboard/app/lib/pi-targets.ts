import type { DeviceRecord } from "./local-data-store";
import { readDeviceStore, readScreenStore } from "./local-data-store";
import { readPiConfig } from "./pi-local";
import type { PiConfig } from "./pi-local";

function configuredDevice(device: DeviceRecord): boolean {
  return Boolean(device.host.trim()) && device.host !== "Not configured";
}

export function piConfigForDevice(device: DeviceRecord): PiConfig {
  const fallback = readPiConfig();
  const user = device.sshUser?.trim() || fallback?.user || "donnoel";
  const root =
    device.rootPath?.trim() && device.rootPath !== "~"
      ? device.rootPath.trim()
      : fallback?.root ?? `/home/${user}/PiSignage`;

  return {
    host: device.host.trim(),
    password: fallback?.password,
    root,
    user
  };
}

export async function targetDevicesForRequest(input: {
  deviceId?: string | null;
  playlistId?: string | null;
  screenId?: string | null;
}): Promise<DeviceRecord[]> {
  const [devices, screens] = await Promise.all([readDeviceStore(), readScreenStore()]);

  if (input.deviceId) {
    const device = devices.items.find((item) => item.id === input.deviceId);
    return device && configuredDevice(device) ? [device] : [];
  }

  if (input.screenId) {
    const screen = screens.items.find((item) => item.id === input.screenId);
    const device = screen
      ? devices.items.find((item) => item.id === screen.deviceId || item.screenId === screen.id)
      : null;
    return device && configuredDevice(device) ? [device] : [];
  }

  if (input.playlistId) {
    const screenIds = new Set(
      screens.items.filter((screen) => screen.playlistId === input.playlistId).map((screen) => screen.id)
    );
    const deviceIds = new Set(
      screens.items
        .filter((screen) => screen.playlistId === input.playlistId && screen.deviceId)
        .map((screen) => screen.deviceId as string)
    );

    return devices.items.filter((device) => {
      return (
        configuredDevice(device) &&
        (device.playlistId === input.playlistId ||
          deviceIds.has(device.id) ||
          (device.screenId ? screenIds.has(device.screenId) : false))
      );
    });
  }

  return [];
}
