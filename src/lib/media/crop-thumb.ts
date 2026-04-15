import { mkdir } from "node:fs/promises";
import path from "node:path";

import { logger, runFfmpeg, type CropRect } from "@/lib/media/common";

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
