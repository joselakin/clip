import path from "node:path";

export function getStorageRootDir(): string {
  const configured = process.env.LOCAL_VIDEO_STORAGE_DIR?.trim() || "storage";
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

export function resolveStoragePath(storageKey: string): string {
  return path.join(getStorageRootDir(), storageKey);
}

export function buildAudioStorageKey(videoId: string): string {
  return `audio/${videoId}-${Date.now()}.wav`;
}

export function buildPortraitStorageKey(videoId: string): string {
  return `processed/${videoId}/portrait-${Date.now()}.mp4`;
}

export function buildClipStorageKey(videoId: string, rank: number, startMs: number, endMs: number): string {
  return `clips/${videoId}/clip-${String(rank).padStart(2, "0")}-${startMs}-${endMs}.mp4`;
}

export function buildSubtitleStorageKey(videoId: string, rank: number, startMs: number, endMs: number): string {
  return `subtitles/${videoId}/clip-${String(rank).padStart(2, "0")}-${startMs}-${endMs}.ass`;
}

export function buildThumbnailStorageKey(videoId: string, rank: number, startMs: number, endMs: number): string {
  return `thumbnails/${videoId}/clip-${String(rank).padStart(2, "0")}-${startMs}-${endMs}.jpg`;
}
