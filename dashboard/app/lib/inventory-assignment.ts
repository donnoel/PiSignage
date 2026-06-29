import type { DeviceRecord, ScreenRecord } from "./local-data-store";

type PlaylistAssignedDevice = {
  playlistId: string | null;
};

type PlaylistAssignedScreen = {
  playlistId: string | null;
};

export function assignedPlaylistIdForDevice(
  device: PlaylistAssignedDevice,
  linkedScreen: PlaylistAssignedScreen | null
): string | null {
  return linkedScreen?.playlistId ?? device.playlistId;
}

export function linkedDevicesForScreen(devices: DeviceRecord[], screen: ScreenRecord): DeviceRecord[] {
  return Array.from(
    new Map(
      devices
        .filter((device) => device.id === screen.deviceId || device.screenId === screen.id)
        .map((device) => [device.id, device])
    ).values()
  );
}

export function linkedScreensForDevice(screens: ScreenRecord[], device: DeviceRecord): ScreenRecord[] {
  return Array.from(
    new Map(
      screens
        .filter((screen) => screen.id === device.screenId || screen.deviceId === device.id)
        .map((screen) => [screen.id, screen])
    ).values()
  );
}
