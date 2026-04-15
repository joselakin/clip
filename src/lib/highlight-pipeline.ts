import { prisma } from "@/lib/prisma";
import {
  criticEvaluateHighlightsWithGroq,
  regenerateHighlightsFromFailuresWithGroq,
  selectHighlightsForWindowWithGroq,
  type GroqHighlightCandidate,
  type HighlightCriticEvaluation,
  type TranscriptForSelection,
} from "@/lib/groq";
import {
  buildTranscriptWindows,
  dedupeCandidatesByIoU,
  rankCandidatesWithDiversity,
  shouldStopIteration,
  type IterationCandidate,
} from "@/lib/highlight-iteration";

const PIPELINE_VERSION = "iterative-v1";
const DEDUPE_IOU_THRESHOLD = 0.65;

type HighlightSelectionRunDelegate = {
  create: (args: {
    data: Record<string, unknown>;
    select: { id: true };
  }) => Promise<{ id: string }>;
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
};

type HighlightCandidateReviewDelegate = {
  createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
};

type PrismaHighlightAuditClient = {
  highlightSelectionRun: HighlightSelectionRunDelegate;
  highlightCandidateReview: HighlightCandidateReviewDelegate;
};

function hasIterativeAuditDelegates(client: unknown): client is PrismaHighlightAuditClient {
  return Boolean(
    (client as {
      highlightSelectionRun?: { create?: unknown; update?: unknown };
      highlightCandidateReview?: { createMany?: unknown };
    }).highlightSelectionRun?.create &&
      (client as {
        highlightSelectionRun?: { create?: unknown; update?: unknown };
        highlightCandidateReview?: { createMany?: unknown };
      }).highlightSelectionRun?.update &&
      (client as {
        highlightSelectionRun?: { create?: unknown; update?: unknown };
        highlightCandidateReview?: { createMany?: unknown };
      }).highlightCandidateReview?.createMany
  );
}

function getAuditPrismaOrThrow() {
  if (!hasIterativeAuditDelegates(prisma)) {
    throw new Error(
      "Prisma client belum memuat delegate highlight_selection_runs/highlight_candidate_reviews. Jalankan `npm run prisma:generate` lalu restart dev server."
    );
  }
  return prisma as unknown as PrismaHighlightAuditClient;
}

function parseIntFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseFloatFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

function candidateKey(startMs: number, endMs: number): string {
  return `${Math.round(startMs)}-${Math.round(endMs)}`;
}

function toIterationCandidate(candidate: GroqHighlightCandidate): IterationCandidate {
  return {
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    score: candidate.scoreTotal * 100,
    topic: candidate.topic || "general",
  };
}

type ReviewPayload = {
  startMs: number;
  endMs: number;
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

export type PipelineShortlistCandidate = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
  review: ReviewPayload;
};

type PipelineKnobs = {
  windowSegments: number;
  windowOverlapSegments: number;
  maxIterations: number;
  maxRegenPerIteration: number;
  criticPassScoreMin: number;
  criticHookScoreMin: number;
  topicDuplicatePenalty: number;
  overlapPenalty: number;
};

export type IterativePipelineInput = {
  videoId: string;
  jobId: string;
  transcriptSegments: TranscriptForSelection[];
  apiKey: string;
  clipCountTarget: number;
  durationPreset: string;
  durationRangeMs: {
    min: number;
    max: number;
  };
};

export type IterativePipelineRunSummary = {
  runId: string;
  pipelineVersion: string;
  pipelineMode: "iterative";
  selectModel: string;
  criticModel: string;
  regenerateModel: string;
  windowCount: number;
  seedCandidateCount: number;
  passCount: number;
  failedCount: number;
  degradedQualityFill: boolean;
  executedIterations: number;
  knobs: PipelineKnobs;
};

export type IterativePipelineOutput = {
  shortlist: PipelineShortlistCandidate[];
  runSummary: IterativePipelineRunSummary;
};

function loadKnobs(): PipelineKnobs {
  return {
    windowSegments: parseIntFromEnv("HIGHLIGHT_WINDOW_SEGMENTS", 48, 8, 240),
    windowOverlapSegments: parseIntFromEnv("HIGHLIGHT_WINDOW_OVERLAP_SEGMENTS", 8, 0, 120),
    maxIterations: parseIntFromEnv("HIGHLIGHT_MAX_ITERATIONS", 3, 1, 8),
    maxRegenPerIteration: parseIntFromEnv("HIGHLIGHT_MAX_REGEN_PER_ITERATION", 12, 1, 32),
    criticPassScoreMin: parseIntFromEnv("HIGHLIGHT_CRITIC_PASS_SCORE_MIN", 78, 1, 100),
    criticHookScoreMin: parseIntFromEnv("HIGHLIGHT_CRITIC_HOOK_SCORE_MIN", 70, 1, 100),
    topicDuplicatePenalty: parseFloatFromEnv("HIGHLIGHT_TOPIC_DUPLICATE_PENALTY", 12, 0, 100),
    overlapPenalty: parseFloatFromEnv("HIGHLIGHT_OVERLAP_PENALTY", 20, 0, 100),
  };
}

