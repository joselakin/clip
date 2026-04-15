import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { computeFaceCropPlan } from "@/lib/face-crop";
import { labelTwoSpeakerSegmentsWithGroq } from "@/lib/groq";
import { createLogger } from "@/lib/logger";
import {
  cropVideoToPortrait,
  cutClipFromVideo,
  cutPodcastSwitchedClip,
  generateThumbnailFromVideo,
  type PodcastSwitchSegment,
} from "@/lib/media";
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

type VideoWatermarkConfig = {
  renderLayout: "standard" | "framed";
  podcastTwoSpeakerMode: boolean;
  text: string | null;
  logoStorageKey: string | null;
  opacity: number;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseWatermarkConfig(metadata: unknown): VideoWatermarkConfig | null {
  const root = asObject(metadata);
  const renderLayout = root?.renderLayout === "framed" ? "framed" : "standard";
  const podcastTwoSpeakerMode = root?.podcastTwoSpeakerMode === true;
  const wm = asObject(root?.watermark);
  if (!wm) {
    return {
      renderLayout,
      podcastTwoSpeakerMode,
      text: null,
      logoStorageKey: null,
      opacity: 0.16,
    };
  }

  const enabled = wm.enabled !== false;
  if (!enabled) {
    return {
      renderLayout,
      podcastTwoSpeakerMode,
      text: null,
      logoStorageKey: null,
      opacity: 0.16,
    };
  }

  const text = typeof wm.text === "string" ? wm.text.trim() : "";
  const logoStorageKey = typeof wm.logoStorageKey === "string" ? wm.logoStorageKey.trim() : "";
  const rawOpacity = Number(wm.opacity);
  const opacity = Number.isFinite(rawOpacity) ? Math.max(0.05, Math.min(0.5, rawOpacity)) : 0.16;

  if (!text && !logoStorageKey) {
    return {
      renderLayout,
      podcastTwoSpeakerMode,
      text: null,
      logoStorageKey: null,
      opacity,
    };
  }

  return {
    renderLayout,
    podcastTwoSpeakerMode,
    text: text || null,
    logoStorageKey: logoStorageKey || null,
    opacity,
  };
}

function normalizeSpeakerLabel(value: unknown): "SPEAKER_1" | "SPEAKER_2" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (["SPEAKER_1", "SPK1", "A", "1"].includes(normalized)) {
    return "SPEAKER_1";
  }

  if (["SPEAKER_2", "SPK2", "B", "2"].includes(normalized)) {
    return "SPEAKER_2";
  }

  return null;
}

