import { access, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const localStateRoot = path.join(repoRoot, "dashboard", "local-state");
const sampleContentRoot = path.join(repoRoot, "sample-content");
const sampleAssetsRoot = path.join(sampleContentRoot, "assets");
const livePlaylistPath = path.join(localStateRoot, "playlist.local.json");
const playlistStorePath = path.join(localStateRoot, "playlists.local.json");
const samplePlaylistPath = path.join(sampleContentRoot, "playlist.local.json");
const requireAssetFiles = !process.argv.includes("--allow-missing-assets");

const errors = [];
const notes = [];

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    errors.push(`${label}: could not read valid JSON at ${path.relative(repoRoot, filePath)} (${error.message})`);
    return null;
  }
}

async function readOptionalJson(fileName, label) {
  const filePath = path.join(localStateRoot, fileName);
  if (!(await fileExists(filePath))) {
    notes.push(`${label}: ${fileName} not present yet`);
    return null;
  }

  return readJson(filePath, label);
}

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function isValidDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidTimezone(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    return false;
  }

  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeRelativeUri(value) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return false;
  }

  if (path.isAbsolute(value) || value.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return false;
  }

  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function isPlaybackSafeVideoFileName(fileName) {
  return (
    /\.signage-1080p(?:-\d+)?\.mp4$/i.test(fileName) ||
    /\.signage-720p(?:-\d+)?\.mp4$/i.test(fileName) ||
    /\.transcoded(?:-\d+)?\.mp4$/i.test(fileName) ||
    /\.still-\d+s(?:-\d+)?\.mp4$/i.test(fileName)
  );
}

function isSafeColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isOptionalPositiveNumber(value) {
  return value === undefined || (Number.isFinite(value) && value > 0);
}

function isOptionalPositiveNumberOrNull(value) {
  return value === undefined || value === null || (Number.isFinite(value) && value > 0);
}

function isOptionalStringOrNull(value) {
  return value === undefined || value === null || typeof value === "string";
}

async function requireAssetOnDisk(assetPath, label) {
  if (!requireAssetFiles) {
    return;
  }

  if (!(await fileExists(assetPath))) {
    errors.push(`${label}: missing asset file ${path.relative(repoRoot, assetPath)}`);
  }
}

function validateStoreShell(store, label, collectionKey = "items") {
  assert(store && typeof store === "object", `${label}: store must be an object`);
  if (!store || typeof store !== "object") {
    return false;
  }

  assert(Number.isInteger(store.version) && store.version >= 1, `${label}: version must be a positive integer`);
  assert(isValidDate(store.updatedAt), `${label}: updatedAt must be a valid timestamp`);
  assert(Array.isArray(store[collectionKey]), `${label}: ${collectionKey} must be an array`);
  return Array.isArray(store[collectionKey]);
}

async function validatePlaylist(playlist, label) {
  assert(typeof playlist.playlistId === "string" && playlist.playlistId.trim(), `${label}: playlistId is required`);
  assert(typeof playlist.name === "string" && playlist.name.trim(), `${label}: name is required`);
  assert(Number.isInteger(playlist.version) && playlist.version >= 1, `${label}: version must be a positive integer`);
  assert(isValidDate(playlist.updatedAt), `${label}: updatedAt must be a valid timestamp`);
  assert(Array.isArray(playlist.assets), `${label}: assets must be an array`);
  if (!Array.isArray(playlist.assets)) {
    return;
  }

  assert(playlist.assets.length > 0, `${label}: at least one playable asset is required`);
  const ids = new Set();
  for (const asset of playlist.assets) {
    const assetLabel = `${label} asset ${asset?.assetId ?? "(missing id)"}`;
    assert(typeof asset.assetId === "string" && asset.assetId.trim(), `${assetLabel}: assetId is required`);
    assert(!ids.has(asset.assetId), `${assetLabel}: duplicate assetId`);
    ids.add(asset.assetId);
    assert(asset.type === "video", `${assetLabel}: active playback asset must be a video`);
    assert(isSafeRelativeUri(asset.uri), `${assetLabel}: uri must be a safe relative path`);
    assert(asset.uri?.startsWith("assets/"), `${assetLabel}: uri must live under sample-content/assets`);

    if (asset.durationSeconds !== undefined) {
      assert(
        Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0 && asset.durationSeconds <= 3600,
        `${assetLabel}: durationSeconds must be between 1 and 3600`
      );
    }

    const extension = path.extname(asset.uri ?? "").toLowerCase();
    assert(extension === ".mp4", `${assetLabel}: playback file must be MP4`);
    assert(
      isPlaybackSafeVideoFileName(path.basename(asset.uri ?? "")),
      `${assetLabel}: playback file must be a Pi-safe MP4`
    );
    const assetPath = path.join(sampleContentRoot, asset.uri ?? "");
    assert(isInside(assetPath, sampleContentRoot), `${assetLabel}: uri escapes sample-content`);
    await requireAssetOnDisk(assetPath, assetLabel);
  }
}