function strictPass(evaluation: HighlightCriticEvaluation, knobs: PipelineKnobs): boolean {
  return evaluation.isPass && evaluation.overallScore >= knobs.criticPassScoreMin && evaluation.hookScore >= knobs.criticHookScoreMin;
}

export async function runIterativeHighlightPipeline(
  input: IterativePipelineInput
): Promise<IterativePipelineOutput> {
  const auditPrisma = getAuditPrismaOrThrow();
  const startedAt = Date.now();
  const knobs = loadKnobs();
  const durationRule = `- Durasi target tiap clip ${Math.round(input.durationRangeMs.min / 1000)}-${Math.round(
    input.durationRangeMs.max / 1000
  )} detik`;

  const run = await auditPrisma.highlightSelectionRun.create({
    data: {
      videoId: input.videoId,
      jobId: input.jobId,
      pipelineVersion: PIPELINE_VERSION,
      pipelineMode: "iterative",
      status: "running",
      clipCountTarget: input.clipCountTarget,
      durationPreset: input.durationPreset,
      maxIterations: knobs.maxIterations,
      tokenUsageJson: {},
      notesJson: {
        knobs,
      },
    },
    select: { id: true },
  });

  let selectModel = "unknown";
  let criticModel = "unknown";
  let regenerateModel = "none";
  let executedIterations = 0;

  try {
    const windows = buildTranscriptWindows(input.transcriptSegments, {
      size: knobs.windowSegments,
      overlap: knobs.windowOverlapSegments,
    });

    const allSeedCandidates: GroqHighlightCandidate[] = [];
    for (const window of windows) {
      const selected = await selectHighlightsForWindowWithGroq(
        {
          index: window.index,
          startMs: window.startMs,
          endMs: window.endMs,
          segments: window.segments,
        },
        input.apiKey,
        {
          maxCandidates: input.clipCountTarget,
          durationRule,
        }
      );
      selectModel = selected.model;
      allSeedCandidates.push(...selected.candidates);
    }

    const seedCap = Math.max(input.clipCountTarget * 4, input.clipCountTarget + knobs.maxRegenPerIteration);
    const dedupedSeeds = dedupeCandidatesByIoU(
      allSeedCandidates.map(toIterationCandidate),
      DEDUPE_IOU_THRESHOLD
    )
      .slice(0, seedCap)
      .map((row) => {
        const found = allSeedCandidates.find(
          (candidate) => candidate.startMs === row.startMs && candidate.endMs === row.endMs
        );
        return (
          found || {
            startMs: row.startMs,
            endMs: row.endMs,
            scoreTotal: Math.max(0.01, Math.min(0.99, row.score / 100)),
            scoreText: Math.max(0.01, Math.min(0.99, row.score / 100)),
            reason: "Seed candidate",
            topic: row.topic,
          }
        );
      });

    if (dedupedSeeds.length === 0) {
      const latencyMs = Math.max(1, Date.now() - startedAt);
      await auditPrisma.highlightSelectionRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          executedIterations,
          seedCandidateCount: 0,
          passCount: 0,
          failedCount: 0,
          degradedQualityFill: false,
          notesJson: {
            knobs,
            selectModel,
            criticModel,
            regenerateModel,
            windowCount: windows.length,
          },
          latencyMs,
          finishedAt: new Date(),
        },
      });

      return {
        shortlist: [],
        runSummary: {
          runId: run.id,
          pipelineVersion: PIPELINE_VERSION,
          pipelineMode: "iterative",
          selectModel,
          criticModel,
          regenerateModel,
          windowCount: windows.length,
          seedCandidateCount: 0,
          passCount: 0,
          failedCount: 0,
          degradedQualityFill: false,
          executedIterations,
          knobs,
        },
      };
    }

    const candidateByKey = new Map<string, GroqHighlightCandidate>();
    const passEvaluations = new Map<string, HighlightCriticEvaluation>();
    const failedEvaluations = new Map<string, HighlightCriticEvaluation>();

    for (const candidate of dedupedSeeds) {
      candidateByKey.set(candidateKey(candidate.startMs, candidate.endMs), candidate);
    }

    const seedCritic = await criticEvaluateHighlightsWithGroq(
      input.transcriptSegments,
      dedupedSeeds,
      input.apiKey,
      {
        passThreshold: knobs.criticPassScoreMin,
      }
    );
    criticModel = seedCritic.model;

    const seedReviewRows = seedCritic.evaluations.map((evaluation: HighlightCriticEvaluation) => ({
      runId: run.id,
      iteration: 0,
      action: "critic_seed",
      startMs: evaluation.startMs,
      endMs: evaluation.endMs,
      topic: evaluation.topic || null,
      overallScore: evaluation.overallScore,
      hookScore: evaluation.hookScore,
      valueScore: evaluation.valueScore,
      clarityScore: evaluation.clarityScore,
      emotionScore: evaluation.emotionScore,
      noveltyScore: evaluation.noveltyScore,
      shareabilityScore: evaluation.shareabilityScore,
      isPass: strictPass(evaluation, knobs),
      failureReasonsJson: evaluation.failureReasons,
      fixGuidance: evaluation.fixGuidance,
      modelName: seedCritic.model,
      rawJson: evaluation,
    }));
    if (seedReviewRows.length > 0) {
      await auditPrisma.highlightCandidateReview.createMany({
        data: seedReviewRows,
      });
    }

    for (const evaluation of seedCritic.evaluations) {
      const key = candidateKey(evaluation.startMs, evaluation.endMs);
      if (strictPass(evaluation, knobs)) {
        passEvaluations.set(key, evaluation);
      } else {
        failedEvaluations.set(key, evaluation);
      }
    }

    let latestFailures = [...failedEvaluations.values()];
    let iteration = 1;
    while (
      !shouldStopIteration({
        passCount: passEvaluations.size,
        targetCount: input.clipCountTarget,
        iteration,
        maxIterations: knobs.maxIterations,
        improvedInIteration: true,
      })
    ) {
      if (latestFailures.length === 0) {
        break;
      }

      const regen = await regenerateHighlightsFromFailuresWithGroq(
        input.transcriptSegments,
        latestFailures.slice(0, knobs.maxRegenPerIteration),
        input.apiKey
      );
      regenerateModel = regen.model;
      executedIterations = iteration;

      const dedupedRegen = dedupeCandidatesByIoU(
        regen.candidates.map(toIterationCandidate),
        DEDUPE_IOU_THRESHOLD
      ).map((row) => ({
        startMs: row.startMs,
        endMs: row.endMs,
        scoreTotal: Math.max(0.01, Math.min(0.99, row.score / 100)),
        scoreText: Math.max(0.01, Math.min(0.99, row.score / 100)),
        reason: `Regenerated candidate (iteration ${iteration})`,
        topic: row.topic,
      }));

      if (dedupedRegen.length === 0) {
        break;
      }

      for (const candidate of dedupedRegen) {
        candidateByKey.set(candidateKey(candidate.startMs, candidate.endMs), candidate);
      }

      const regenCritic = await criticEvaluateHighlightsWithGroq(
        input.transcriptSegments,
        dedupedRegen,
        input.apiKey,
        {
          passThreshold: knobs.criticPassScoreMin,
        }
      );
      criticModel = regenCritic.model;

      const regenReviewRows = regenCritic.evaluations.map((evaluation: HighlightCriticEvaluation) => ({
        runId: run.id,
        iteration,
        action: "critic_regen",
        startMs: evaluation.startMs,
        endMs: evaluation.endMs,
        topic: evaluation.topic || null,
        overallScore: evaluation.overallScore,
        hookScore: evaluation.hookScore,
        valueScore: evaluation.valueScore,
        clarityScore: evaluation.clarityScore,
        emotionScore: evaluation.emotionScore,
        noveltyScore: evaluation.noveltyScore,
        shareabilityScore: evaluation.shareabilityScore,
        isPass: strictPass(evaluation, knobs),
        failureReasonsJson: evaluation.failureReasons,
        fixGuidance: evaluation.fixGuidance,
        modelName: regenCritic.model,
        rawJson: evaluation,
      }));
      if (regenReviewRows.length > 0) {
        await auditPrisma.highlightCandidateReview.createMany({
          data: regenReviewRows,
        });
      }

      const passCountBefore = passEvaluations.size;
      latestFailures = [];

      for (const evaluation of regenCritic.evaluations) {
        const key = candidateKey(evaluation.startMs, evaluation.endMs);
        if (strictPass(evaluation, knobs)) {
          passEvaluations.set(key, evaluation);
          failedEvaluations.delete(key);
        } else {
          failedEvaluations.set(key, evaluation);
          latestFailures.push(evaluation);
        }
      }

      if (passEvaluations.size <= passCountBefore) {
        break;
      }

      iteration += 1;
    }

    const passCandidates = [...passEvaluations.entries()].map(([key, evaluation]) => {
      const candidate = candidateByKey.get(key);
      return {
        startMs: evaluation.startMs,
        endMs: evaluation.endMs,
        topic: evaluation.topic || candidate?.topic || "general",
        score: evaluation.overallScore,
      };
    });

    const rankedPass = rankCandidatesWithDiversity(passCandidates, {
      targetCount: input.clipCountTarget,
      topicPenalty: knobs.topicDuplicatePenalty,
      overlapPenalty: knobs.overlapPenalty,
    });

    let degradedQualityFill = false;
    const rankedFailed = [...failedEvaluations.values()]
      .sort((left, right) => right.overallScore - left.overallScore)
      .map((evaluation) => ({
        startMs: evaluation.startMs,
        endMs: evaluation.endMs,
        topic: evaluation.topic || "general",
        score: evaluation.overallScore,
      }));

    const finalRanked = [...rankedPass];
    if (finalRanked.length < input.clipCountTarget && rankedFailed.length > 0) {
      degradedQualityFill = true;
      const needed = input.clipCountTarget - finalRanked.length;
      finalRanked.push(...rankedFailed.slice(0, needed));
    }

    const shortlist = finalRanked.slice(0, input.clipCountTarget).map((ranked, index) => {
      const key = candidateKey(ranked.startMs, ranked.endMs);
      const candidate = candidateByKey.get(key);
      const evaluation = passEvaluations.get(key) || failedEvaluations.get(key);
      const overallScore = evaluation?.overallScore || Math.round((candidate?.scoreTotal || 0.7) * 100);
      const hookScore = evaluation?.hookScore || overallScore;
      const valueScore = evaluation?.valueScore || overallScore;
      const clarityScore = evaluation?.clarityScore || overallScore;
      const emotionScore = evaluation?.emotionScore || 72;
      const shareabilityScore = evaluation?.shareabilityScore || overallScore;

      return {
        startMs: ranked.startMs,
        endMs: ranked.endMs,
        scoreTotal: Math.max(0.01, Math.min(1, overallScore / 100)),
        scoreText: Math.max(0.01, Math.min(1, valueScore / 100)),
        reason: candidate?.reason || `Ranked highlight ${index + 1}`,
        topic: candidate?.topic || ranked.topic,
        review: {
          startMs: ranked.startMs,
          endMs: ranked.endMs,
          recommendedTitle: `Momen ${index + 1} yang paling bikin penasaran`,
          overallScore,
          hookScore,
          valueScore,
          clarityScore,
          emotionScore,
          shareabilityScore,
          whyThisWorks: candidate?.reason || "Clip ini punya nilai yang jelas untuk audiens.",
          improvementTip:
            evaluation?.fixGuidance || "Perkuat 2 detik pertama dengan hook yang lebih tegas.",
          angle: candidate?.topic || ranked.topic,
        },
      };
    });

    const failedCount = Math.max(0, failedEvaluations.size);
    const latencyMs = Math.max(1, Date.now() - startedAt);

    await auditPrisma.highlightSelectionRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        executedIterations,
        seedCandidateCount: dedupedSeeds.length,
        passCount: passEvaluations.size,
        failedCount,
        degradedQualityFill,
        notesJson: {
          knobs,
          selectModel,
          criticModel,
          regenerateModel,
          windowCount: windows.length,
        },
        latencyMs,
        finishedAt: new Date(),
      },
    });

    return {
      shortlist,
      runSummary: {
        runId: run.id,
        pipelineVersion: PIPELINE_VERSION,
        pipelineMode: "iterative",
        selectModel,
        criticModel,
        regenerateModel,
        windowCount: windows.length,
        seedCandidateCount: dedupedSeeds.length,
        passCount: passEvaluations.size,
        failedCount,
        degradedQualityFill,
        executedIterations,
        knobs,
      },
    };
  } catch (error) {
    try {
      await auditPrisma.highlightSelectionRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Iterative pipeline failed",
          latencyMs: Math.max(1, Date.now() - startedAt),
          finishedAt: new Date(),
        },
      });
    } catch {
      // Preserve the original pipeline error when failure-state persistence fails.
    }
    throw error;
  }
}
