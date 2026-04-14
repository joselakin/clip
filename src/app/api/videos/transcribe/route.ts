import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { GroqSegment, GroqTranscriptionResponse, GroqWord } from "@/lib/groq";
import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { transcribeAudioWithGroq } from "@/lib/groq";
import { createLogger } from "@/lib/logger";
import { extractAudioForTranscription, splitAudioForTranscription } from "@/lib/media";
import { prisma } from "@/lib/prisma";
import { buildAudioStorageKey, getStorageRootDir, resolveStoragePath } from "@/lib/storage";

export const runtime = "nodejs";
const logger = createLogger("api/videos/transcribe");

function toMs(value?: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 1000);
}

function getMaxGroqTranscribeUploadBytes(): number {
  const configured = Number(process.env.GROQ_TRANSCRIBE_MAX_UPLOAD_BYTES || "");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 24 * 1024 * 1024;
}

function getGroqTranscribeChunkSeconds(): number {
  const configured = Number(process.env.GROQ_TRANSCRIBE_CHUNK_SECONDS || "");
  if (Number.isFinite(configured) && configured >= 30) {
    return Math.floor(configured);
  }
  return 8 * 60;
}

function shiftWordByOffset(word: GroqWord, offsetMs: number): GroqWord {
  return {
    ...word,
    start: typeof word.start === "number" ? Math.max(0, word.start + offsetMs / 1000) : word.start,
    end: typeof word.end === "number" ? Math.max(0, word.end + offsetMs / 1000) : word.end,
  };
}

