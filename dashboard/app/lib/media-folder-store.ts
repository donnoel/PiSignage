import { cloudMediaConfig, readCloudMediaFolderStore, writeCloudMediaFolderStore } from "./cloud-media-store";
import {
  readMediaFolderStore as readLocalMediaFolderStore,
  writeMediaFolderStore as writeLocalMediaFolderStore
} from "./local-data-store";
import type { MediaFolderStore } from "./local-data-store";

export async function readMediaFolderStore(): Promise<MediaFolderStore> {
  const config = cloudMediaConfig();
  if (config) {
    return readCloudMediaFolderStore(config);
  }

  return readLocalMediaFolderStore();
}

export async function writeMediaFolderStore(store: MediaFolderStore): Promise<void> {
  const config = cloudMediaConfig();
  if (config) {
    await writeCloudMediaFolderStore(config, store);
    return;
  }

  await writeLocalMediaFolderStore(store);
}
