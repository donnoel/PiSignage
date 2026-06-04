import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  type PiPublishResult,
  readStoredPlaylist,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";
import { piConfigForDevice, targetDevicesForRequest } from "../../../lib/pi-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sumPublishMetric(
  results: PiPublishResult[],
  key: "assetsChecked" | "assetsCopied" | "assetsSkipped" | "assetsVerifiedByChecksum" | "assetsVerifiedBySize"
): number | undefined {
  const values = results.map((result) => result[key]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      deviceId?: string;
      playlistId?: string;
      screenId?: string;
    };
    const { playlist } = await readStoredPlaylist(body.playlistId);
    if (playlist.assets.length === 0) {
      return NextResponse.json(
        { error: "Add media before publishing this playlist." },
        { status: 400 }
      );
    }

    const playlistPath = await ensureLivePlaylistPath();
    await writePlaylist(playlistPath, playlist);
    const targets = await targetDevicesForRequest({
      deviceId: body.deviceId,
      playlistId: playlist.playlistId,
      screenId: body.screenId
    });
    const publishResults = targets.length
      ? await Promise.all(
          targets.map((device) =>
            publishPlaylistToPi(
              playlistPath,
              playlist,
              {
                notConfigured: `Pi publish is not configured for ${device.name}; playlist stayed local.`,
                failure: `Manual publish to ${device.name} needs attention.`,
                success: `Published ${playlist.name} to ${device.name} at ${device.host}.`
              },
              piConfigForDevice(device)
            )
          )
        )
      : [
          await publishPlaylistToPi(playlistPath, playlist, {
            notConfigured: "No assigned Pi was found for this playlist; playlist stayed local.",
            failure: "Manual publish needs attention."
          })
        ];
    const okCount = publishResults.filter((result) => result.ok).length;
    const piPublish = {
      assetsChecked: sumPublishMetric(publishResults, "assetsChecked"),
      assetsCopied: sumPublishMetric(publishResults, "assetsCopied"),
      assetsSkipped: sumPublishMetric(publishResults, "assetsSkipped"),
      assetsVerifiedByChecksum: sumPublishMetric(publishResults, "assetsVerifiedByChecksum"),
      assetsVerifiedBySize: sumPublishMetric(publishResults, "assetsVerifiedBySize"),
      enabled: publishResults.some((result) => result.enabled),
      ok: publishResults.length > 0 && publishResults.every((result) => result.ok),
      message:
        publishResults.length === 1
          ? publishResults[0].message
          : `Published ${okCount}/${publishResults.length} assigned screen(s). ${publishResults
              .map((result) => result.message)
              .join(" ")}`
    };
    await writePublishStatus("publish", playlist, piPublish);

    return NextResponse.json({
      playlistVersion: playlist.version,
      assetCount: playlist.assets.length,
      piPublish,
      publishResults
    });
  } catch (error) {
    console.error("manual playlist publish failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed." },
      { status: 500 }
    );
  }
}