async function validateMediaStore(mediaStore) {
  if (!validateStoreShell(mediaStore, "Media store")) {
    return;
  }

  const ids = new Set();
  for (const item of mediaStore.items) {
    const label = `Media item ${item?.id ?? "(missing id)"}`;
    assert(typeof item.id === "string" && item.id.trim(), `${label}: id is required`);
    assert(!ids.has(item.id), `${label}: duplicate id`);
    ids.add(item.id);
    assert(typeof item.title === "string" && item.title.trim(), `${label}: title is required`);
    assert(typeof item.description === "string", `${label}: description must be present`);
    assert(Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string"), `${label}: tags must be strings`);
    assert(typeof item.sourceFileName === "string" && path.basename(item.sourceFileName) === item.sourceFileName, `${label}: sourceFileName must be a file name`);
    assert(typeof item.playbackFileName === "string" && path.basename(item.playbackFileName) === item.playbackFileName, `${label}: playbackFileName must be a file name`);
    assert(typeof item.mimeType === "string" && item.mimeType.trim(), `${label}: mimeType is required`);
    assert(Number.isFinite(item.sizeBytes) && item.sizeBytes > 0, `${label}: sizeBytes must be positive`);
    assert(isOptionalPositiveNumber(item.sourceSizeBytes), `${label}: sourceSizeBytes must be positive when present`);
    assert(item.durationSeconds === null || (Number.isFinite(item.durationSeconds) && item.durationSeconds > 0), `${label}: durationSeconds must be null or positive`);
    assert(item.checksumSha256 === undefined || isSha256(item.checksumSha256), `${label}: checksumSha256 must be a SHA-256 hex digest when present`);
    assert(item.playbackProfile === undefined || (typeof item.playbackProfile === "string" && item.playbackProfile.trim()), `${label}: playbackProfile must be a non-empty string when present`);
    assert(item.preparedAt === undefined || isValidDate(item.preparedAt), `${label}: preparedAt must be valid when present`);
    assert(isOptionalPositiveNumberOrNull(item.width), `${label}: width must be positive or null when present`);
    assert(isOptionalPositiveNumberOrNull(item.height), `${label}: height must be positive or null when present`);
    assert(isOptionalPositiveNumberOrNull(item.fps), `${label}: fps must be positive or null when present`);
    assert(isOptionalPositiveNumberOrNull(item.bitRate), `${label}: bitRate must be positive or null when present`);
    assert(isOptionalStringOrNull(item.videoCodec), `${label}: videoCodec must be a string or null when present`);
    assert(isOptionalStringOrNull(item.videoProfile), `${label}: videoProfile must be a string or null when present`);
    assert(isOptionalStringOrNull(item.pixelFormat), `${label}: pixelFormat must be a string or null when present`);
    assert(isOptionalStringOrNull(item.audioCodec), `${label}: audioCodec must be a string or null when present`);
    assert(item.status === "ready" || item.status === "processing" || item.status === "failed", `${label}: status is invalid`);
    assert(isValidDate(item.createdAt), `${label}: createdAt must be valid`);
    assert(isValidDate(item.updatedAt), `${label}: updatedAt must be valid`);

    if (item.status === "ready") {
      const extension = path.extname(item.playbackFileName).toLowerCase();
      assert(extension === ".mp4" || extension === ".mov", `${label}: ready media must produce MP4 or MOV playback`);
      await requireAssetOnDisk(path.join(sampleAssetsRoot, item.playbackFileName), label);
    }
  }
}

function validateLayerFrame(layer, label) {
  assert(typeof layer.id === "string" && layer.id.trim(), `${label}: id is required`);
  assert(Number.isFinite(layer.x) && layer.x >= 0 && layer.x <= 1920, `${label}: x must be within the canvas`);
  assert(Number.isFinite(layer.y) && layer.y >= 0 && layer.y <= 1080, `${label}: y must be within the canvas`);
  assert(Number.isFinite(layer.width) && layer.width > 0 && layer.width <= 1920, `${label}: width must fit within the canvas`);
  assert(Number.isFinite(layer.height) && layer.height > 0 && layer.height <= 1080, `${label}: height must fit within the canvas`);
  assert(layer.x + layer.width <= 1920, `${label}: x + width must stay inside the canvas`);
  assert(layer.y + layer.height <= 1080, `${label}: y + height must stay inside the canvas`);
  assert(Number.isInteger(layer.zIndex) && layer.zIndex >= 0 && layer.zIndex <= 999, `${label}: zIndex is invalid`);
  assert(layer.opacity === undefined || (Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1), `${label}: opacity is invalid`);
}

function validateLayoutLayer(layer, label, knownMediaIds) {
  if (!layer || typeof layer !== "object") {
    assert(false, `${label}: layer must be an object`);
    return;
  }

  validateLayerFrame(layer, label);

  if (layer.kind === "media") {
    assert(typeof layer.mediaId === "string" && layer.mediaId.trim(), `${label}: mediaId is required`);
    assert(knownMediaIds.has(layer.mediaId), `${label}: mediaId must reference ready local media`);
    assert(["contain", "cover", "fill"].includes(layer.fit), `${label}: fit is invalid`);
    assert(typeof layer.muted === "boolean", `${label}: muted must be boolean`);
  } else if (layer.kind === "text") {
    assert(typeof layer.text === "string" && layer.text.trim(), `${label}: text is required`);
    assert(Number.isFinite(layer.fontSize) && layer.fontSize >= 8 && layer.fontSize <= 240, `${label}: fontSize is invalid`);
    assert(["regular", "medium", "bold"].includes(layer.fontWeight), `${label}: fontWeight is invalid`);
    assert(["left", "center", "right"].includes(layer.align), `${label}: align is invalid`);
    assert(["top", "middle", "bottom"].includes(layer.verticalAlign), `${label}: verticalAlign is invalid`);
    assert(isSafeColor(layer.color), `${label}: color is invalid`);
    assert(layer.backgroundColor === undefined || isSafeColor(layer.backgroundColor), `${label}: backgroundColor is invalid`);
  } else if (layer.kind === "shape") {
    assert(layer.shape === "rectangle", `${label}: shape is invalid`);
    assert(layer.fillColor === undefined || isSafeColor(layer.fillColor), `${label}: fillColor is invalid`);
    assert(layer.strokeColor === undefined || isSafeColor(layer.strokeColor), `${label}: strokeColor is invalid`);
    assert(layer.strokeWidth === undefined || (Number.isFinite(layer.strokeWidth) && layer.strokeWidth >= 0 && layer.strokeWidth <= 80), `${label}: strokeWidth is invalid`);
  } else {
    assert(false, `${label}: kind is invalid`);
  }
}

function knownLayoutMediaIds(mediaStore, playlistStore) {
  const ids = new Set();
  for (const item of mediaStore?.items ?? []) {
    if (item.status === "ready") {
      ids.add(item.id);
    }
  }

  for (const playlist of playlistStore?.items ?? []) {
    for (const asset of playlist.assets ?? []) {
      if (asset.uri?.startsWith("assets/")) {
        ids.add(`playlist:${asset.assetId}`);
      }
    }
  }

  return ids;
}

function validateLayouts(layoutStore, mediaStore, playlistStore) {
  if (!layoutStore || !validateStoreShell(layoutStore, "Layout store")) {
    return;
  }

  const ids = new Set();
  const knownMediaIds = knownLayoutMediaIds(mediaStore, playlistStore);
  for (const layout of layoutStore.items) {
    const label = `Layout ${layout?.id ?? "(missing id)"}`;
    assert(layout.contractVersion === 1, `${label}: contractVersion must be 1`);
    assert(typeof layout.id === "string" && layout.id.trim(), `${label}: id is required`);
    assert(!ids.has(layout.id), `${label}: duplicate id`);
    ids.add(layout.id);
    assert(typeof layout.name === "string" && layout.name.trim(), `${label}: name is required`);
    assert(Number.isInteger(layout.version) && layout.version >= 1, `${label}: version must be a positive integer`);
    assert(isValidDate(layout.updatedAt), `${label}: updatedAt must be valid`);
    assert(Number.isInteger(layout.durationSeconds) && layout.durationSeconds >= 1 && layout.durationSeconds <= 3600, `${label}: durationSeconds must be between 1 and 3600`);
    assert(layout.canvas?.width === 1920 && layout.canvas?.height === 1080, `${label}: canvas must be 1920x1080`);
    assert(isSafeColor(layout.canvas?.backgroundColor), `${label}: canvas backgroundColor is invalid`);
    assert(Array.isArray(layout.layers) && layout.layers.length > 0 && layout.layers.length <= 24, `${label}: layers must contain 1-24 items`);

    const layerIds = new Set();
    for (const [index, layer] of (layout.layers ?? []).entries()) {
      const layerLabel = `${label} layer ${index + 1}`;
      assert(!layerIds.has(layer?.id), `${layerLabel}: duplicate layer id`);
      layerIds.add(layer?.id);
      validateLayoutLayer(layer, layerLabel, knownMediaIds);
    }

    assert(layout.render && typeof layout.render === "object", `${label}: render is required`);
    if (layout.render?.status === "not-rendered") {
      assert(layout.render.reason === undefined || typeof layout.render.reason === "string", `${label}: render reason is invalid`);
    } else if (layout.render?.status === "failed") {
      assert(typeof layout.render.message === "string" && layout.render.message.trim(), `${label}: render failure message is required`);
      assert(isValidDate(layout.render.failedAt), `${label}: render failedAt must be valid`);
    } else if (layout.render?.status === "ready") {
      const playbackFileName =
        typeof layout.render.playbackFileName === "string" ? layout.render.playbackFileName : "";
      assert(knownMediaIds.has(layout.render.mediaId), `${label}: render mediaId must reference ready local media`);
      assert(playbackFileName && path.basename(playbackFileName) === playbackFileName, `${label}: render playbackFileName must be a file name`);
      assert(isPlaybackSafeVideoFileName(playbackFileName), `${label}: render playbackFileName must be Pi-safe`);
      assert(isValidDate(layout.render.renderedAt), `${label}: render renderedAt must be valid`);
    } else {
      assert(false, `${label}: render status is invalid`);
    }
  }
}

function validateInventory(screensStore, devicesStore, validPlaylistIds) {
  if (screensStore && !validateStoreShell(screensStore, "Screens store")) {
    return;
  }
  if (devicesStore && !validateStoreShell(devicesStore, "Devices store")) {
    return;
  }
  if (!screensStore && !devicesStore) {
    return;
  }

  const screens = screensStore?.items ?? [];
  const devices = devicesStore?.items ?? [];
  const screenIds = new Set(screens.map((screen) => screen.id));
  const deviceIds = new Set(devices.map((device) => device.id));
  const seenScreenIds = new Set();
  const seenDeviceIds = new Set();

  for (const screen of screens) {
    const label = `Screen ${screen?.id ?? "(missing id)"}`;
    assert(typeof screen.id === "string" && screen.id.trim(), `${label}: id is required`);
    assert(!seenScreenIds.has(screen.id), `${label}: duplicate id`);
    seenScreenIds.add(screen.id);
    assert(typeof screen.name === "string" && screen.name.trim(), `${label}: name is required`);
    assert(typeof screen.location === "string" && screen.location.trim(), `${label}: location is required`);
    assert(typeof screen.group === "string" && screen.group.trim(), `${label}: group is required`);
    assert(typeof screen.notes === "string", `${label}: notes must be present`);
    assert(screen.playlistId === null || validPlaylistIds.has(screen.playlistId), `${label}: playlistId must be null or a saved playlist`);
    assert(screen.deviceId === null || deviceIds.has(screen.deviceId), `${label}: deviceId must reference a known device`);
    assert(isValidDate(screen.updatedAt), `${label}: updatedAt must be valid`);
  }

  for (const device of devices) {
    const label = `Device ${device?.id ?? "(missing id)"}`;
    assert(typeof device.id === "string" && device.id.trim(), `${label}: id is required`);
    assert(!seenDeviceIds.has(device.id), `${label}: duplicate id`);
    seenDeviceIds.add(device.id);
    assert(typeof device.name === "string" && device.name.trim(), `${label}: name is required`);
    assert(typeof device.host === "string" && device.host.trim(), `${label}: host is required`);
    assert(typeof device.location === "string" && device.location.trim(), `${label}: location is required`);
    assert(typeof device.group === "string" && device.group.trim(), `${label}: group is required`);
    assert(typeof device.notes === "string", `${label}: notes must be present`);
    assert(device.playerType === "vlc", `${label}: playerType must be vlc`);
    assert(typeof device.rootPath === "string" && device.rootPath.trim(), `${label}: rootPath is required`);
    assert(typeof device.sshUser === "string" && device.sshUser.trim(), `${label}: sshUser is required`);
    assert(device.playlistId === null || validPlaylistIds.has(device.playlistId), `${label}: playlistId must be null or a saved playlist`);
    assert(device.screenId === null || screenIds.has(device.screenId), `${label}: screenId must reference a known screen`);
    assert(isValidDate(device.updatedAt), `${label}: updatedAt must be valid`);
  }
}

function validateSchedules(scheduleStore, screensStore) {
  if (!scheduleStore || !validateStoreShell(scheduleStore, "Schedule store")) {
    return;
  }

  const screenIds = new Set((screensStore?.items ?? []).map((screen) => screen.id));
  const ids = new Set();
  for (const schedule of scheduleStore.items) {
    const label = `Schedule ${schedule?.id ?? "(missing id)"}`;
    assert(typeof schedule.id === "string" && schedule.id.trim(), `${label}: id is required`);
    assert(!ids.has(schedule.id), `${label}: duplicate id`);
    ids.add(schedule.id);
    assert(typeof schedule.name === "string" && schedule.name.trim(), `${label}: name is required`);
    assert(isValidTimezone(schedule.timezone), `${label}: timezone must be valid`);
    assert(isValidDate(schedule.updatedAt), `${label}: updatedAt must be valid`);
    assert(Array.isArray(schedule.screenIds), `${label}: screenIds must be an array`);
    for (const screenId of schedule.screenIds ?? []) {
      assert(screenIds.has(screenId), `${label}: assigned screen ${screenId} is not in inventory`);
    }
    assert(Array.isArray(schedule.rules) && schedule.rules.length > 0, `${label}: at least one rule is required`);
    for (const rule of schedule.rules ?? []) {
      assert(isValidTime(rule.startTime), `${label}: rule startTime must be HH:mm`);
      assert(isValidTime(rule.endTime), `${label}: rule endTime must be HH:mm`);
      assert(Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0, `${label}: rule daysOfWeek is required`);
      for (const day of rule.daysOfWeek ?? []) {
        assert(Number.isInteger(day) && day >= 0 && day <= 6, `${label}: rule day ${day} is invalid`);
      }
    }
  }
}

function validateSettings(settings) {
  if (!settings) {
    return;
  }

  assert(Number.isFinite(settings.defaultImageDurationSeconds) && settings.defaultImageDurationSeconds > 0, "Settings: defaultImageDurationSeconds must be positive");
  assert(isValidTimezone(settings.defaultScheduleTimezone), "Settings: defaultScheduleTimezone must be valid");
  assert(Number.isFinite(settings.maxUploadBytes) && settings.maxUploadBytes > 0, "Settings: maxUploadBytes must be positive");
  assert(settings.preferredPlaybackMode === "vlc", "Settings: preferredPlaybackMode must be vlc");
  assert(isValidDate(settings.updatedAt), "Settings: updatedAt must be valid");
}

function validatePublishStatus(status, playlist) {
  if (!status) {
    return;
  }

  const playlistAssetCount = Array.isArray(playlist.assets) ? playlist.assets.length : null;
  assert(typeof status.action === "string" && status.action.trim(), "Publish status: action is required");
  assert(Number.isInteger(status.assetCount) && status.assetCount >= 0, "Publish status: assetCount must be a non-negative integer");
  assert(status.assetCount === playlistAssetCount, "Publish status: assetCount is stale");
  assert(typeof status.message === "string" && status.message.trim(), "Publish status: message is required");
  assert(typeof status.ok === "boolean", "Publish status: ok must be boolean");
  assert(typeof status.piPublishEnabled === "boolean", "Publish status: piPublishEnabled must be boolean");
  assert(status.playlistVersion === playlist.version, "Publish status: playlistVersion is stale");
  if (status.targets !== undefined) {
    assert(Array.isArray(status.targets), "Publish status: targets must be an array when present");
    for (const target of status.targets) {
      const label = `Publish target ${target?.deviceId ?? target?.deviceName ?? "(unknown)"}`;
      assert(target.deviceId === null || typeof target.deviceId === "string", `${label}: deviceId must be string or null`);
      assert(typeof target.deviceName === "string" && target.deviceName.trim(), `${label}: deviceName is required`);
      assert(target.host === null || typeof target.host === "string", `${label}: host must be string or null`);
      assert(target.screenId === null || typeof target.screenId === "string", `${label}: screenId must be string or null`);
      assert(typeof target.message === "string" && target.message.trim(), `${label}: message is required`);
      assert(typeof target.ok === "boolean", `${label}: ok must be boolean`);
      assert(typeof target.enabled === "boolean", `${label}: enabled must be boolean`);
    }
  }
  assert(isValidDate(status.timestamp), "Publish status: timestamp must be valid");
}

function validateActivity(activityStore) {
  if (!activityStore || !validateStoreShell(activityStore, "Activity store")) {
    return;
  }

  const ids = new Set();
  const unsafePattern = /(PISIGNAGE_PI_PASSWORD=|sshpass|BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^/\s:@]+:[^/\s:@]+@)/i;
  for (const item of activityStore.items) {
    const label = `Activity ${item?.id ?? "(missing id)"}`;
    assert(typeof item.id === "string" && item.id.trim(), `${label}: id is required`);
    assert(!ids.has(item.id), `${label}: duplicate id`);
    ids.add(item.id);
    assert(typeof item.action === "string" && item.action.trim(), `${label}: action is required`);
    assert(typeof item.actor === "string" && item.actor.trim(), `${label}: actor is required`);
    assert(typeof item.entityId === "string" && item.entityId.trim(), `${label}: entityId is required`);
    assert(["media", "screen", "device", "playlist", "layout", "schedule", "system"].includes(item.entityType), `${label}: entityType is invalid`);
    assert(["success", "warning", "error"].includes(item.result), `${label}: result is invalid`);
    assert(typeof item.message === "string" && item.message.trim(), `${label}: message is required`);
    assert(!unsafePattern.test(item.message), `${label}: message appears to contain a secret`);
    assert(isValidDate(item.timestamp), `${label}: timestamp must be valid`);
  }
}

