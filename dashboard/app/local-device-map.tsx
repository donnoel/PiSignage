"use client";

import { useState } from "react";
import { StatusPill } from "./dashboard-ui";

export type LocalMapDevice = {
  accuracy: string;
  capturedAt: string;
  coordinates: string;
  currentAsset: string;
  host: string;
  id: string;
  label: string;
  location: string;
  playlist: string;
  status: string;
  statusTone: "good" | "warn" | "muted";
  xPercent: number;
  yPercent: number;
};

type Props = {
  devices: LocalMapDevice[];
  mapSrc: string;
};

export function LocalDeviceMap({ devices, mapSrc }: Props) {
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0]?.id ?? "");
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? devices[0];

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
      <div className="relative h-[26rem]">
        <iframe
          aria-label="Interactive map of local PiSignage devices"
          className="h-full w-full"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={mapSrc}
          title="Pi location map"
        />
        <div className="pointer-events-none absolute inset-0">
          {devices.map((device) => (
            <button
              key={device.id}
              type="button"
              aria-label={`Show details for ${device.label}`}
              aria-pressed={device.id === selectedDevice.id}
              onClick={() => setSelectedDeviceId(device.id)}
              className="pointer-events-auto absolute z-10 flex h-12 w-12 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white shadow-lg ring-4 ring-white transition hover:bg-teal-800 focus:outline-none focus:ring-4 focus:ring-teal-300"
              style={{
                left: `${device.xPercent}%`,
                top: `${device.yPercent}%`
              }}
            >
              Pi
            </button>
          ))}
        </div>
      </div>
      {selectedDevice ? (
        <section aria-label={`Selected device details for ${selectedDevice.label}`} className="border-t border-zinc-200 bg-white p-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="break-words text-base font-semibold text-zinc-950">{selectedDevice.label}</h3>
              <p className="mt-1 text-xs font-medium text-zinc-500">{selectedDevice.host}</p>
            </div>
            <StatusPill label={selectedDevice.status} tone={selectedDevice.statusTone} />
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Playing</dt>
              <dd className="mt-1 break-words text-zinc-950">{selectedDevice.currentAsset}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Playlist</dt>
              <dd className="mt-1 text-zinc-950">{selectedDevice.playlist}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Location</dt>
              <dd className="mt-1 text-zinc-950">{selectedDevice.location}</dd>
            </div>
            <div className="rounded-md bg-zinc-50 p-3">
              <dt className="text-xs font-semibold uppercase text-zinc-500">Coordinates</dt>
              <dd className="mt-1 text-zinc-950">{selectedDevice.coordinates}</dd>
              <dd className="mt-1 text-zinc-600">{selectedDevice.accuracy} · {selectedDevice.capturedAt}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
