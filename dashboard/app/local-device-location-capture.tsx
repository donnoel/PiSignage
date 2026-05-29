"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type LocationResponse = {
  error?: string;
  message?: string;
};

type Props = {
  hasLocation: boolean;
};

export function LocalDeviceLocationCapture({ hasLocation }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState(
    hasLocation ? "Coordinates are saved from browser geolocation." : "Capture real coordinates from this setup browser."
  );
  const [isCapturing, setIsCapturing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const didAutoCapture = useRef(false);

  async function savePosition(position: GeolocationPosition) {
    const response = await fetch("/api/local-device/location", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accuracyMeters: position.coords.accuracy,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      })
    });
    const result = (await response.json()) as LocationResponse;

    if (!response.ok) {
      throw new Error(result.error ?? "Location capture failed.");
    }

    setMessage(result.message ?? "Saved real device coordinates.");
    startTransition(() => router.refresh());
  }

  function captureLocation() {
    if (isCapturing || isPending) {
      return;
    }

    if (!("geolocation" in navigator)) {
      setMessage("This browser cannot report a real location.");
      return;
    }

    setIsCapturing(true);
    setMessage("Requesting browser location permission...");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        savePosition(position).catch((error: unknown) => {
          setMessage(error instanceof Error ? error.message : "Location capture failed.");
        }).finally(() => {
          setIsCapturing(false);
        });
      },
      (error) => {
        setMessage(error.message || "Location permission was not granted.");
        setIsCapturing(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000
      }
    );
  }

  useEffect(() => {
    if (hasLocation || didAutoCapture.current) {
      return;
    }

    didAutoCapture.current = true;
    captureLocation();
  });

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={isCapturing || isPending}
        onClick={captureLocation}
        className="min-h-11 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
      >
        {isCapturing || isPending ? "Capturing..." : hasLocation ? "Update real coordinates" : "Capture real coordinates"}
      </button>
      <p className="mt-3 text-sm leading-6 text-zinc-600" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
