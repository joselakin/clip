import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import ytdl from "@distube/ytdl-core";

import { createLogger } from "@/lib/logger";
import { getStorageRootDir } from "@/lib/storage";
import {
  buildYoutubeRequestOptions,
  downloadYoutubeVideoWithYtDlp,
  extractCodecs,
  getRetryDelayMs,
  getYoutubeRetryConfig,
  isBotCheckError,
  isRateLimitedError,
  pickBestCombinedFormat,
  shouldEnableYtDlpFallback,
  toFriendlyYoutubeError,
  type YtdlRequestOptions,
} from "@/lib/youtube/helpers";

const logger = createLogger("lib/youtube");

export async function downloadYoutubeVideoToLocal(url: string) {
  const trimmedUrl = url.trim();

  logger.info("download_request_started", { url: trimmedUrl });

  if (!ytdl.validateURL(trimmedUrl)) {
    logger.warn("invalid_youtube_url", { url: trimmedUrl });
    throw new Error("URL YouTube tidak valid");
  }

  const baseOptions = await buildYoutubeRequestOptions({ includeCookies: false, playerAttempt: 0 });
  const hasCookieConfig = Boolean(
    process.env.YOUTUBE_COOKIES_FILE?.trim() ||
      process.env.YOUTUBE_COOKIES_JSON?.trim() ||
      process.env.YOUTUBE_COOKIES_BASE64?.trim()
  );
  const retryConfig = getYoutubeRetryConfig();

  let info: Awaited<ReturnType<typeof ytdl.getInfo>> | null = null;
  let infoOptionsForDownload: YtdlRequestOptions = baseOptions;
  let lastError: unknown;

  const modes: Array<{ label: "no_cookie" | "with_cookie"; includeCookies: boolean }> = [
    { label: "no_cookie", includeCookies: false },
    ...(hasCookieConfig ? [{ label: "with_cookie" as const, includeCookies: true }] : []),
  ];

  outer: for (const mode of modes) {
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt += 1) {
      try {
        const optionsForAttempt = await buildYoutubeRequestOptions({
          includeCookies: mode.includeCookies,
          playerAttempt: attempt,
        });

        if (attempt > 0 || mode.includeCookies) {
          logger.warn("youtube_get_info_retry_attempt", {
            mode: mode.label,
            attempt,
            playerClients: optionsForAttempt.playerClients,
          });
        }

        info = await ytdl.getInfo(trimmedUrl, optionsForAttempt);
        infoOptionsForDownload = optionsForAttempt;
        logger.info("youtube_get_info_success", { mode: mode.label, attempt });
        break outer;
      } catch (error) {
        lastError = error;
        logger.error("youtube_get_info_failed", {
          mode: mode.label,
          attempt,
          message: error instanceof Error ? error.message : "Unknown error",
        });

        const canRetry = isRateLimitedError(error) && attempt < retryConfig.maxRetries;
        if (canRetry) {
          const waitMs = getRetryDelayMs(retryConfig.baseDelayMs, attempt + 1);
          logger.warn("youtube_get_info_retry_wait", { mode: mode.label, waitMs });
          await delay(waitMs);
          continue;
        }

        const shouldTryNextMode = mode.label === "no_cookie" && hasCookieConfig;
        if (shouldTryNextMode && (isBotCheckError(error) || isRateLimitedError(error))) {
          logger.warn("youtube_get_info_switching_mode", {
            from: mode.label,
            to: "with_cookie",
            reason: error instanceof Error ? error.message : "Unknown error",
          });
        }

        break;
      }
    }
  }

  if (!info) {
    if (lastError && shouldEnableYtDlpFallback() && (isRateLimitedError(lastError) || isBotCheckError(lastError))) {
      logger.warn("youtube_fallback_to_ytdlp", {
        reason: lastError instanceof Error ? lastError.message : "Unknown error",
      });
      return downloadYoutubeVideoWithYtDlp(trimmedUrl);
    }

    throw toFriendlyYoutubeError(lastError || new Error("Gagal mengambil info video YouTube"));
  }

  logger.info("youtube_info_resolved", { videoId: info.videoDetails.videoId });

  if (info.videoDetails.isLiveContent) {
    logger.warn("live_stream_not_supported", { videoId: info.videoDetails.videoId });
    throw new Error("Live stream belum didukung untuk proses ini");
  }

  const format = pickBestCombinedFormat(info.formats as Array<Record<string, unknown>>);
  if (!format) {
    logger.error("missing_combined_format", { videoId: info.videoDetails.videoId });
    throw new Error("Format audio+video gabungan tidak ditemukan");
  }

  const extension = format.container || "mp4";
  const videoId = info.videoDetails.videoId;
  const storageKey = `youtube/${videoId}-${Date.now()}.${extension}`;

  const root = getStorageRootDir();
  const outputPath = path.join(root, storageKey);

  await mkdir(path.dirname(outputPath), { recursive: true });
  logger.info("download_stream_started", { outputPath, itag: format.itag });

  const hash = createHash("sha256");
  let downloadedBytes = 0;

  const stream = ytdl.downloadFromInfo(info, {
    quality: format.itag,
    filter: "audioandvideo",
    ...infoOptionsForDownload,
  });
  stream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    downloadedBytes += chunk.length;
  });

  try {
    await pipeline(stream, createWriteStream(outputPath));
  } catch (error) {
    logger.error("youtube_download_stream_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw toFriendlyYoutubeError(error);
  }
  logger.info("download_stream_completed", { outputPath, downloadedBytes });

  const sha256 = hash.digest("hex");
  const durationSec = Number(info.videoDetails.lengthSeconds || "0");
  const durationMs = Math.max(1, Math.floor(durationSec * 1000));
  const bitrateKbps = typeof format.bitrate === "number" ? Math.round(format.bitrate / 1000) : null;

  const { videoCodec, audioCodec } = extractCodecs(format.mimeType || null);

  return {
    outputPath,
    storageKey,
    sha256,
    downloadedBytes,
    durationMs,
    videoId,
    title: info.videoDetails.title,
    channelName: info.videoDetails.author?.name || null,
    fps: typeof format.fps === "number" ? format.fps : null,
    width: typeof format.width === "number" ? format.width : null,
    height: typeof format.height === "number" ? format.height : null,
    mimeType: format.mimeType || null,
    bitrateKbps,
    sampleRate: format.audioSampleRate ? Number(format.audioSampleRate) : null,
    channels: typeof format.audioChannels === "number" ? format.audioChannels : null,
    videoCodec,
    audioCodec,
  };
}

export async function removeDownloadedFile(filePath: string) {
  logger.info("remove_downloaded_file", { filePath });
  await unlink(filePath).catch(() => undefined);
}
