import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { parseClipDurationPreset } from "@/lib/clip-duration";
import { createLogger } from "@/lib/logger";
import { probeVideoMetadata } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import { resolveStoragePath } from "@/lib/storage";

export const runtime = "nodejs";
const logger = createLogger("api/videos/upload");

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extensionFromFilename(filename: string, mimeType?: string): string {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  if (ext) {
    return ext;
  }

  if (mimeType === "video/quicktime") {
    return "mov";
  }
  if (mimeType === "video/webm") {
    return "webm";
  }
  return "mp4";
}

function buildUploadStorageKey(filename: string, mimeType?: string): string {
  const safe = sanitizeFilename(filename);
  const ext = extensionFromFilename(safe, mimeType);
  const base = safe.replace(new RegExp(`\\.${ext}$`, "i"), "") || "upload";
  return `uploads/${Date.now()}-${base}.${ext}`;
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
  text: string | null;
  logoFile: File | null;
};

function parseBooleanFlag(value: FormDataEntryValue | null): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseWatermarkInput(form: FormData): WatermarkInput {
  const layoutRaw = String(form.get("renderLayout") || "standard").trim().toLowerCase();
  const renderLayout: "standard" | "framed" = layoutRaw === "framed" ? "framed" : "standard";
  const podcastTwoSpeakerMode = parseBooleanFlag(form.get("podcastTwoSpeakerMode"));
  const clipDurationPreset = parseClipDurationPreset(form.get("clipDurationPreset"));
  const rawText = String(form.get("watermarkText") || "").trim();
  const text = rawText.slice(0, 120);
  const logoCandidate = form.get("watermarkLogo");
  const logoFile = logoCandidate instanceof File && logoCandidate.size > 0 ? logoCandidate : null;

  return {
    renderLayout,
    podcastTwoSpeakerMode,
    clipDurationPreset,
    text: text || null,
    logoFile,
  };
}

export async function POST(request: NextRequest) {
  let writtenPath: string | null = null;
  let writtenWatermarkPath: string | null = null;

  try {
    logger.info("request_received");

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!isValidSessionToken(token)) {
      logger.warn("unauthorized_request");
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const form = await request.formData();
    const file = form.get("file");
    const watermarkInput = parseWatermarkInput(form);

    if (!(file instanceof File)) {
      logger.warn("validation_missing_file");
      return NextResponse.json({ ok: false, message: "File video wajib diisi" }, { status: 400 });
    }

    if (file.size <= 0) {
      logger.warn("validation_empty_file", { filename: file.name });
      return NextResponse.json({ ok: false, message: "File kosong" }, { status: 400 });
    }

    const maxBytes = 1024 * 1024 * 1024;
    if (file.size > maxBytes) {
      logger.warn("validation_file_too_large", { filename: file.name, size: file.size });
      return NextResponse.json(
        { ok: false, message: "Ukuran file terlalu besar. Maksimal 1GB" },
        { status: 400 }
      );
    }

    const storageKey = buildUploadStorageKey(file.name, file.type || undefined);
    const outputPath = resolveStoragePath(storageKey);
    writtenPath = outputPath;

    const bytes = Buffer.from(await file.arrayBuffer());

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    logger.info("file_saved", {
      filename: file.name,
      storageKey,
      sizeBytes: file.size,
      sha256,
    });

    const existing = await prisma.video.findUnique({ where: { sha256 } });

    if (existing) {
      const watermarkLogoStorageKey = watermarkInput.logoFile
        ? await persistWatermarkLogo(watermarkInput.logoFile)
        : null;

      if (watermarkLogoStorageKey) {
        writtenWatermarkPath = resolveStoragePath(watermarkLogoStorageKey);
      }

      const oldMetadata = asObject(existing.metadata) || {};
      await prisma.video.update({
        where: { id: existing.id },
        data: {
          metadata: {
            ...oldMetadata,
            renderLayout: watermarkInput.renderLayout,
            podcastTwoSpeakerMode: watermarkInput.podcastTwoSpeakerMode,
            clipDurationPreset: watermarkInput.clipDurationPreset,
            watermark:
              watermarkInput.text || watermarkLogoStorageKey
                ? {
                    enabled: true,
                    text: watermarkInput.text,
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

      await unlink(outputPath).catch(() => undefined);
      logger.info("deduplication_hit", { existingVideoId: existing.id, sha256 });
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

    const probed = await probeVideoMetadata(outputPath);
    const watermarkLogoStorageKey = watermarkInput.logoFile
      ? await persistWatermarkLogo(watermarkInput.logoFile)
      : null;

    if (watermarkLogoStorageKey) {
      writtenWatermarkPath = resolveStoragePath(watermarkLogoStorageKey);
    }

    const created = await prisma.video.create({
      data: {
        sourceType: "upload",
        sourceTitle: file.name,
        sourcePlatform: "local_upload",
        storageKey,
        mimeType: file.type || null,
        sizeBytes: BigInt(file.size),
        originalFilename: file.name,
        sha256,
        durationMs: probed.durationMs,
        fps: probed.fps,
        width: probed.width,
        height: probed.height,
        videoCodec: probed.videoCodec,
        audioCodec: probed.audioCodec,
        bitrateKbps: probed.bitrateKbps,
        sampleRate: probed.sampleRate,
        channels: probed.channels,
        metadata: {
          source: "upload",
          uploadedAt: new Date().toISOString(),
          originalMimeType: file.type || null,
          renderLayout: watermarkInput.renderLayout,
          podcastTwoSpeakerMode: watermarkInput.podcastTwoSpeakerMode,
          clipDurationPreset: watermarkInput.clipDurationPreset,
          ...(watermarkInput.text || watermarkLogoStorageKey
            ? {
                watermark: {
                  enabled: true,
                  text: watermarkInput.text,
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

    logger.info("video_record_created", { videoId: created.id, storageKey: created.storageKey });

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
    if (writtenPath) {
      await unlink(writtenPath).catch(() => undefined);
      logger.warn("cleanup_written_file_after_error", { writtenPath });
    }

    if (writtenWatermarkPath) {
      await unlink(writtenWatermarkPath).catch(() => undefined);
      logger.warn("cleanup_written_watermark_after_error", { writtenWatermarkPath });
    }

    const message = error instanceof Error ? error.message : "Gagal upload video";
    logger.error("upload_failed", { message, error });

    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
