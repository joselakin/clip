import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import {
  getClipDurationPresetConfig,
  parseClipCountTarget,
  parseClipDurationPreset,
  type ClipCountTarget,
  type ClipDurationPreset,
} from "@/lib/clip-duration";
import { decryptSecret } from "@/lib/crypto";
import {
  DEFAULT_EMOTION_CONTEXT,
  parseEmotionContext,
  type EmotionContext,
} from "@/lib/emotion-context";
import { evaluateClipRecommendationsWithGroq, selectHighlightsWithGroq } from "@/lib/groq";
import { runIterativeHighlightPipeline } from "@/lib/highlight-pipeline";
import { findRunningJobForStep } from "@/lib/job-dedupe";
import { createLogger } from "@/lib/logger";
import { publishPipelineStatusUpdate } from "@/lib/pipeline-events";
import { getPipelineStatusByVideoId } from "@/lib/pipeline-status";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
const logger = createLogger("api/videos/highlights/select");

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveDurationPreset(
  rawPreset: unknown,
  metadata: unknown,
  fallback: ClipDurationPreset = "under_1_minute"
): ClipDurationPreset {
  if (typeof rawPreset === "string" && rawPreset.trim()) {
    return parseClipDurationPreset(rawPreset, fallback);
  }

  const metadataObj = asObject(metadata);
  return parseClipDurationPreset(metadataObj?.clipDurationPreset, fallback);
}

function resolveClipCountTarget(
  rawCountTarget: unknown,
  metadata: unknown,
  fallback: ClipCountTarget = 6
): ClipCountTarget {
  if (typeof rawCountTarget === "number" || typeof rawCountTarget === "string") {
    return parseClipCountTarget(rawCountTarget, fallback);
  }

  const metadataObj = asObject(metadata);
  return parseClipCountTarget(metadataObj?.clipCountTarget, fallback);
}

function enforceDuration(
  startMs: number,
  endMs: number,
  durationPreset: ClipDurationPreset,
  transcriptMaxEndMs: number
): { startMs: number; endMs: number } {
  const config = getClipDurationPresetConfig(durationPreset);
  const maxEndBoundary = Math.max(1, Math.round(transcriptMaxEndMs));

  let start = Math.max(0, Math.round(startMs));
  let end = Math.max(start + 1, Math.round(endMs));
  let duration = end - start;

  if (duration > config.maxDurationMs) {
    end = start + config.maxDurationMs;
    duration = end - start;
  }

  if (duration < config.minDurationMs) {
    end = start + config.minDurationMs;
  }

  if (end > maxEndBoundary) {
    end = maxEndBoundary;
    start = Math.max(0, end - config.maxDurationMs);
  }

  if (end - start < config.minDurationMs && end === maxEndBoundary) {
    start = Math.max(0, end - config.minDurationMs);
  }

  if (end <= start) {
    end = Math.min(maxEndBoundary, start + 1);
    start = Math.max(0, end - 1);
  }

  return { startMs: start, endMs: end };
}

function evalKey(startMs: number, endMs: number): string {
  return `${Math.round(startMs)}-${Math.round(endMs)}`;
}

type ClipEvaluationReview = {
  recommendedTitle: string;
  overallScore: number;
  hookScore: number;
  valueScore: number;
  clarityScore: number;
  emotionScore: number;
  shareabilityScore: number;
  whyThisWorks: string;
  improvementTip: string;
  angle?: string;
  matchedEmotionContext?: EmotionContext;
  emotionFitScore?: number;
  emotionFitReason?: string;
  emotionFallback?: boolean;
};

type NormalizedCandidate = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
  matchedEmotionContext?: EmotionContext;
  emotionFitScore?: number;
  emotionFitReason?: string;
  emotionFallback?: boolean;
  review: ClipEvaluationReview;
};

 type HighlightPipelineMode = "legacy" | "iterative";

function resolveRequestedEmotionContext(
  rawEmotionContext: unknown,
  storedEmotionContext: EmotionContext | null | undefined,
): EmotionContext {
  if (typeof rawEmotionContext === "string" && rawEmotionContext.trim()) {
    return parseEmotionContext(rawEmotionContext, storedEmotionContext || DEFAULT_EMOTION_CONTEXT);
  }

  return storedEmotionContext || DEFAULT_EMOTION_CONTEXT;
}

 function resolveHighlightPipelineMode(rawMode: string | undefined): HighlightPipelineMode {

  const normalizedMode = rawMode?.trim().toLowerCase();
  return normalizedMode === "legacy" ? "legacy" : "iterative";
}

