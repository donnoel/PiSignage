import { NextResponse } from "next/server";
import {
  ensureLivePlaylistPath,
  type PiPublishResult,
  type PublishStatusTarget,
  writePlaylist,
  writePublishStatus
} from "../../../lib/local-playlist";
import { isCloudInventoryConfigured, markCloudPlaylistPublished } from "../../../lib/inventory-store";
import { apiErrorResponse } from "../../../lib/api-error-response";
import { readStoredPlaylist } from "../../../lib/playlist-store";
import { publishPlaylistToPi } from "../../../lib/pi-local";
import { piConfigForDevice, targetDevicesForRequest } from "../../../lib/pi-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sumPublishMetric(
  results: PiPublishResult[],
  key:
    | "assetsChecked"
    | "assetsCopied"
    | "assetsRemoved"
    | "assetsSkipped"
    | "assetsVerifiedByChecksum"
    | "assetsVerifiedBySize"
): number | undefined {
  const values = results.map((result) => result[key]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
}

function publishTargetStatus(
  result: PiPublishResult,
  target: {
    id: string | null;
    name: string;
    host: string | null;
    screenId: string | null;
  }
): PublishStatusTarget {
  return {
    assetsChecked: result.assetsChecked,
    assetsCopied: result.assetsCopied,
    assetsRemoved: result.assetsRemoved,
    assetsSkipped: result.assetsSkipped,
    assetsVerifiedByChecksum: result.assetsVerifiedByChecksum,
    assetsVerifiedBySize: result.assetsVerifiedBySize,
    deviceId: target.id,
    deviceName: target.name,
    enabled: result.enabled,
    host: target.host,
    message: result.message,
    ok: result.ok,
    screenId: target.screenId
  };
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

    if (isCloudInventoryConfigured()) {
      const targets = await markCloudPlaylistPublished({
        deviceId: body.deviceId,
        playlistId: playlist.playlistId,
        playlistVersion: playlist.version,
        screenId: body.screenId
      });
      const publishTargets = targets.map((target): PublishStatusTarget => ({
        deviceId: target.device?.id ?? null,
        deviceName: target.device?.name ?? target.screen?.name ?? "No assigned Pi",
        enabled: true,
        host: target.device?.host ?? null,
        message: target.device
          ? `Published ${playlist.name} v${playlist.version} to ${target.device.name}.`
          : `Published ${playlist.name} v${playlist.version} to assigned screen.`,
        ok: Boolean(target.device),
        screenId: target.screen?.id ?? null
      }));
      const okCount = publishTargets.filter((target) => target.ok).length;
      const piPublish: PiPublishResult = {
        enabled: true,
        ok: publishTargets.length > 0 && publishTargets.every((target) => target.ok),
        message:
          publishTargets.length === 0
            ? "No assigned AWS device was found for this playlist; publish did not change any screen."
            : publishTargets.length === 1
              ? publishTargets[0].message
              : `Published ${okCount}/${publishTargets.length} assigned AWS device(s).`
      };

      await writePublishStatus("publish", playlist, piPublish, publishTargets);

      return NextResponse.json({
        playlistVersion: playlist.version,
        assetCount: playlist.assets.length,
        piPublish,
        publishResults: publishTargets,
        publishTargets
      });
    }

    const playlistPath = await ensureLivePlaylistPath();
    await writePlaylist(playlistPath, playlist);
    const targets = await targetDevicesForRequest({
      deviceId: body.deviceId,
      playlistId: playlist.playlistId,
      screenId: body.screenId
    });
    const publishAttempts = targets.length
      ? await Promise.all(
          targets.map(async (device) => ({
            result: await publishPlaylistToPi(
              playlistPath,
              playlist,
              {
                notConfigured: `Pi publish is not configured for ${device.name}; playlist stayed local.`,
                failure: `Manual publish to ${device.name} needs attention.`,
                success: `Published ${playlist.name} to ${device.name} at ${device.host}.`
              },
              piConfigForDevice(device)
            ),
            target: {
              host: device.host,
              id: device.id,
              name: device.name,
              screenId: device.screenId
            }
          }))
        )
      : [
          {
            result: await publishPlaylistToPi(playlistPath, playlist, {
              notConfigured: "No assigned Pi was found for this playlist; playlist stayed local.",
              failure: "Manual publish needs attention."
            }),
            target: {
              host: null,
              id: null,
              name: "No assigned Pi",
              screenId: body.screenId ?? null
            }
          }
        ];
    const publishResults = publishAttempts.map((attempt) => attempt.result);
    const publishTargets = publishAttempts.map((attempt) => publishTargetStatus(attempt.result, attempt.target));
    const okCount = publishResults.filter((result) => result.ok).length;
    const piPublish = {
      assetsChecked: sumPublishMetric(publishResults, "assetsChecked"),
      assetsCopied: sumPublishMetric(publishResults, "assetsCopied"),
      assetsRemoved: sumPublishMetric(publishResults, "assetsRemoved"),
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
    await writePublishStatus("publish", playlist, piPublish, publishTargets);

    return NextResponse.json({
      playlistVersion: playlist.version,
      assetCount: playlist.assets.length,
      piPublish,
      publishResults,
      publishTargets
    });
  } catch (error) {
    console.error("manual playlist publish failed", error);
    return apiErrorResponse(error, "Publish failed.");
  }
}
