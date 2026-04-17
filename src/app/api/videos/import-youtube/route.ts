import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, unlink as unlinkFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { parseClipCountTarget, parseClipDurationPreset } from "@/lib/clip-duration";
import { getYoutubeImportErrorStatus } from "@/lib/youtube/helpers";
import { createLogger } from "@/lib/logger";
import { downloadYoutubeVideoToLocal, removeDownloadedFile } from "@/lib/youtube";
import { prisma } from "@/lib/prisma";
import { resolveStoragePath } from "@/lib/storage";

export const runtime = "nodejs";
const logger = createLogger("api/videos/import-youtube");

function getExtensionFromStorageKey(storageKey: string): string {
  const parts = storageKey.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "mp4";
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "watermark";
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function imageExtensionFromFilename(filename: string, mimeType?: string): string {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return ext;
  }

  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "jpg";
}

function buildWatermarkStorageKey(filename: string, mimeType?: string): string {
  const safe = sanitizeFilename(filename);
  const ext = imageExtensionFromFilename(safe, mimeType);
  const base = safe.replace(new RegExp(`\\.${ext}$`, "i"), "") || "watermark";
  return `watermarks/${Date.now()}-${base}-${randomUUID().slice(0, 8)}.${ext}`;
}

async function persistWatermarkLogo(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("File logo watermark harus berupa gambar");
  }

  const maxImageBytes = 8 * 1024 * 1024;
  if (file.size > maxImageBytes) {
    throw new Error("Ukuran logo watermark maksimal 8MB");
  }

  const storageKey = buildWatermarkStorageKey(file.name, file.type || undefined);
  const outputPath = resolveStoragePath(storageKey);
  const bytes = Buffer.from(await file.arrayBuffer());

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  return storageKey;
}

type WatermarkInput = {
  renderLayout: "standard" | "framed";
  podcastTwoSpeakerMode: boolean;
  clipDurationPreset: ReturnType<typeof parseClipDurationPreset>;
  clipCountTarget: ReturnType<typeof parseClipCountTarget>;
  text: string | null;
  logoFile: File | null;
};

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function parseIncomingBody(request: NextRequest): Promise<{
  url: string;
  watermark: WatermarkInput;
}> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as {
      url?: string;
      watermarkText?: string;
      renderLayout?: string;
      podcastTwoSpeakerMode?: boolean | string;
      clipDurationPreset?: string;
      clipCountTarget?: string | number;
    };
    const layoutRaw = String(body.renderLayout || "standard").trim().toLowerCase();
    return {
      url: body.url?.trim() ?? "",
      watermark: {
        renderLayout: layoutRaw === "framed" ? "framed" : "standard",
        podcastTwoSpeakerMode: parseBooleanFlag(body.podcastTwoSpeakerMode),
        clipDurationPreset: parseClipDurationPreset(body.clipDurationPreset),
        clipCountTarget: parseClipCountTarget(body.clipCountTarget),
        text: String(body.watermarkText || "").trim().slice(0, 120) || null,
        logoFile: null,
      },
    };
  }

  const form = await request.formData();
  const logoCandidate = form.get("watermarkLogo");
  const layoutRaw = String(form.get("renderLayout") || "standard").trim().toLowerCase();

  return {
    url: String(form.get("url") || "").trim(),
    watermark: {
      renderLayout: layoutRaw === "framed" ? "framed" : "standard",
      podcastTwoSpeakerMode: parseBooleanFlag(form.get("podcastTwoSpeakerMode")),
      clipDurationPreset: parseClipDurationPreset(form.get("clipDurationPreset")),
      clipCountTarget: parseClipCountTarget(form.get("clipCountTarget")),
      text: String(form.get("watermarkText") || "").trim().slice(0, 120) || null,
      logoFile: logoCandidate instanceof File && logoCandidate.size > 0 ? logoCandidate : null,
    },
  };
}

export async function POST(request: NextRequest) {
  let downloadedPathForCleanup: string | null = null;
  let watermarkPathForCleanup: string | null = null;

  try {
    logger.info("request_received");

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!isValidSessionToken(token)) {
      logger.warn("unauthorized_request");
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const payload = await parseIncomingBody(request);
    const url = payload.url;

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
      const watermarkLogoStorageKey = payload.watermark.logoFile
        ? await persistWatermarkLogo(payload.watermark.logoFile)
        : null;

      if (watermarkLogoStorageKey) {
        watermarkPathForCleanup = resolveStoragePath(watermarkLogoStorageKey);
      }

      const oldMetadata = asObject(existing.metadata) || {};
      await prisma.video.update({
        where: { id: existing.id },
        data: {
          metadata: {
            ...oldMetadata,
            renderLayout: payload.watermark.renderLayout,
            podcastTwoSpeakerMode: payload.watermark.podcastTwoSpeakerMode,
            clipDurationPreset: payload.watermark.clipDurationPreset,
            clipCountTarget: payload.watermark.clipCountTarget,
            watermark:
              payload.watermark.text || watermarkLogoStorageKey
                ? {
                    enabled: true,
                    text: payload.watermark.text,
                    logoStorageKey: watermarkLogoStorageKey,
                    opacity: 0.16,
                    position: "center",
                    updatedAt: new Date().toISOString(),
                  }
                : {
                    enabled: false,
                    updatedAt: new Date().toISOString(),
                  },
          },
        },
      });

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

    const watermarkLogoStorageKey = payload.watermark.logoFile
      ? await persistWatermarkLogo(payload.watermark.logoFile)
      : null;

    if (watermarkLogoStorageKey) {
      watermarkPathForCleanup = resolveStoragePath(watermarkLogoStorageKey);
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
          renderLayout: payload.watermark.renderLayout,
          podcastTwoSpeakerMode: payload.watermark.podcastTwoSpeakerMode,
          clipDurationPreset: payload.watermark.clipDurationPreset,
          clipCountTarget: payload.watermark.clipCountTarget,
          ...(payload.watermark.text || watermarkLogoStorageKey
            ? {
                watermark: {
                  enabled: true,
                  text: payload.watermark.text,
                  logoStorageKey: watermarkLogoStorageKey,
                  opacity: 0.16,
                  position: "center",
                  updatedAt: new Date().toISOString(),
                },
              }
            : {}),
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

    if (watermarkPathForCleanup) {
      await unlinkFile(watermarkPathForCleanup).catch(() => undefined);
      logger.warn("cleanup_watermark_file_after_error", { watermarkPathForCleanup });
    }

    const message = error instanceof Error ? error.message : "Gagal memproses URL YouTube";
    const status = getYoutubeImportErrorStatus(error);

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