function validateRecovery(recoveryStore) {
  if (!recoveryStore) {
    return;
  }

  if (!validateStoreShell(recoveryStore, "Recovery store", "runs")) {
    return;
  }

  const runIds = new Set();
  for (const run of recoveryStore.runs) {
    const label = `Recovery run ${run?.id ?? "(missing id)"}`;
    assert(typeof run.id === "string" && run.id.trim(), `${label}: id is required`);
    assert(!runIds.has(run.id), `${label}: duplicate id`);
    runIds.add(run.id);
    assert(isValidDate(run.startedAt), `${label}: startedAt must be valid`);
    assert(isValidDate(run.finishedAt), `${label}: finishedAt must be valid`);
    assert(typeof run.summary === "string" && run.summary.trim(), `${label}: summary is required`);
    assert(typeof run.triggeredBy === "string" && run.triggeredBy.trim(), `${label}: triggeredBy is required`);
    assert(typeof run.ok === "boolean", `${label}: ok must be boolean`);
    assert(Array.isArray(run.steps), `${label}: steps must be an array`);

    for (const step of run.steps ?? []) {
      const stepLabel = `${label} step ${step?.id ?? "(missing id)"}`;
      assert(typeof step.id === "string" && step.id.trim(), `${stepLabel}: id is required`);
      assert(typeof step.title === "string" && step.title.trim(), `${stepLabel}: title is required`);
      assert(typeof step.detail === "string", `${stepLabel}: detail must be present`);
      assert(step.status === "succeeded" || step.status === "failed", `${stepLabel}: status is invalid`);
      assert(isValidDate(step.startedAt), `${stepLabel}: startedAt must be valid`);
      assert(isValidDate(step.finishedAt), `${stepLabel}: finishedAt must be valid`);
    }
  }
}

