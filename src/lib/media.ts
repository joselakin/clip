import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createLogger } from "@/lib/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("lib/media");

type CropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type ProbedMediaMetadata = {
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
  renderLayout?: "standard" | "framed";
};

function escapeForFfmpegSubtitlesPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/'/g, "\\'");
}

function buildSubtitleFilterArg(subtitlePath: string): string {
  const escapedSubtitlePath = escapeForFfmpegSubtitlesPath(subtitlePath);
  const configuredFontsDir = process.env.SUBTITLE_FONTS_DIR?.trim();

  if (!configuredFontsDir) {
    return `subtitles=${escapedSubtitlePath}`;
  }

  const fontsDir = path.isAbsolute(configuredFontsDir)
    ? configuredFontsDir
    : path.join(process.cwd(), configuredFontsDir);
  const escapedFontsDir = escapeForFfmpegSubtitlesPath(fontsDir);
  return `subtitles=${escapedSubtitlePath}:fontsdir=${escapedFontsDir}`;
}

function clampOpacity(value?: number): number {
  const raw = typeof value === "number" ? value : 0.16;
  if (!Number.isFinite(raw)) {
    return 0.16;
  }
  return Math.max(0.05, Math.min(0.5, raw));
}

function escapeDrawtextText(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

function buildDrawtextFilter(text: string, opacity: number): string {
  const safeText = escapeDrawtextText(text.trim());
  return `drawtext=text='${safeText}':fontcolor=white@${opacity.toFixed(2)}:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2`;
}

function buildDrawtextFilterForLayout(
  text: string,
  opacity: number,
  layout: "standard" | "framed"
): string {
  if (layout === "framed") {
    const safeText = escapeDrawtextText(text.trim());
    return `drawtext=text='${safeText}':fontcolor=white@${Math.min(0.85, opacity + 0.2).toFixed(2)}:fontsize=58:borderw=2:bordercolor=black@0.45:x=(w-text_w)/2:y=166`;
  }

  return buildDrawtextFilter(text, opacity);
}

function buildFramedLayoutFilters(): string[] {
  const corner = 40;
  const size = 920;

  const alphaExpr = [
    `if(lt(X,${corner})*lt(Y,${corner})*gt(pow(X-${corner},2)+pow(Y-${corner},2),pow(${corner},2))`,
    ` + gt(X,W-${corner}-1)*lt(Y,${corner})*gt(pow(X-(W-${corner}-1),2)+pow(Y-${corner},2),pow(${corner},2))`,
    ` + lt(X,${corner})*gt(Y,H-${corner}-1)*gt(pow(X-${corner},2)+pow(Y-(H-${corner}-1),2),pow(${corner},2))`,
    ` + gt(X,W-${corner}-1)*gt(Y,H-${corner}-1)*gt(pow(X-(W-${corner}-1),2)+pow(Y-(H-${corner}-1),2),pow(${corner},2))`,
    `,0,255)`,
  ].join("");

  return [
    `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:black`,
    "format=rgba",
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'`,
    "pad=1080:1920:(ow-iw)/2:430:black",
  ];
}

function getFfmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function getFfprobeBin(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

async function runFfmpeg(args: string[]) {
  logger.debug("ffmpeg_start", { args });

  try {
    await execFileAsync(getFfmpegBin(), args);
    logger.debug("ffmpeg_done");
  } catch {
    logger.error("ffmpeg_failed", { args });
    throw new Error("Perintah ffmpeg gagal dijalankan");
  }
}

function parseFps(raw?: string): number | null {
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

export async function probeVideoMetadata(inputPath: string): Promise<ProbedMediaMetadata> {
  logger.info("probe_video_started", { inputPath });

  try {
    const { stdout } = await execFileAsync(getFfprobeBin(), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ]);

    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; bit_rate?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        sample_rate?: string;
        channels?: number;
      }>;
    };

    const streams = parsed.streams || [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");

    const durationSec = Number(parsed.format?.duration || "0");
    const durationMs = Number.isFinite(durationSec) && durationSec > 0 ? Math.max(1, Math.floor(durationSec * 1000)) : 1000;

    const bitrateRaw = Number(parsed.format?.bit_rate || "0");
    const bitrateKbps = Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? Math.round(bitrateRaw / 1000) : null;

    const sampleRateRaw = Number(audio?.sample_rate || "0");
    const sampleRate = Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? Math.round(sampleRateRaw) : null;

    const metadata: ProbedMediaMetadata = {
      durationMs,
      fps: parseFps(video?.r_frame_rate),
      width: typeof video?.width === "number" ? video.width : null,
      height: typeof video?.height === "number" ? video.height : null,
      videoCodec: video?.codec_name || null,
      audioCodec: audio?.codec_name || null,
      bitrateKbps,
      sampleRate,
      channels: typeof audio?.channels === "number" ? audio.channels : null,
    };

    logger.info("probe_video_completed", {
      inputPath,
      durationMs: metadata.durationMs,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
    });

    return metadata;
  } catch {
    logger.error("probe_video_failed", { inputPath });
    throw new Error("Gagal membaca metadata video. Pastikan ffprobe terinstall atau set FFPROBE_PATH yang benar.");
  }
}

export async function extractAudioForTranscription(inputPath: string, outputPath: string) {
  logger.info("extract_audio_started", { inputPath, outputPath });
  await mkdir(path.dirname(outputPath), { recursive: true });

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]).catch(() => {
    throw new Error(
      "Gagal ekstrak audio dengan ffmpeg. Pastikan ffmpeg terinstall atau set FFMPEG_PATH yang benar."
    );
  });
  logger.info("extract_audio_completed", { outputPath });
}

