import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { evaluateClipRecommendationsWithGroq, selectHighlightsWithGroq } from "@/lib/groq";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
const logger = createLogger("api/videos/highlights/select");

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function enforceDuration(startMs: number, endMs: number): { startMs: number; endMs: number } {
  const minDuration = 20_000;
  const maxDuration = 45_000;

  let start = Math.max(0, Math.round(startMs));
  let end = Math.max(start + 1, Math.round(endMs));
  const duration = end - start;

  if (duration < minDuration) {
    end = start + minDuration;
  } else if (duration > maxDuration) {
    end = start + maxDuration;
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
};

type NormalizedCandidate = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
  review: ClipEvaluationReview;
};

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
        },
      },
    });

    jobId = job.id;
    logger.info("job_created", { jobId, videoId });

    const apiKey = decryptSecret(credential.encryptedApiKey);
    logger.info("highlight_selection_started", {
      jobId,
      model: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
    });
    const selection = await selectHighlightsWithGroq(transcriptSegments, apiKey);
    logger.info("highlight_selection_completed", {
      jobId,
      model: selection.model,
      candidateCount: selection.candidates.length,
    });

    const baseCandidates = selection.candidates.slice(0, 6).map((candidate) => {
      const durationAligned = enforceDuration(candidate.startMs, candidate.endMs);
      return {
        ...candidate,
        ...durationAligned,
        scoreTotal: clamp(candidate.scoreTotal, 0, 1),
        scoreText: clamp(candidate.scoreText, 0, 1),
      };
    });

    logger.info("clip_evaluation_started", {
      jobId,
      model: process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "gpt-oss-120b",
      candidateCount: baseCandidates.length,
    });
    const evaluation = await evaluateClipRecommendationsWithGroq(
      transcriptSegments,
      baseCandidates,
      apiKey
    );

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
      });
    }

    const normalizedCandidates: NormalizedCandidate[] = baseCandidates.map((candidate) => {
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
        };

      return {
        ...candidate,
        review,
      };
    });

    logger.info("clip_evaluation_completed", {
      jobId,
      model: evaluation.model,
      evaluations: evaluation.evaluations.length,
    });

    logger.info("highlight_candidates_normalized", {
      jobId,
      originalCount: selection.candidates.length,
      normalizedCount: normalizedCandidates.length,
    });

    const oldMetadata = await prisma.video.findUnique({ where: { id: videoId }, select: { metadata: true } });
    const existingMetadata =
      oldMetadata &&
      typeof oldMetadata.metadata === "object" &&
      oldMetadata.metadata &&
      !Array.isArray(oldMetadata.metadata)
        ? (oldMetadata.metadata as Record<string, unknown>)
        : {};

    await prisma.$transaction(async (tx) => {
      await tx.highlightCandidate.deleteMany({ where: { videoId } });

      for (const [index, candidate] of normalizedCandidates.entries()) {
        await tx.highlightCandidate.create({
          data: {
            videoId,
            jobId,
            startMs: candidate.startMs,
            endMs: candidate.endMs,
            scoreTotal: new Prisma.Decimal(candidate.scoreTotal.toFixed(4)),
            scoreText: new Prisma.Decimal(candidate.scoreText.toFixed(4)),
            reasonJson: {
              method: "groq-llm",
              model: selection.model,
              reason: candidate.reason,
              topic: candidate.topic || null,
              clipReview: {
                model: evaluation.model,
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
              },
            },
            rankOrder: index + 1,
            isSelected: true,
            selectedBy: `auto:${selection.model}`,
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
              model: selection.model,
              reviewModel: evaluation.model,
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
            model: selection.model,
            reviewModel: evaluation.model,
          },
        },
      });
    });

    logger.info("highlight_pipeline_completed", {
      jobId,
      videoId,
      selectedCount: normalizedCandidates.length,
      model: selection.model,
    });

    return NextResponse.json({
      ok: true,
      message: "Highlight selection selesai",
      highlights: {
        model: selection.model,
        reviewModel: evaluation.model,
        candidates: normalizedCandidates,
      },
    });
  } catch (error) {
    if (jobId) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : "Highlight selection gagal",
          lastError: error instanceof Error ? error.message : "Highlight selection gagal",
        },
      });
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
