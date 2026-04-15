import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createLogger } from "@/lib/logger";
import type { RenderLayout } from "@/lib/media/render-filters";

const execFileAsync = promisify(execFile);
export const logger = createLogger("lib/media");

export type CropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ProbedMediaMetadata = {
  durationMs: number;
  fps: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
};

export type TranscriptionAudioChunk = {
  path: string;
  startMs: number;
  endMs: number;
};

export type ClipWatermarkOptions = {
  subtitlePath?: string;
  watermarkText?: string | null;
  watermarkLogoPath?: string | null;
  watermarkOpacity?: number;
  renderLayout?: RenderLayout;
};

function getFfmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function getFfprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

export function getResolvedFfprobeBin(): string {
  return getFfprobeBin();
}

export async function runFfmpeg(args: string[]) {
  logger.debug("ffmpeg_start", { args });

  try {
    await execFileAsync(getFfmpegBin(), args);
    logger.debug("ffmpeg_done");
  } catch {
    logger.error("ffmpeg_failed", { args });
    throw new Error("Perintah ffmpeg gagal dijalankan");
  }
}

export async function runFfprobe(args: string[]) {
  return execFileAsync(getFfprobeBin(), args);
}

export function parseFps(raw?: string): number | null {
  if (!raw) {
    return null;
  }

  if (raw.includes("/")) {
    const [numRaw, denRaw] = raw.split("/");
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Math.round((num / den) * 1000) / 1000;
    }
    return null;
  }

  const fps = Number(raw);
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}