function buildPodcastTurnsForClip(
  transcriptSegments: Array<{ startMs: number; endMs: number; speakerLabel: string | null }>,
  clipStartMs: number,
  clipEndMs: number
): PodcastSwitchSegment[] {
  const rawTurns = transcriptSegments
    .filter((segment) => segment.endMs > clipStartMs && segment.startMs < clipEndMs)
    .map((segment) => {
      const speaker = normalizeSpeakerLabel(segment.speakerLabel);
      if (!speaker) {
        return null;
      }

      return {
        speaker,
        startMs: Math.max(clipStartMs, segment.startMs),
        endMs: Math.min(clipEndMs, segment.endMs),
      };
    })
    .filter((segment): segment is PodcastSwitchSegment => Boolean(segment))
    .filter((segment) => segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (rawTurns.length === 0) {
    return [];
  }

  const merged: PodcastSwitchSegment[] = [];
  for (const turn of rawTurns) {
    if (merged.length === 0) {
      merged.push({ ...turn });
      continue;
    }

    const prev = merged[merged.length - 1];
    if (turn.speaker === prev.speaker && turn.startMs <= prev.endMs + 200) {
      prev.endMs = Math.max(prev.endMs, turn.endMs);
      continue;
    }

    if (turn.startMs <= prev.endMs) {
      turn.startMs = prev.endMs;
      if (turn.endMs <= turn.startMs) {
        continue;
      }
    }

    merged.push({ ...turn });
  }

  const minTurnMs = 1_100;
  const smoothed: PodcastSwitchSegment[] = [];

  for (const turn of merged) {
    if (smoothed.length === 0) {
      smoothed.push({ ...turn });
      continue;
    }

    const prev = smoothed[smoothed.length - 1];
    const duration = turn.endMs - turn.startMs;

    if (duration < minTurnMs && turn.speaker !== prev.speaker) {
      prev.endMs = Math.max(prev.endMs, turn.endMs);
      continue;
    }

    if (turn.speaker === prev.speaker || turn.startMs <= prev.endMs + 160) {
      prev.endMs = Math.max(prev.endMs, turn.endMs);
      continue;
    }

    smoothed.push({ ...turn });
  }

  if (smoothed.length === 0) {
    return [];
  }

  if (smoothed[0].startMs > clipStartMs) {
    smoothed.unshift({
      speaker: smoothed[0].speaker,
      startMs: clipStartMs,
      endMs: smoothed[0].startMs,
    });
  } else {
    smoothed[0].startMs = clipStartMs;
  }

  const last = smoothed[smoothed.length - 1];
  if (last.endMs < clipEndMs) {
    smoothed.push({
      speaker: last.speaker,
      startMs: last.endMs,
      endMs: clipEndMs,
    });
  } else {
    last.endMs = clipEndMs;
  }

  return smoothed.filter((turn) => turn.endMs > turn.startMs);
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
      id: true,
      startMs: true,
      endMs: true,
      text: true,
      wordsJson: true,
      speakerLabel: true,
    },
  });

  const watermarkConfig = parseWatermarkConfig(video.metadata);
  const renderLayout = watermarkConfig?.renderLayout === "framed" ? "framed" : "standard";
  const podcastTwoSpeakerMode = Boolean(watermarkConfig?.podcastTwoSpeakerMode);
  let watermarkLogoPath: string | null = null;

  if (watermarkConfig?.logoStorageKey) {
    const resolved = resolveStoragePath(watermarkConfig.logoStorageKey);
    try {
      await stat(resolved);
      watermarkLogoPath = resolved;
    } catch {
      logger.warn("watermark_logo_missing", {
        videoId,
        logoStorageKey: watermarkConfig.logoStorageKey,
      });
    }
  }

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
          podcastTwoSpeakerMode,
        },
      },
    });

    jobId = job.id;
    logger.info("job_created", { jobId, videoId });

    const inputPath = resolveStoragePath(video.storageKey);
    const cropPlan = {
      faceFound: false,
      sampledFrames: 0,
      detectedFrames: 0,
      crop: { x: 0, y: 0, w: 1080, h: 1920 },
    };

    let portraitStorageKey: string | null = null;
    let portraitPath: string | null = null;

    const ensurePortraitFallbackPath = async (): Promise<string> => {
      if (portraitPath) {
        return portraitPath;
      }

      logger.info("podcast_fallback_face_crop_plan_started", { jobId, inputPath, renderLayout });
      const computedPlan = await computeFaceCropPlan(inputPath, 1080, 1920);
      cropPlan.faceFound = computedPlan.faceFound;
      cropPlan.sampledFrames = computedPlan.sampledFrames;
      cropPlan.detectedFrames = computedPlan.detectedFrames;
      cropPlan.crop = computedPlan.crop;

      portraitStorageKey = buildPortraitStorageKey(video.id);
      portraitPath = resolveStoragePath(portraitStorageKey);
      await cropVideoToPortrait(inputPath, portraitPath, cropPlan.crop, 1080, 1920);

      logger.info("podcast_fallback_face_crop_plan_completed", {
        jobId,
        portraitStorageKey,
        faceFound: cropPlan.faceFound,
      });

      return portraitPath;
    };

    if (renderLayout === "standard" && !podcastTwoSpeakerMode) {
      logger.info("face_crop_plan_started", { jobId, inputPath, renderLayout });
      const computedPlan = await computeFaceCropPlan(inputPath, 1080, 1920);
      cropPlan.faceFound = computedPlan.faceFound;
      cropPlan.sampledFrames = computedPlan.sampledFrames;
      cropPlan.detectedFrames = computedPlan.detectedFrames;
      cropPlan.crop = computedPlan.crop;

      logger.info("face_crop_plan_completed", {
        jobId,
        faceFound: cropPlan.faceFound,
        sampledFrames: cropPlan.sampledFrames,
        detectedFrames: cropPlan.detectedFrames,
      });

      portraitStorageKey = buildPortraitStorageKey(video.id);
      portraitPath = resolveStoragePath(portraitStorageKey);

      logger.info("portrait_render_started", { jobId, portraitStorageKey });
      await cropVideoToPortrait(inputPath, portraitPath, cropPlan.crop, 1080, 1920);
      logger.info("portrait_render_completed", { jobId, portraitStorageKey });
    } else {
      logger.info("special_render_mode", {
        jobId,
        videoId,
        renderLayout,
        podcastTwoSpeakerMode,
        note: podcastTwoSpeakerMode
          ? "Skip portrait face-crop stage; podcast mode uses source clip for dynamic switching."
          : "Skip portrait face-crop stage; framed mode uses source clip with 1:1 layout filter.",
      });
    }

    const clipSourcePath =
      renderLayout === "framed" || podcastTwoSpeakerMode ? inputPath : portraitPath || inputPath;

    const speakerLabelBySegmentId = new Map<string, "SPEAKER_1" | "SPEAKER_2" | null>();
    for (const segment of transcriptSegments) {
      speakerLabelBySegmentId.set(String(segment.id), normalizeSpeakerLabel(segment.speakerLabel));
    }

    if (podcastTwoSpeakerMode) {
      const transcriptInHighlightWindows = transcriptSegments.filter((segment) => {
        return highlights.some(
          (candidate) => segment.endMs > candidate.startMs && segment.startMs < candidate.endMs
        );
      });

      const existingLabelsCount = transcriptInHighlightWindows.filter((segment) =>
        Boolean(normalizeSpeakerLabel(segment.speakerLabel))
      ).length;

      if (transcriptInHighlightWindows.length > 0 && existingLabelsCount < transcriptInHighlightWindows.length) {
        const ownerRef = process.env.SINGLE_OWNER_REF ?? "self";
        const credential = await prisma.apiCredential.findFirst({
          where: {
            ownerRef,
            provider: "groq",
            isActive: true,
          },
          orderBy: {
            updatedAt: "desc",
          },
        });

        if (!credential) {
          logger.warn("podcast_mode_missing_groq_credential", { videoId, ownerRef });
        } else {
          try {
            const apiKey = decryptSecret(credential.encryptedApiKey);
            const labeling = await labelTwoSpeakerSegmentsWithGroq(
              transcriptInHighlightWindows.map((segment) => ({
                id: String(segment.id),
                startMs: segment.startMs,
                endMs: segment.endMs,
                text: segment.text,
              })),
              apiKey
            );

            for (const row of labeling.segments) {
              if (row.speakerLabel) {
                speakerLabelBySegmentId.set(row.id, row.speakerLabel);
              }
            }

            logger.info("podcast_speaker_labeling_completed", {
              videoId,
              model: labeling.model,
              total: labeling.segments.length,
            });
          } catch (error) {
            logger.warn("podcast_speaker_labeling_failed", {
              videoId,
              message:
                error instanceof Error ? error.message : "Speaker labeling gagal, fallback ke render standar",
            });
          }
        }
      } else {
        logger.info("podcast_speaker_labels_ready", {
          videoId,
          segments: transcriptInHighlightWindows.length,
          existingLabelsCount,
        });
      }
    }

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

      const speakerTurns = podcastTwoSpeakerMode
        ? buildPodcastTurnsForClip(
            transcriptSegments.map((segment) => ({
              startMs: segment.startMs,
              endMs: segment.endMs,
              speakerLabel:
                speakerLabelBySegmentId.get(String(segment.id)) || normalizeSpeakerLabel(segment.speakerLabel),
            })),
            candidate.startMs,
            candidate.endMs
          )
        : [];

      const hasBothSpeakers =
        speakerTurns.some((turn) => turn.speaker === "SPEAKER_1") &&
        speakerTurns.some((turn) => turn.speaker === "SPEAKER_2");

      if (podcastTwoSpeakerMode && hasBothSpeakers) {
        await cutPodcastSwitchedClip(
          clipSourcePath,
          clipPath,
          candidate.startMs,
          candidate.endMs,
          speakerTurns,
          {
            subtitlePath,
            watermarkText: watermarkConfig?.text,
            watermarkLogoPath,
            watermarkOpacity: watermarkConfig?.opacity,
            renderLayout,
          }
        );
      } else {
        if (podcastTwoSpeakerMode) {
          logger.warn("podcast_turns_incomplete_fallback", {
            videoId,
            candidateId: String(candidate.id),
            turns: speakerTurns.length,
          });
        }

        const fallbackSourcePath =
          podcastTwoSpeakerMode && renderLayout === "standard"
            ? await ensurePortraitFallbackPath()
            : clipSourcePath;

        await cutClipFromVideo(fallbackSourcePath, clipPath, candidate.startMs, candidate.endMs, {
          subtitlePath,
          watermarkText: watermarkConfig?.text,
          watermarkLogoPath,
          watermarkOpacity: watermarkConfig?.opacity,
          renderLayout,
        });
      }

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
      const nextMetadata: Record<string, unknown> = {
        ...oldMetadata,
        renderLayout,
        podcastTwoSpeakerMode,
      };

      if (renderLayout === "standard" && portraitStorageKey) {
        nextMetadata.portraitCrop = {
          crop: cropPlan.crop,
          faceFound: cropPlan.faceFound,
          sampledFrames: cropPlan.sampledFrames,
          detectedFrames: cropPlan.detectedFrames,
          portraitStorageKey,
          updatedAt: new Date().toISOString(),
        };
      }

      await tx.video.update({
        where: { id: videoId },
        data: {
          metadata: nextMetadata,
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
            renderLayout,
            podcastTwoSpeakerMode,
          },
        },
      });
    });

    logger.info("render_pipeline_completed", {
      jobId,
      videoId,
      clipCount: createdClips.length,
      faceFound: cropPlan.faceFound,
      renderLayout,
    });

    return NextResponse.json({
      ok: true,
      message: "Crop portrait dan render clips selesai",
      render: {
        faceFound: cropPlan.faceFound,
        renderLayout,
        podcastTwoSpeakerMode,
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