export async function splitAudioForTranscription(
  inputAudioPath: string,
  outputDir: string,
  chunkDurationSec = 8 * 60
): Promise<TranscriptionAudioChunk[]> {
  const metadata = await probeVideoMetadata(inputAudioPath);
  const durationMs = metadata.durationMs;

  if (durationMs <= 0) {
    return [];
  }

  await mkdir(outputDir, { recursive: true });

  const chunkMs = Math.max(30_000, Math.floor(chunkDurationSec * 1000));
  const chunks: TranscriptionAudioChunk[] = [];

  logger.info("split_audio_started", {
    inputAudioPath,
    outputDir,
    durationMs,
    chunkMs,
  });

  let partIndex = 1;
  for (let startMs = 0; startMs < durationMs; startMs += chunkMs, partIndex += 1) {
    const endMs = Math.min(durationMs, startMs + chunkMs);
    const outputPath = path.join(outputDir, `chunk-${String(partIndex).padStart(3, "0")}.wav`);

    await runFfmpeg([
      "-y",
      "-ss",
      (startMs / 1000).toFixed(3),
      "-i",
      inputAudioPath,
      "-t",
      Math.max(0.2, (endMs - startMs) / 1000).toFixed(3),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ]).catch(() => {
      throw new Error("Gagal memotong audio untuk transkripsi chunk.");
    });

    chunks.push({
      path: outputPath,
      startMs,
      endMs,
    });
  }

  logger.info("split_audio_completed", {
    inputAudioPath,
    chunks: chunks.length,
  });

  return chunks;
}

export async function cropVideoToPortrait(
  inputPath: string,
  outputPath: string,
  crop: CropRect,
  outputWidth = 1080,
  outputHeight = 1920
) {
  logger.info("crop_portrait_started", { inputPath, outputPath, crop, outputWidth, outputHeight });
  await mkdir(path.dirname(outputPath), { recursive: true });

  const filter = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${outputWidth}:${outputHeight}`;

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  logger.info("crop_portrait_completed", { outputPath });
}

export async function cutClipFromVideo(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  options?: ClipWatermarkOptions
) {
  const subtitlePath = options?.subtitlePath;
  const watermarkText = options?.watermarkText?.trim() || "";
  const watermarkLogoPath = options?.watermarkLogoPath?.trim() || "";
  const opacity = clampOpacity(options?.watermarkOpacity);
  const renderLayout = options?.renderLayout === "framed" ? "framed" : "standard";

  logger.info("cut_clip_started", {
    inputPath,
    outputPath,
    startMs,
    endMs,
    subtitleEnabled: Boolean(subtitlePath),
    watermarkTextEnabled: Boolean(watermarkText),
    watermarkLogoEnabled: Boolean(watermarkLogoPath),
    renderLayout,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });

  const startSec = Math.max(0, startMs / 1000).toFixed(3);
  const durationSec = Math.max(0.5, (endMs - startMs) / 1000).toFixed(3);

  const args = [
    "-y",
    "-ss",
    startSec,
    "-i",
    inputPath,
    "-t",
    durationSec,
  ];

  const filters: string[] = [];
  if (renderLayout === "framed") {
    filters.push(...buildFramedLayoutFilters());
  }

  if (subtitlePath) {
    filters.push(buildSubtitleFilterArg(subtitlePath));
  }
  if (watermarkText) {
    filters.push(buildDrawtextFilterForLayout(watermarkText, opacity, renderLayout));
  }

  if (watermarkLogoPath) {
    args.push("-i", watermarkLogoPath);

    const graphParts: string[] = [];
    let current = "0:v";
    let labelIndex = 0;

    for (const filter of filters) {
      const outLabel = `v${labelIndex + 1}`;
      graphParts.push(`[${current}]${filter}[${outLabel}]`);
      current = outLabel;
      labelIndex += 1;
    }

    const logoOpacity = opacity.toFixed(2);
    const logoScale =
      renderLayout === "framed"
        ? "scale=360:110:force_original_aspect_ratio=decrease"
        : "scale='if(gt(iw,486),486,iw)':-1";
    const logoOverlay =
      renderLayout === "framed" ? "overlay=(W-w)/2:140:format=auto" : "overlay=(W-w)/2:(H-h)/2:format=auto";

    graphParts.push(
      `[1:v]${logoScale},format=rgba,colorchannelmixer=aa=${logoOpacity}[wm]`
    );

    const outLabel = `v${labelIndex + 1}`;
    graphParts.push(`[${current}][wm]${logoOverlay}[${outLabel}]`);

    args.push(
      "-filter_complex",
      graphParts.join(";"),
      "-map",
      `[${outLabel}]`,
      "-map",
      "0:a?"
    );
  } else if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath
  );

  await runFfmpeg(args);
  logger.info("cut_clip_completed", { outputPath });
}

export async function generateThumbnailFromVideo(
  inputPath: string,
  outputPath: string,
  atSecond = 0.3,
  width = 540
) {
  logger.info("thumbnail_generation_started", { inputPath, outputPath, atSecond, width });
  await mkdir(path.dirname(outputPath), { recursive: true });

  await runFfmpeg([
    "-y",
    "-ss",
    atSecond.toFixed(3),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-1`,
    outputPath,
  ]);
  logger.info("thumbnail_generation_completed", { outputPath });
}
