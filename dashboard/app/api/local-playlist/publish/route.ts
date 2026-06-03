import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  readStoredPlaylist,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import { publishPlaylistToPi } from "../../../lib/pi-local";
import { piConfigForDevice, targetDevicesForRequest } from "../../../lib/pi-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
