/**
 * Self-updater for the Agents Chat Android app.
 *
 * Manifest contract (published by scripts/publish-release.sh):
 *   GET /repos/coda/agents-chat/releases?limit=1  → newest release
 *   its latest.json asset = {"version","versionCode","apk","size","releasedAt"}
 *   apk = attachment UUID url (auth required while repo is private)
 *
 * Download → expo-file-system; install → FileProvider + ACTION_VIEW intent.
 */
import * as Application from "expo-application";
import { File, Paths, DownloadTask } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";
import { compareVersions, isUpdateAvailable } from "./version";

const RELEASES_API = "https://git.angussoftware.dev/api/v1/repos/coda/agents-chat-releases/releases?limit=1";

export interface UpdateManifest {
  version: string;
  versionCode: number;
  apk: string;
  size: number;
  releasedAt: string;
}

export class UpdaterError extends Error {}

/** Fetch the newest release manifest. Throws UpdaterError on any failure. */
export async function fetchLatestManifest(): Promise<UpdateManifest | null> {
  type Release = { assets?: Array<{ name: string; browser_download_url: string }> };
  let release: Release | null = null;
  try {
    const res = await fetch(RELEASES_API);
    if (!res.ok) throw new UpdaterError(`releases api ${res.status}`);
    const list = (await res.json()) as Release[];
    release = list?.[0] ?? null;
  } catch (e) {
    throw new UpdaterError(e instanceof Error ? e.message : String(e));
  }
  const manifestAsset = release?.assets?.find((a) => a.name === "latest.json");
  if (!manifestAsset) return null;
  const res = await fetch(manifestAsset.browser_download_url);
  if (!res.ok) throw new UpdaterError(`manifest download ${res.status}`);
  const manifest = (await res.json()) as UpdateManifest;
  if (!manifest.version || !manifest.apk) throw new UpdaterError("manifest missing fields");
  return manifest;
}


type PendingUpdateListener = (u: PendingUpdate | null) => void;
export interface PendingUpdate {
  version: string;
  manifest: UpdateManifest;
}
let pendingUpdate: PendingUpdate | null = null;
const listeners = new Set<PendingUpdateListener>();
export function setPendingUpdate(u: PendingUpdate | null): void {
  pendingUpdate = u;
  for (const l of listeners) l(u);
}
export function subscribePendingUpdate(l: PendingUpdateListener): () => void {
  listeners.add(l);
  l(pendingUpdate);
  return () => listeners.delete(l);
}

export interface UpdateCheckResult {
  currentVersion: string;
  manifest: UpdateManifest | null;
  updateAvailable: boolean;
}

/** One update check: fetch manifest, compare to installed version. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = Application.nativeApplicationVersion ?? "0.0.0";
  const manifest = await fetchLatestManifest();
  return {
    currentVersion,
    manifest,
    updateAvailable: manifest ? isUpdateAvailable(manifest, currentVersion) : false,
  };
}

/** Download the APK and launch the system installer. Returns the local path. */
export async function downloadAndInstall(manifest: UpdateManifest, onProgress?: (pct: number) => void): Promise<string> {
  if (Platform.OS !== "android") throw new UpdaterError("android only");
  const file = new File(Paths.document, `agents-chat-${manifest.version}.apk`);
  if (file.exists) file.delete();

  const task = new DownloadTask(manifest.apk, file);
  task.addListener("progress", ({ bytesWritten, totalBytes }) => {
    if (totalBytes > 0) onProgress?.(bytesWritten / totalBytes);
  });
  const ok = await task.downloadAsync();
  if (!ok) throw new UpdaterError("download failed");

  if (manifest.size && file.exists && Math.abs(file.size - manifest.size) > 1024) {
    throw new UpdaterError(`size mismatch: got ${file.size}, expected ${manifest.size}`);
  }

  // content:// URI through the app's FileProvider so the installer can read
  // the APK from our private directory.
  const contentUri = `content://${Application.applicationId}.fileprovider/${file.name}`;
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    type: "application/vnd.android.package-archive",
  });
  return file.uri;
}
