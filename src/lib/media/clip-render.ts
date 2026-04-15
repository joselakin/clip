import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { logger, runFfmpeg, type ClipWatermarkOptions } from "@/lib/media/common";
import {
  buildDrawtextFilterForLayout,
  buildFramedLayoutFilters,
  buildSubtitleFilterArg,
  clampOpacity,
} from "@/lib/media/render-filters";
import {
  buildConcatList,
  computePodcastCropRect,
  normalizePodcastTurns,
  type PodcastSwitchSegment,
} from "@/lib/media/podcast-helpers";
import { probeVideoMetadata } from "@/lib/media/probe-audio";

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

  const args = ["-y", "-ss", startSec, "-i", inputPath, "-t", durationSec];

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

    graphParts.push(`[1:v]${logoScale},format=rgba,colorchannelmixer=aa=${logoOpacity}[wm]`);

    const outLabel = `v${labelIndex + 1}`;
    graphParts.push(`[${current}][wm]${logoOverlay}[${outLabel}]`);

    args.push("-filter_complex", graphParts.join(";"), "-map", `[${outLabel}]`, "-map", "0:a?");
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

export async function cutPodcastSwitchedClip(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  turns: PodcastSwitchSegment[],
  options?: ClipWatermarkOptions
) {
  const clipStartMs = Math.max(0, Math.round(startMs));
  const clipEndMs = Math.max(clipStartMs + 1, Math.round(endMs));
  const normalizedTurns = normalizePodcastTurns(turns, clipStartMs, clipEndMs);

  if (normalizedTurns.length === 0) {
    logger.warn("podcast_switch_no_turns_fallback", {
      inputPath,
      outputPath,
      clipStartMs,
      clipEndMs,
    });
    await cutClipFromVideo(inputPath, outputPath, clipStartMs, clipEndMs, options);
    return;
  }

  const metadata = await probeVideoMetadata(inputPath);
  const inputWidth = metadata.width || 0;
  const inputHeight = metadata.height || 0;

  if (inputWidth <= 0 || inputHeight <= 0) {
    logger.warn("podcast_switch_missing_dimensions_fallback", {
      inputPath,
      outputPath,
      inputWidth,
      inputHeight,
    });
    await cutClipFromVideo(inputPath, outputPath, clipStartMs, clipEndMs, options);
    return;
  }

  logger.info("podcast_switch_clip_started", {
    inputPath,
    outputPath,
    clipStartMs,
    clipEndMs,
    turns: normalizedTurns.length,
  });

  const tempRoot = await mkdtemp(path.join(tmpdir(), "clipper-podcast-switch-"));

  try {
    const shotPaths: string[] = [];

    for (const [index, turn] of normalizedTurns.entries()) {
      const crop = computePodcastCropRect(
        inputWidth,
        inputHeight,
        turn.speaker === "SPEAKER_1" ? "left" : "right"
      );

      const shotPath = path.join(tempRoot, `shot-${String(index + 1).padStart(3, "0")}.mp4`);
      const shotStartSec = Math.max(0, turn.startMs / 1000).toFixed(3);
      const shotDurationSec = Math.max(0.2, (turn.endMs - turn.startMs) / 1000).toFixed(3);

      await runFfmpeg([
        "-y",
        "-ss",
        shotStartSec,
        "-i",
        inputPath,
        "-t",
        shotDurationSec,
        "-vf",
        `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1080:1920`,
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
        shotPath,
      ]);

      shotPaths.push(shotPath);
    }

    if (shotPaths.length === 0) {
      await cutClipFromVideo(inputPath, outputPath, clipStartMs, clipEndMs, options);
      return;
    }

    const concatFilePath = path.join(tempRoot, "concat-list.txt");
    await writeFile(concatFilePath, buildConcatList(shotPaths), "utf8");

    const stitchedPath = path.join(tempRoot, "stitched.mp4");
    await runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFilePath,
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
      stitchedPath,
    ]);

    const stitchedDurationMs = Math.max(500, clipEndMs - clipStartMs);
    await cutClipFromVideo(stitchedPath, outputPath, 0, stitchedDurationMs, options);

    logger.info("podcast_switch_clip_completed", {
      outputPath,
      turns: normalizedTurns.length,
      stitchedDurationMs,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
