import { NextResponse } from "next/server";
import { writeDeviceLocation } from "../../../lib/local-device-location";

export const runtime = "nodejs";

function coordinate(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return null;
  }

  return value;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      accuracyMeters?: unknown;
      latitude?: unknown;
      longitude?: unknown;
    };
    const latitude = coordinate(body.latitude, -90, 90);
    const longitude = coordinate(body.longitude, -180, 180);

    if (latitude === null || longitude === null) {
      return NextResponse.json(
        { error: "Location capture needs real latitude and longitude coordinates." },
        { status: 400 }
      );
    }

    const accuracyMeters =
      typeof body.accuracyMeters === "number" && Number.isFinite(body.accuracyMeters) && body.accuracyMeters >= 0
        ? body.accuracyMeters
        : null;

    await writeDeviceLocation({
      accuracyMeters,
      capturedAt: new Date().toISOString(),
      latitude,
      longitude,
      source: "browser-geolocation"
    });

    return NextResponse.json({
      accuracyMeters,
      latitude,
      longitude,
      message: "Saved real device coordinates from browser geolocation."
    });
  } catch (error) {
    console.error("local device location update failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Device location update failed." },
      { status: 500 }
    );
  }
}
