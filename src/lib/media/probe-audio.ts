import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  logger,
  parseFps,
  runFfmpeg,
  runFfprobe,
  type ProbedMediaMetadata,
  type TranscriptionAudioChunk,
} from "@/lib/media/common";

export async function probeVideoMetadata(inputPath: string): Promise<ProbedMediaMetadata> {
  logger.info("probe_video_started", { inputPath });

  try {
    const { stdout } = await runFfprobe([
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
    const durationMs =
      Number.isFinite(durationSec) && durationSec > 0 ? Math.max(1, Math.floor(durationSec * 1000)) : 1000;

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
    throw new Error(
      "Gagal membaca metadata video. Pastikan ffprobe terinstall atau set FFPROBE_PATH yang benar."
    );
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
