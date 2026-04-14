import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { probeVideoMetadata } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import { resolveStoragePath } from "@/lib/storage";

export const runtime = "nodejs";
const logger = createLogger("api/videos/upload");

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
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

export async function POST(request: NextRequest) {
  let writtenPath: string | null = null;

  try {
    logger.info("request_received");

    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!isValidSessionToken(token)) {
      logger.warn("unauthorized_request");
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const form = await request.formData();
    const file = form.get("file");

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

    const message = error instanceof Error ? error.message : "Gagal upload video";
    logger.error("upload_failed", { message, error });

    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
