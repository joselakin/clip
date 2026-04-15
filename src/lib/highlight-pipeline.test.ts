import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createRunMock,
  updateRunMock,
  createManyReviewMock,
  selectWindowMock,
  criticEvaluateMock,
  regenerateMock,
} = vi.hoisted(() => ({
  createRunMock: vi.fn(),
  updateRunMock: vi.fn(),
  createManyReviewMock: vi.fn(),
  selectWindowMock: vi.fn(),
  criticEvaluateMock: vi.fn(),
  regenerateMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    highlightSelectionRun: {
      create: createRunMock,
      update: updateRunMock,
    },
    highlightCandidateReview: {
      createMany: createManyReviewMock,
    },
  },
}));

vi.mock("@/lib/groq", () => ({
  selectHighlightsForWindowWithGroq: selectWindowMock,
  criticEvaluateHighlightsWithGroq: criticEvaluateMock,
  regenerateHighlightsFromFailuresWithGroq: regenerateMock,
}));

import { runIterativeHighlightPipeline } from "@/lib/highlight-pipeline";

describe("runIterativeHighlightPipeline", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createRunMock.mockResolvedValue({ id: "run-1" });
    updateRunMock.mockResolvedValue({});
    createManyReviewMock.mockResolvedValue({ count: 0 });
    process.env.HIGHLIGHT_WINDOW_SEGMENTS = "4";
    process.env.HIGHLIGHT_WINDOW_OVERLAP_SEGMENTS = "1";
    process.env.HIGHLIGHT_MAX_ITERATIONS = "2";
    process.env.HIGHLIGHT_MAX_REGEN_PER_ITERATION = "3";
    process.env.HIGHLIGHT_CRITIC_PASS_SCORE_MIN = "78";
    process.env.HIGHLIGHT_CRITIC_HOOK_SCORE_MIN = "70";
    process.env.HIGHLIGHT_TOPIC_DUPLICATE_PENALTY = "12";
    process.env.HIGHLIGHT_OVERLAP_PENALTY = "20";
  });

  it("runs iterative selection, records reviews, and returns shortlist", async () => {
    const transcript = Array.from({ length: 8 }, (_, index) => ({
      startMs: index * 10_000,
      endMs: index * 10_000 + 9_000,
      text: `segment-${index + 1}`,
    }));

    selectWindowMock
      .mockResolvedValueOnce({
        model: "model-a",
        windowIndex: 0,
        candidates: [
          { startMs: 0, endMs: 30_000, scoreTotal: 0.9, scoreText: 0.88, reason: "A", topic: "hook" },
        ],
      })
      .mockResolvedValueOnce({
        model: "model-a",
        windowIndex: 1,
        candidates: [
          { startMs: 30_000, endMs: 60_000, scoreTotal: 0.83, scoreText: 0.8, reason: "B", topic: "story" },
        ],
      })
      .mockResolvedValue({ model: "model-a", windowIndex: 2, candidates: [] });

    criticEvaluateMock
      .mockResolvedValueOnce({
        model: "critic-a",
        evaluations: [
          {
            startMs: 0,
            endMs: 30_000,
            overallScore: 81,
            hookScore: 79,
            valueScore: 80,
            clarityScore: 78,
            emotionScore: 77,
            noveltyScore: 76,
            shareabilityScore: 80,
            isPass: true,
            failureReasons: [],
            fixGuidance: "",
            topic: "hook",
          },
          {
            startMs: 30_000,
            endMs: 60_000,
            overallScore: 70,
            hookScore: 65,
            valueScore: 70,
            clarityScore: 68,
            emotionScore: 66,
            noveltyScore: 67,
            shareabilityScore: 69,
            isPass: false,
            failureReasons: ["hook"],
            fixGuidance: "better hook",
            topic: "story",
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "critic-a",
        evaluations: [
          {
            startMs: 61_000,
            endMs: 90_000,
            overallScore: 84,
            hookScore: 80,
            valueScore: 82,
            clarityScore: 81,
            emotionScore: 79,
            noveltyScore: 78,
            shareabilityScore: 84,
            isPass: true,
            failureReasons: [],
            fixGuidance: "",
            topic: "story",
          },
        ],
      });

    regenerateMock.mockResolvedValueOnce({
      model: "regen-a",
      candidates: [
        {
          startMs: 61_000,
          endMs: 90_000,
          scoreTotal: 0.86,
          scoreText: 0.84,
          reason: "regen",
          topic: "story",
        },
      ],
    });

    const result = await runIterativeHighlightPipeline({
      videoId: "video-1",
      jobId: "job-1",
      transcriptSegments: transcript,
      apiKey: "test-key",
      clipCountTarget: 2,
      durationPreset: "under_1_minute",
      durationRangeMs: {
        min: 20_000,
        max: 60_000,
      },
    });

    expect(result.shortlist).toHaveLength(2);
    expect(result.runSummary.runId).toBe("run-1");
    expect(result.runSummary.executedIterations).toBe(1);
    expect(result.runSummary.passCount).toBe(2);
    expect(result.runSummary.pipelineVersion).toBe("iterative-v1");
    expect(createManyReviewMock).toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "success" }),
      })
    );
  });

  it("short-circuits with empty shortlist when seed candidates are empty", async () => {
    const transcript = Array.from({ length: 2 }, (_, index) => ({
      startMs: index * 10_000,
      endMs: index * 10_000 + 9_000,
      text: `segment-${index + 1}`,
    }));

    selectWindowMock.mockResolvedValue({
      model: "model-a",
      windowIndex: 0,
      candidates: [],
    });

    const result = await runIterativeHighlightPipeline({
      videoId: "video-1",
      jobId: "job-1",
      transcriptSegments: transcript,
      apiKey: "test-key",
      clipCountTarget: 2,
      durationPreset: "under_1_minute",
      durationRangeMs: {
        min: 20_000,
        max: 60_000,
      },
    });

    expect(result.shortlist).toEqual([]);
    expect(result.runSummary.seedCandidateCount).toBe(0);
    expect(result.runSummary.passCount).toBe(0);
    expect(result.runSummary.failedCount).toBe(0);
    expect(result.runSummary.executedIterations).toBe(0);
    expect(result.runSummary.windowCount).toBe(1);
    expect(criticEvaluateMock).not.toHaveBeenCalled();
    expect(createManyReviewMock).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "success",
          seedCandidateCount: 0,
          passCount: 0,
          failedCount: 0,
        }),
      })
    );
  });

  it("does not call createMany when critic evaluations are empty", async () => {
    const transcript = Array.from({ length: 4 }, (_, index) => ({
      startMs: index * 10_000,
      endMs: index * 10_000 + 9_000,
      text: `segment-${index + 1}`,
    }));

    selectWindowMock.mockResolvedValue({
      model: "model-a",
      windowIndex: 0,
      candidates: [
        { startMs: 0, endMs: 30_000, scoreTotal: 0.9, scoreText: 0.88, reason: "A", topic: "hook" },
      ],
    });

    criticEvaluateMock.mockResolvedValue({
      model: "critic-a",
      evaluations: [],
    });

    const result = await runIterativeHighlightPipeline({
      videoId: "video-1",
      jobId: "job-1",
      transcriptSegments: transcript,
      apiKey: "test-key",
      clipCountTarget: 1,
      durationPreset: "under_1_minute",
      durationRangeMs: {
        min: 20_000,
        max: 60_000,
      },
    });

    expect(result.shortlist).toEqual([]);
    expect(createManyReviewMock).not.toHaveBeenCalled();
  });

  it("throws original pipeline error when failed-run update also fails", async () => {
    const transcript = Array.from({ length: 2 }, (_, index) => ({
      startMs: index * 10_000,
      endMs: index * 10_000 + 9_000,
      text: `segment-${index + 1}`,
    }));

    const originalError = new Error("selection failed");
    selectWindowMock.mockRejectedValueOnce(originalError);
    updateRunMock.mockRejectedValueOnce(new Error("failed to update run"));

    await expect(
      runIterativeHighlightPipeline({
        videoId: "video-1",
        jobId: "job-1",
        transcriptSegments: transcript,
        apiKey: "test-key",
        clipCountTarget: 1,
        durationPreset: "under_1_minute",
        durationRangeMs: {
          min: 20_000,
          max: 60_000,
        },
      })
    ).rejects.toThrow("selection failed");
  });
});
