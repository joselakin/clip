import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { computeFaceCropPlan } from "@/lib/face-crop";
import { createLogger } from "@/lib/logger";
import { cropVideoToPortrait, cutClipFromVideo, generateThumbnailFromVideo } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import {
  buildClipStorageKey,
  buildPortraitStorageKey,
  buildSubtitleStorageKey,
  buildThumbnailStorageKey,
  resolveStoragePath,
} from "@/lib/storage";
import { buildAss, buildSubtitleEntriesForClip } from "@/lib/subtitles";

export const runtime = "nodejs";
const logger = createLogger("api/videos/render-clips");

function buildTranscriptSnapshot(
  transcriptSegments: Array<{ startMs: number; endMs: number; text: string }>,
  startMs: number,
  endMs: number
): string {
  const parts = transcriptSegments
    .filter((segment) => segment.endMs > startMs && segment.startMs < endMs)
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0);

  return parts.join(" ").slice(0, 8000) || "";
}

export async function POST(request: NextRequest) {
  logger.info("request_received");

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    logger.warn("unauthorized_request");
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { videoId?: string };
  const videoId = body.videoId?.trim() ?? "";

  if (!videoId) {
    logger.warn("validation_failed_missing_video_id");
    return NextResponse.json({ ok: false, message: "videoId wajib diisi" }, { status: 400 });
  }

  const video = await prisma.video.findUnique({ where: { id: videoId } });
  if (!video) {
    logger.warn("video_not_found", { videoId });
    return NextResponse.json({ ok: false, message: "Video tidak ditemukan" }, { status: 404 });
  }

  const highlights = await prisma.highlightCandidate.findMany({
    where: {
      videoId,
      isSelected: true,
    },
    orderBy: [{ rankOrder: "asc" }, { scoreTotal: "desc" }],
  });

  if (highlights.length === 0) {
    logger.warn("missing_highlights", { videoId });
    return NextResponse.json(
      { ok: false, message: "Belum ada highlight kandidat terpilih untuk video ini" },
      { status: 400 }
    );
  }

  const transcriptSegments = await prisma.transcriptSegment.findMany({
    where: { videoId },
    orderBy: { startMs: "asc" },
    select: {
      startMs: true,
      endMs: true,
      text: true,
      wordsJson: true,
    },
  });

  let jobId = "";

  try {
    logger.info("job_creating", { videoId, highlightCount: highlights.length });
    const job = await prisma.job.create({
      data: {
        videoId,
        jobType: "RENDER_CLIP",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        queuedAt: new Date(),
        startedAt: new Date(),
        payload: {
          source: "dashboard",
          step: "crop-portrait-and-render-clips",
          highlightCount: highlights.length,
        },
      },
    });

    jobId = job.id;
    logger.info("job_created", { jobId, videoId });

    const inputPath = resolveStoragePath(video.storageKey);
    logger.info("face_crop_plan_started", { jobId, inputPath });
    const cropPlan = await computeFaceCropPlan(inputPath, 1080, 1920);
    logger.info("face_crop_plan_completed", {
      jobId,
      faceFound: cropPlan.faceFound,
      sampledFrames: cropPlan.sampledFrames,
      detectedFrames: cropPlan.detectedFrames,
    });

    const portraitStorageKey = buildPortraitStorageKey(video.id);
    const portraitPath = resolveStoragePath(portraitStorageKey);

    logger.info("portrait_render_started", { jobId, portraitStorageKey });
    await cropVideoToPortrait(inputPath, portraitPath, cropPlan.crop, 1080, 1920);
    logger.info("portrait_render_completed", { jobId, portraitStorageKey });

    await prisma.clip.deleteMany({
      where: {
        videoId,
      },
    });
    logger.info("old_clips_deleted", { jobId, videoId });

    const createdClips: Array<{
      id: string;
      startMs: number;
      endMs: number;
      outputFileKey: string;
      subtitleMode: "none" | "hard";
      subtitleFileKey: string | null;
      thumbnailKey: string | null;
    }> = [];

    for (const [index, candidate] of highlights.entries()) {
      logger.info("clip_render_started", {
        jobId,
        index: index + 1,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
      });

      const clipStorageKey = buildClipStorageKey(
        video.id,
        index + 1,
        candidate.startMs,
        candidate.endMs
      );

      const clipPath = resolveStoragePath(clipStorageKey);

      const subtitleEntries = buildSubtitleEntriesForClip(
        transcriptSegments,
        candidate.startMs,
        candidate.endMs
      );

      let subtitleFileKey: string | null = null;
      let subtitlePath: string | undefined;

      if (subtitleEntries.length > 0) {
        subtitleFileKey = buildSubtitleStorageKey(
          video.id,
          index + 1,
          candidate.startMs,
          candidate.endMs
        );
        subtitlePath = resolveStoragePath(subtitleFileKey);
        await mkdir(path.dirname(subtitlePath), { recursive: true });
        await writeFile(subtitlePath, buildAss(subtitleEntries), "utf8");
      }

      await cutClipFromVideo(portraitPath, clipPath, candidate.startMs, candidate.endMs, subtitlePath);

      const thumbnailKey = buildThumbnailStorageKey(
        video.id,
        index + 1,
        candidate.startMs,
        candidate.endMs
      );
      const thumbnailPath = resolveStoragePath(thumbnailKey);
      await generateThumbnailFromVideo(clipPath, thumbnailPath, 0.3, 540);

      const clip = await prisma.clip.create({
        data: {
          videoId,
          highlightCandidateId: candidate.id,
          renderJobId: jobId,
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          targetAspect: "9:16",
          outputWidth: 1080,
          outputHeight: 1920,
          subtitleMode: subtitleFileKey ? "hard" : "none",
          subtitleFileKey,
          outputFileKey: clipStorageKey,
          thumbnailKey,
          transcriptSnapshot: buildTranscriptSnapshot(
            transcriptSegments,
            candidate.startMs,
            candidate.endMs
          ),
          status: "ready",
        },
      });

      createdClips.push({
        id: clip.id,
        startMs: clip.startMs,
        endMs: clip.endMs,
        outputFileKey: clip.outputFileKey,
        subtitleMode: clip.subtitleMode,
        subtitleFileKey: clip.subtitleFileKey,
        thumbnailKey: clip.thumbnailKey,
      });

      logger.info("clip_render_completed", {
        jobId,
        clipId: clip.id,
        index: index + 1,
        outputFileKey: clip.outputFileKey,
        thumbnailKey: clip.thumbnailKey,
      });
    }

    const oldMetadata =
      typeof video.metadata === "object" && video.metadata && !Array.isArray(video.metadata)
        ? (video.metadata as Record<string, unknown>)
        : {};

    await prisma.$transaction(async (tx) => {
      await tx.video.update({
        where: { id: videoId },
        data: {
          metadata: {
            ...oldMetadata,
            portraitCrop: {
              crop: cropPlan.crop,
              faceFound: cropPlan.faceFound,
              sampledFrames: cropPlan.sampledFrames,
              detectedFrames: cropPlan.detectedFrames,
              portraitStorageKey,
              updatedAt: new Date().toISOString(),
            },
          },
        },
      });

      await tx.job.update({
        where: { id: jobId },
        data: {
          status: "success",
          finishedAt: new Date(),
          result: {
            clipCount: createdClips.length,
            faceFound: cropPlan.faceFound,
            sampledFrames: cropPlan.sampledFrames,
            detectedFrames: cropPlan.detectedFrames,
            portraitStorageKey,
          },
        },
      });
    });

    logger.info("render_pipeline_completed", {
      jobId,
      videoId,
      clipCount: createdClips.length,
      faceFound: cropPlan.faceFound,
    });

    return NextResponse.json({
      ok: true,
      message: "Crop portrait dan render clips selesai",
      render: {
        faceFound: cropPlan.faceFound,
        clipCount: createdClips.length,
        clips: createdClips,
      },
    });
  } catch (error) {
    if (jobId) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : "Render clips gagal",
          lastError: error instanceof Error ? error.message : "Render clips gagal",
        },
      });
    }

    logger.error("render_pipeline_failed", {
      videoId,
      jobId,
      message: error instanceof Error ? error.message : "Render clips gagal",
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Render clips gagal",
      },
      { status: 500 }
    );
  }
}
