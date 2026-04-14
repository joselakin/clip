import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { downloadYoutubeVideoToLocal, removeDownloadedFile } from "@/lib/youtube";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
const logger = createLogger("api/videos/import-youtube");

function getExtensionFromStorageKey(storageKey: string): string {
  const parts = storageKey.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "mp4";
}

export async function POST(request: NextRequest) {
  let downloadedPathForCleanup: string | null = null;

  try {
    logger.info("request_received");

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!isValidSessionToken(token)) {
      logger.warn("unauthorized_request");
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as { url?: string };
    const url = body.url?.trim() ?? "";

    if (!url) {
      logger.warn("validation_failed_missing_url");
      return NextResponse.json({ ok: false, message: "URL YouTube wajib diisi" }, { status: 400 });
    }

    logger.info("download_started", { url });
    const downloaded = await downloadYoutubeVideoToLocal(url);
    downloadedPathForCleanup = downloaded.outputPath;
    logger.info("download_completed", {
      videoId: downloaded.videoId,
      downloadedBytes: downloaded.downloadedBytes,
      storageKey: downloaded.storageKey,
    });

    const existing = await prisma.video.findUnique({
      where: {
        sha256: downloaded.sha256,
      },
    });

    if (existing) {
      logger.info("deduplication_hit", { existingVideoId: existing.id, sha256: downloaded.sha256 });
      await removeDownloadedFile(downloaded.outputPath);
      return NextResponse.json({
        ok: true,
        deduplicated: true,
        video: {
          id: existing.id,
          sourceUrl: existing.sourceUrl,
          storageKey: existing.storageKey,
          durationMs: existing.durationMs,
        },
      });
    }

    const created = await prisma.video.create({
      data: {
        sourceType: "url",
        sourceUrl: url,
        sourcePlatform: "youtube",
        externalVideoId: downloaded.videoId,
        sourceTitle: downloaded.title,
        storageKey: downloaded.storageKey,
        mimeType: downloaded.mimeType,
        sizeBytes: BigInt(downloaded.downloadedBytes),
        originalFilename: `${downloaded.videoId}.${getExtensionFromStorageKey(downloaded.storageKey)}`,
        sha256: downloaded.sha256,
        durationMs: downloaded.durationMs,
        fps: downloaded.fps,
        width: downloaded.width,
        height: downloaded.height,
        videoCodec: downloaded.videoCodec,
        audioCodec: downloaded.audioCodec,
        bitrateKbps: downloaded.bitrateKbps,
        sampleRate: downloaded.sampleRate,
        channels: downloaded.channels,
        metadata: {
          source: "youtube",
          channelName: downloaded.channelName,
          importedAt: new Date().toISOString(),
        },
      },
    });

    logger.info("video_record_created", {
      videoId: created.id,
      storageKey: created.storageKey,
      sourcePlatform: created.sourcePlatform,
    });

    return NextResponse.json({
      ok: true,
      deduplicated: false,
      video: {
        id: created.id,
        sourceUrl: created.sourceUrl,
        storageKey: created.storageKey,
        durationMs: created.durationMs,
      },
    });
  } catch (error) {
    if (downloadedPathForCleanup) {
      await removeDownloadedFile(downloadedPathForCleanup);
      logger.warn("cleanup_downloaded_file_after_error", { downloadedPathForCleanup });
    }

    const message = error instanceof Error ? error.message : "Gagal memproses URL YouTube";
    const lower = message.toLowerCase();
    const status = lower.includes("rate limit")
      ? 429
      : lower.includes("url youtube tidak valid") ||
          lower.includes("youtube memblokir request") ||
          lower.includes("cookies youtube")
        ? 400
        : 500;

    if (status >= 500) {
      logger.error("import_failed", { message, error });
    } else {
      logger.warn("import_failed_known_case", { status, message });
    }

    return NextResponse.json(
      {
        ok: false,
        message,
      },
      { status }
    );
  }
}