function shiftSegmentByOffset(segment: GroqSegment, offsetMs: number): GroqSegment {
  return {
    ...segment,
    start: typeof segment.start === "number" ? Math.max(0, segment.start + offsetMs / 1000) : segment.start,
    end: typeof segment.end === "number" ? Math.max(0, segment.end + offsetMs / 1000) : segment.end,
    words: Array.isArray(segment.words)
      ? segment.words.map((word) => shiftWordByOffset(word, offsetMs))
      : segment.words,
  };
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
    logger.info("job_creating", { videoId, ownerRef });
    const job = await prisma.job.create({
      data: {
        videoId,
        jobType: "TRANSCRIBE",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        queuedAt: new Date(),
        startedAt: new Date(),
        sttProvider: "groq",
        sttModel: process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo",
        credentialMode: "user_supplied",
        credentialFingerprint: credential.keyFingerprint,
        credentialId: credential.id,
        payload: {
          source: "dashboard",
          step: "video-to-transcript",
        },
      },
    });

    jobId = job.id;
    logger.info("job_created", { jobId, videoId, storageKey: video.storageKey });

    const inputVideoPath = resolveStoragePath(video.storageKey);
    const audioStorageKey = buildAudioStorageKey(video.id);
    const audioPath = resolveStoragePath(audioStorageKey);

    logger.info("audio_extraction_started", { inputVideoPath, audioStorageKey });
    await extractAudioForTranscription(inputVideoPath, audioPath);
    logger.info("audio_extraction_completed", { audioPath });

    const apiKey = decryptSecret(credential.encryptedApiKey);
    logger.info("groq_transcription_started", {
      jobId,
      model: process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo",
    });
    const maxUploadBytes = getMaxGroqTranscribeUploadBytes();
    const chunkSeconds = getGroqTranscribeChunkSeconds();
    const audioStat = await stat(audioPath);

    const transcriptionParts: Array<{ offsetMs: number; result: GroqTranscriptionResponse }> = [];
    let model = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";

    if (audioStat.size <= maxUploadBytes) {
      const single = await transcribeAudioWithGroq(audioPath, apiKey);
      model = single.model;
      transcriptionParts.push({ offsetMs: 0, result: single.result });
      logger.info("groq_transcription_single_request", {
        jobId,
        model,
        audioBytes: audioStat.size,
      });
    } else {
      const chunksDir = path.join(
        getStorageRootDir(),
        "audio",
        `${video.id}-chunks-${Date.now()}`
      );

      const chunks = await splitAudioForTranscription(audioPath, chunksDir, chunkSeconds);
      if (chunks.length === 0) {
        throw new Error("Gagal membagi audio untuk transkripsi chunk.");
      }

      logger.info("groq_transcription_chunk_mode", {
        jobId,
        model,
        audioBytes: audioStat.size,
        maxUploadBytes,
        chunkSeconds,
        chunks: chunks.length,
      });

      for (const chunk of chunks) {
        const chunkResult = await transcribeAudioWithGroq(chunk.path, apiKey);
        model = chunkResult.model;
        transcriptionParts.push({
          offsetMs: chunk.startMs,
          result: chunkResult.result,
        });
      }
    }

    const rawSegments = transcriptionParts.flatMap((part) => {
      const base = part.result.segments || [];
      return base.map((segment) => shiftSegmentByOffset(segment, part.offsetMs));
    });

    const mergedLanguage =
      transcriptionParts
        .map((part) => part.result.language)
        .find((language) => typeof language === "string" && language.trim().length > 0) || null;

    const mergedText = transcriptionParts
      .map((part) => (part.result.text || "").trim())
      .filter((text) => text.length > 0)
      .join(" ")
      .trim();

    logger.info("groq_transcription_completed", {
      jobId,
      model,
      segments: rawSegments.length,
      language: mergedLanguage,
      chunkRequests: transcriptionParts.length,
    });

    const preparedSegments = rawSegments
      .map((segment) => {
        const startMs = toMs(segment.start);
        const safeEndMs = toMs(segment.end);
        const endMs = safeEndMs > startMs ? safeEndMs : startMs + 1;

        return {
          videoId,
          jobId,
          startMs,
          endMs,
          text: (segment.text || "").trim() || "[no text]",
          language: mergedLanguage,
          confidence: typeof segment.avg_logprob === "number" ? segment.avg_logprob : null,
          speakerLabel: null,
          sttProvider: "groq" as const,
          sttModel: model,
          wordsJson: (segment.words || []).map((word) => ({
            word: word.word,
            startMs: toMs(word.start),
            endMs: toMs(word.end),
          })),
          segmentRaw: segment as Prisma.InputJsonValue,
        };
      })
      .filter((segment) => segment.text.length > 0);

    const fallbackSegments =
      preparedSegments.length > 0
        ? preparedSegments
        : [
            {
              videoId,
              jobId,
              startMs: 0,
              endMs: Math.max(1, Math.min(video.durationMs, 2000)),
              text: mergedText || "[no transcript text]",
              language: mergedLanguage,
              confidence: null,
              speakerLabel: null,
              sttProvider: "groq" as const,
              sttModel: model,
              wordsJson: [],
              segmentRaw: {
                fallback: true,
                text: mergedText || null,
              } as Prisma.InputJsonValue,
            },
          ];

    logger.info("transcript_segments_prepared", {
      jobId,
      preparedCount: preparedSegments.length,
      finalCount: fallbackSegments.length,
    });

    const oldMetadata =
      typeof video.metadata === "object" && video.metadata && !Array.isArray(video.metadata)
        ? (video.metadata as Record<string, unknown>)
        : {};

    await prisma.$transaction(async (tx) => {
      await tx.transcriptSegment.deleteMany({ where: { videoId } });

      for (const segment of fallbackSegments) {
        await tx.transcriptSegment.create({ data: segment });
      }

      await tx.video.update({
        where: { id: videoId },
        data: {
          metadata: {
            ...oldMetadata,
            transcript: {
              provider: "groq",
              model,
              segmentsCount: fallbackSegments.length,
              transcribedAt: new Date().toISOString(),
              audioStorageKey,
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
            segmentsCount: fallbackSegments.length,
            audioStorageKey,
            fullText: mergedText || null,
          },
        },
      });
    });

    logger.info("transcription_pipeline_completed", {
      jobId,
      videoId,
      segmentsCount: fallbackSegments.length,
      model,
    });

    return NextResponse.json({
      ok: true,
      message: "Transkripsi selesai",
      transcript: {
        model,
        segmentsCount: fallbackSegments.length,
        textPreview: mergedText.slice(0, 160),
        segments: fallbackSegments.slice(0, 12).map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })),
      },
    });
  } catch (error) {
    if (jobId) {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : "Transkripsi gagal",
          lastError: error instanceof Error ? error.message : "Transkripsi gagal",
        },
      });
    }

    logger.error("transcription_pipeline_failed", {
      videoId,
      jobId,
      message: error instanceof Error ? error.message : "Transkripsi gagal",
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Transkripsi gagal",
      },
      { status: 500 }
    );
  }
}