export async function POST(request: NextRequest) {
  logger.info("request_received");

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    logger.warn("unauthorized_request");
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  let body: {
    videoId?: string;
    durationPreset?: string;
    clipCountTarget?: string | number;
    emotionContext?: string;
  };
  try {
    body = (await request.json()) as {
      videoId?: string;
      durationPreset?: string;
      clipCountTarget?: string | number;
      emotionContext?: string;
    };
  } catch {
    logger.warn("validation_failed_invalid_json");
    return NextResponse.json({ ok: false, message: "Body JSON tidak valid" }, { status: 400 });
  }
  const videoId = body.videoId?.trim() ?? "";

  if (!videoId) {
    logger.warn("validation_failed_missing_video_id");
    return NextResponse.json({ ok: false, message: "videoId wajib diisi" }, { status: 400 });
  }

  const video = await prisma.video.findUnique({
    where: { id: videoId },
  });

  if (!video) {
    logger.warn("video_not_found", { videoId });
    return NextResponse.json({ ok: false, message: "Video tidak ditemukan" }, { status: 404 });
  }

  const durationPreset = resolveDurationPreset(body.durationPreset, video.metadata);
  const durationConfig = getClipDurationPresetConfig(durationPreset);
  const clipCountTarget = resolveClipCountTarget(body.clipCountTarget, video.metadata);
  const emotionContext = resolveRequestedEmotionContext(body.emotionContext, video.requestedEmotionContext);

  const transcriptSegments = await prisma.transcriptSegment.findMany({
    where: { videoId },
    orderBy: { startMs: "asc" },
    select: {
      startMs: true,
      endMs: true,
      text: true,
    },
  });

  if (transcriptSegments.length === 0) {
    logger.warn("missing_transcript_segments", { videoId });
    return NextResponse.json(
      { ok: false, message: "Transcript belum tersedia untuk video ini" },
      { status: 400 }
    );
  }

  const transcriptMaxEndMs = transcriptSegments[transcriptSegments.length - 1]?.endMs ?? 1;

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
    logger.warn("missing_active_groq_credential", { ownerRef });
    return NextResponse.json(
      { ok: false, message: "Groq API key aktif belum tersedia. Simpan dulu di sidebar." },
      { status: 400 }
    );
  }

  let jobId = "";

  try {
    const existingJob = await findRunningJobForStep(prisma, {
      videoId,
      jobType: "HIGHLIGHT",
    });
    if (existingJob) {
      logger.info("job_deduplicated", { videoId, existingJobId: existingJob.id, jobType: "HIGHLIGHT" });
      return NextResponse.json({
        ok: true,
        deduplicated: true,
        jobId: existingJob.id,
        message: "Highlight selection sedang berjalan",
      });
    }

    logger.info("job_creating", { videoId, transcriptCount: transcriptSegments.length });
    const job = await prisma.job.create({
      data: {
        videoId,
        jobType: "HIGHLIGHT",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        queuedAt: new Date(),
        startedAt: new Date(),
        sttProvider: "groq",
        sttModel: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
        credentialMode: "user_supplied",
        credentialFingerprint: credential.keyFingerprint,
        credentialId: credential.id,
        payload: {
          source: "dashboard",
          step: "transcript-to-highlight",
          transcriptCount: transcriptSegments.length,
          clipDurationPreset: durationPreset,
          clipCountTarget,
          emotionContext,
          clipMinDurationMs: durationConfig.minDurationMs,
          clipMaxDurationMs: durationConfig.maxDurationMs,
        },
      },
    });

    jobId = job.id;
    logger.info("job_created", { jobId, videoId });

    const apiKey = decryptSecret(credential.encryptedApiKey);
    const pipelineMode = resolveHighlightPipelineMode(process.env.HIGHLIGHT_PIPELINE_MODE);
    let pipelineVersion = "legacy-v1";
    let pipelineRunId: string | null = null;
    let pipelineSummary: Prisma.InputJsonValue = {};
    let originalCandidateCount = 0;
    let selectionModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b";
    let reviewModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b";
    let normalizedCandidates: NormalizedCandidate[] = [];

    if (pipelineMode === "legacy") {
      logger.info("highlight_selection_started", {
        jobId,
        mode: "legacy",
        model: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
      });
      const selectionWithDuration = await selectHighlightsWithGroq(transcriptSegments, apiKey, {
        maxCandidates: clipCountTarget,
        durationRule: durationConfig.promptRule,
        extraRules: durationConfig.extraPromptRule ? [durationConfig.extraPromptRule] : undefined,
        emotionContext,
      });
      originalCandidateCount = selectionWithDuration.candidates.length;
      selectionModel = selectionWithDuration.model;
      logger.info("highlight_selection_completed", {
        jobId,
        mode: "legacy",
        model: selectionWithDuration.model,
        candidateCount: selectionWithDuration.candidates.length,
        clipDurationPreset: durationPreset,
        clipCountTarget,
      });

      const baseCandidates = selectionWithDuration.candidates.slice(0, clipCountTarget).map((candidate) => {
        const durationAligned = enforceDuration(
          candidate.startMs,
          candidate.endMs,
          durationPreset,
          transcriptMaxEndMs
        );
        return {
          ...candidate,
          ...durationAligned,
          scoreTotal: clamp(candidate.scoreTotal, 0, 1),
          scoreText: clamp(candidate.scoreText, 0, 1),
        };
      });

      logger.info("clip_evaluation_started", {
        jobId,
        mode: "legacy",
        model: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
        candidateCount: baseCandidates.length,
      });
      const evaluation = await evaluateClipRecommendationsWithGroq(
        transcriptSegments,
        baseCandidates,
        apiKey,
        { emotionContext }
      );
      reviewModel = evaluation.model;

      const reviewMap = new Map<string, ClipEvaluationReview>();
      for (const row of evaluation.evaluations) {
        reviewMap.set(evalKey(row.startMs, row.endMs), {
          recommendedTitle: row.recommendedTitle,
          overallScore: row.overallScore,
          hookScore: row.hookScore,
          valueScore: row.valueScore,
          clarityScore: row.clarityScore,
          emotionScore: row.emotionScore,
          shareabilityScore: row.shareabilityScore,
          whyThisWorks: row.whyThisWorks,
          improvementTip: row.improvementTip,
          angle: row.angle,
          matchedEmotionContext: row.matchedEmotionContext,
          emotionFitScore: row.emotionFitScore,
          emotionFitReason: row.emotionFitReason,
          emotionFallback: row.emotionFallback,
        });
      }

      normalizedCandidates = baseCandidates.map((candidate) => {
        const review =
          reviewMap.get(evalKey(candidate.startMs, candidate.endMs)) || {
            recommendedTitle: "Momen Penting yang Bikin Penasaran",
            overallScore: Math.round(candidate.scoreTotal * 100),
            hookScore: Math.round(candidate.scoreTotal * 100),
            valueScore: Math.round(candidate.scoreText * 100),
            clarityScore: Math.round(candidate.scoreText * 100),
            emotionScore: 72,
            shareabilityScore: 74,
            whyThisWorks: candidate.reason,
            improvementTip: "Perkuat kalimat pembuka agar hook makin cepat terasa.",
            angle: candidate.topic,
            matchedEmotionContext: candidate.matchedEmotionContext,
            emotionFitScore: candidate.emotionFitScore,
            emotionFitReason: candidate.emotionFitReason,
            emotionFallback: candidate.emotionFallback,
          };

        return {
          ...candidate,
          review,
        };
      });

      logger.info("clip_evaluation_completed", {
        jobId,
        mode: "legacy",
        model: evaluation.model,
        evaluations: evaluation.evaluations.length,
      });
    } else {
      logger.info("highlight_selection_started", {
        jobId,
        mode: "iterative",
        model: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
      });
      const iterative = await runIterativeHighlightPipeline({
        videoId,
        jobId,
        transcriptSegments,
        apiKey,
          clipCountTarget,
          durationPreset,
          emotionContext,
          durationRangeMs: {
            min: durationConfig.minDurationMs,
            max: durationConfig.maxDurationMs,
          },
        });


      pipelineVersion = iterative.runSummary.pipelineVersion;
      pipelineRunId = iterative.runSummary.runId;
      pipelineSummary = {
        ...iterative.runSummary,
      } as Prisma.InputJsonValue;
      selectionModel = iterative.runSummary.selectModel;
      reviewModel = iterative.runSummary.criticModel;
      originalCandidateCount = iterative.runSummary.seedCandidateCount;

      normalizedCandidates = iterative.shortlist.map((candidate) => {
        const durationAligned = enforceDuration(
          candidate.startMs,
          candidate.endMs,
          durationPreset,
          transcriptMaxEndMs
        );

          return {
            startMs: durationAligned.startMs,
            endMs: durationAligned.endMs,
            scoreTotal: clamp(candidate.scoreTotal, 0, 1),
            scoreText: clamp(candidate.scoreText, 0, 1),
            reason: candidate.reason,
            topic: candidate.topic,
            matchedEmotionContext: candidate.matchedEmotionContext,
            emotionFitScore: candidate.emotionFitScore,
            emotionFitReason: candidate.emotionFitReason,
            emotionFallback: candidate.emotionFallback,
            review: {
              recommendedTitle: candidate.review.recommendedTitle,
              overallScore: candidate.review.overallScore,
              hookScore: candidate.review.hookScore,
              valueScore: candidate.review.valueScore,
              clarityScore: candidate.review.clarityScore,
              emotionScore: candidate.review.emotionScore,
              shareabilityScore: candidate.review.shareabilityScore,
              whyThisWorks: candidate.review.whyThisWorks,
              improvementTip: candidate.review.improvementTip,
              angle: candidate.review.angle,
              matchedEmotionContext: candidate.review.matchedEmotionContext,
              emotionFitScore: candidate.review.emotionFitScore,
              emotionFitReason: candidate.review.emotionFitReason,
              emotionFallback: candidate.review.emotionFallback,
            },
          };

      });

      logger.info("highlight_selection_completed", {
        jobId,
        mode: "iterative",
        runId: pipelineRunId,
        model: selectionModel,
        candidateCount: normalizedCandidates.length,
        clipDurationPreset: durationPreset,
        clipCountTarget,
      });
    }

    logger.info("highlight_candidates_normalized", {
      jobId,
      originalCount: originalCandidateCount,
      clipDurationPreset: durationPreset,
      clipCountTarget,
      normalizedCount: normalizedCandidates.length,
    });
    const existingMetadata = asObject(video.metadata) || {};

    await prisma.$transaction(async (tx) => {
      await tx.highlightCandidate.deleteMany({ where: { videoId } });

      for (const [index, candidate] of normalizedCandidates.entries()) {
        await ((tx.highlightCandidate.create as unknown) as (args: Record<string, unknown>) => Promise<unknown>)({
          data: {
            videoId,
            jobId,
            startMs: candidate.startMs,
            endMs: candidate.endMs,
            scoreTotal: new Prisma.Decimal(candidate.scoreTotal.toFixed(4)),
            scoreText: new Prisma.Decimal(candidate.scoreText.toFixed(4)),
            matchedEmotionContext: candidate.matchedEmotionContext || null,
            emotionFitScore: candidate.emotionFitScore ?? null,
            emotionFitReason: candidate.emotionFitReason || null,
            emotionFallback: candidate.emotionFallback ?? false,
            reasonJson: {
              method: "groq-llm",
              model: selectionModel,
              reason: candidate.reason,
              topic: candidate.topic || null,
              requestedEmotionContext: emotionContext,
              matchedEmotionContext: candidate.matchedEmotionContext || null,
              emotionFitScore: candidate.emotionFitScore ?? null,
              emotionFitReason: candidate.emotionFitReason || null,
              emotionFallback: candidate.emotionFallback ?? false,
              clipDurationPreset: durationPreset,
              clipDurationRangeMs: {
                min: durationConfig.minDurationMs,
                max: durationConfig.maxDurationMs,
              },
              clipCountTarget,
              pipelineMode,
              pipelineVersion,
              pipelineRunId,
              clipReview: {
                model: reviewModel,
                recommendedTitle: candidate.review.recommendedTitle,
                overallScore: candidate.review.overallScore,
                hookScore: candidate.review.hookScore,
                valueScore: candidate.review.valueScore,
                clarityScore: candidate.review.clarityScore,
                emotionScore: candidate.review.emotionScore,
                shareabilityScore: candidate.review.shareabilityScore,
                whyThisWorks: candidate.review.whyThisWorks,
                improvementTip: candidate.review.improvementTip,
                angle: candidate.review.angle || null,
                matchedEmotionContext: candidate.review.matchedEmotionContext || null,
                emotionFitScore: candidate.review.emotionFitScore ?? null,
                emotionFitReason: candidate.review.emotionFitReason || null,
                emotionFallback: candidate.review.emotionFallback ?? false,
              },
            },
            rankOrder: index + 1,
            isSelected: true,
            selectedBy: `auto:${selectionModel}`,
          },
        });
      }

      await tx.video.update({
        where: { id: videoId },
        data: {
          metadata: {
            ...existingMetadata,
            highlightSelection: {
              provider: "groq",
              model: selectionModel,
              reviewModel,
              requestedEmotionContext: emotionContext,
              clipDurationPreset: durationPreset,
              clipDurationRangeMs: {
                min: durationConfig.minDurationMs,
                max: durationConfig.maxDurationMs,
              },
              clipCountTarget,
              pipelineMode,
              pipelineVersion,
              runId: pipelineRunId,
              summary: pipelineSummary,
              selectedCount: normalizedCandidates.length,
              selectedAt: new Date().toISOString(),
            },
          },
        },
      });

      await tx.apiCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      });

      await tx.job.update({
        where: { id: jobId },
        data: {
          status: "success",
          finishedAt: new Date(),
          result: {
            selectedCount: normalizedCandidates.length,
            model: selectionModel,
            reviewModel,
            clipDurationPreset: durationPreset,
            clipCountTarget,
            emotionContext,
            pipelineMode,
            pipelineVersion,
            runId: pipelineRunId,
            summary: pipelineSummary,
          },
        },
      });
    });

    logger.info("highlight_pipeline_completed", {
      jobId,
      videoId,
      selectedCount: normalizedCandidates.length,
      model: selectionModel,
      reviewModel,
      pipelineMode,
      pipelineVersion,
      pipelineRunId,
      clipDurationPreset: durationPreset,
      clipCountTarget,
    });

    void publishPipelineStatusUpdate({
      videoId,
      getPipelineStatus: () => getPipelineStatusByVideoId(prisma, videoId),
    }).catch((publishError) => {
      logger.warn("highlight_pipeline_success_status_publish_failed", {
        videoId,
        jobId,
        message:
          publishError instanceof Error
            ? publishError.message
            : "Failed to publish highlight success status",
      });
    });

    return NextResponse.json({
      ok: true,
      message: "Highlight selection selesai",
        highlights: {
          model: selectionModel,
          clipDurationPreset: durationPreset,
          clipCountTarget,
          emotionContext,
          reviewModel,
          pipelineMode,

        pipelineVersion,
        runId: pipelineRunId,
        candidates: normalizedCandidates,
      },
    });
  } catch (error) {
    if (jobId) {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: "failed",
            finishedAt: new Date(),
            errorMessage: error instanceof Error ? error.message : "Highlight selection gagal",
            lastError: error instanceof Error ? error.message : "Highlight selection gagal",
          },
        });

        void publishPipelineStatusUpdate({
          videoId,
          getPipelineStatus: () => getPipelineStatusByVideoId(prisma, videoId),
        }).catch((publishError) => {
          logger.warn("highlight_pipeline_failed_status_publish_failed", {
            videoId,
            jobId,
            message:
              publishError instanceof Error
                ? publishError.message
                : "Failed to publish highlight failed status",
          });
        });
      } catch (jobUpdateError) {
        logger.error("highlight_pipeline_failed_job_update_failed", {
          videoId,
          jobId,
          originalMessage: error instanceof Error ? error.message : "Highlight selection gagal",
          updateErrorMessage:
            jobUpdateError instanceof Error ? jobUpdateError.message : "Failed to mark job as failed",
          error: jobUpdateError,
        });
      }
    }

    logger.error("highlight_pipeline_failed", {
      videoId,
      jobId,
      message: error instanceof Error ? error.message : "Highlight selection gagal",
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Highlight selection gagal",
      },
      { status: 500 }
    );
  }
}