const playlistPath = (await fileExists(livePlaylistPath)) ? livePlaylistPath : samplePlaylistPath;
const playlistLabel = playlistPath === livePlaylistPath ? "Live playlist" : "Sample playlist";
const playlist = await readJson(playlistPath, playlistLabel);
if (playlist) {
  await validatePlaylist(playlist, playlistLabel);
}

const playlistStore = (await fileExists(playlistStorePath))
  ? await readJson(playlistStorePath, "Playlist store")
  : null;
const validPlaylistIds = new Set(playlist?.playlistId ? [playlist.playlistId] : []);
if (playlistStore) {
  if (validateStoreShell(playlistStore, "Playlist store")) {
    const seenPlaylistIds = new Set();
    for (const storedPlaylist of playlistStore.items) {
      const label = `Playlist store ${storedPlaylist?.playlistId ?? "(missing id)"}`;
      assert(!seenPlaylistIds.has(storedPlaylist?.playlistId), `${label}: duplicate playlistId`);
      seenPlaylistIds.add(storedPlaylist?.playlistId);
      if (typeof storedPlaylist?.playlistId === "string") {
        validPlaylistIds.add(storedPlaylist.playlistId);
      }
      await validatePlaylist(storedPlaylist, label);
    }
  }
}

const mediaStore = await readOptionalJson("media.local.json", "Media store");
if (mediaStore) {
  await validateMediaStore(mediaStore);
}

validateLayouts(await readOptionalJson("layouts.local.json", "Layout store"), mediaStore, playlistStore);

const screensStore = await readOptionalJson("screens.local.json", "Screens store");
const devicesStore = await readOptionalJson("devices.local.json", "Devices store");
validateInventory(screensStore, devicesStore, validPlaylistIds);

const scheduleStore = await readOptionalJson("schedules.local.json", "Schedule store");
validateSchedules(scheduleStore, screensStore);

validateSettings(await readOptionalJson("settings.local.json", "Settings"));
if (playlist) {
  validatePublishStatus(await readOptionalJson("publish-status.json", "Publish status"), playlist);
}
validateActivity(await readOptionalJson("activity.local.json", "Activity store"));
validateRecovery(await readOptionalJson("recovery.local.json", "Recovery store"));

if (errors.length > 0) {
  console.error("Release state smoke failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Release state smoke passed using ${path.relative(repoRoot, playlistPath)}.`);
if (!requireAssetFiles) {
  console.log("Asset file existence was skipped by --allow-missing-assets.");
}
for (const note of notes) {
  console.log(note);
}
