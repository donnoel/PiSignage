import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import {
  readCloudRelease,
  releaseAsset,
  releaseTargetsDevice
} from "../../../../../../../../../lib/cloud-release-store";

type RouteContext = {
  params: Promise<{
    assetId: string;
    deviceId: string;
    releaseId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const s3 = new S3Client({});
const signedUrlExpiresInSeconds = 15 * 60;

export async function GET(_request: Request, context: RouteContext) {
  const { assetId, deviceId, releaseId } = await context.params;
  const release = await readCloudRelease(releaseId);
  if (!release || !releaseTargetsDevice(release, deviceId)) {
    return NextResponse.json(
      {
        error: "Release is unavailable for this device. Keep using the last known good local cache.",
        localFirst: true
      },
      { status: 404 }
    );
  }

  const asset = releaseAsset(release, assetId);
  if (!asset) {
    return NextResponse.json({ error: "Release asset was not found." }, { status: 404 });
  }

  const bucket = asset.playbackStorageBucket ?? asset.storageBucket ?? asset.sourceStorageBucket;
  const key = asset.playbackObjectKey ?? asset.sourceObjectKey;
  if (!bucket || !key || asset.storageProvider !== "s3") {
    return NextResponse.json(
      { error: "This release asset is not backed by AWS storage." },
      { status: 409 }
    );
  }

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }),
    { expiresIn: signedUrlExpiresInSeconds }
  );

  return NextResponse.json({
    assetId: asset.assetId,
    checksumSha256: asset.checksumSha256 ?? null,
    expiresInSeconds: signedUrlExpiresInSeconds,
    fileName: asset.fileName,
    releaseId,
    sizeBytes: asset.sizeBytes,
    url: downloadUrl
  });
}
