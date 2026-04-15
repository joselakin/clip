import { describe, expect, it } from "vitest";
import {
  buildTranscriptWindows,
  dedupeCandidatesByIoU,
  rankCandidatesWithDiversity,
  shouldStopIteration,
  type IterationCandidate,
} from "@/lib/highlight-iteration";

describe("buildTranscriptWindows", () => {
  it("splits transcript into overlapped windows", () => {
    const segments = Array.from({ length: 12 }, (_, index) => ({
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      text: `seg-${index + 1}`,
    }));

    const windows = buildTranscriptWindows(segments, { size: 5, overlap: 2 });
    expect(windows).toHaveLength(4);
    expect(windows[0]?.segments).toHaveLength(5);
    expect(windows[1]?.segments[0]?.text).toBe("seg-4");
  });

  it("treats non-finite size and overlap as safe defaults", () => {
    const segments = Array.from({ length: 3 }, (_, index) => ({
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      text: `seg-${index + 1}`,
    }));

    const windows = buildTranscriptWindows(segments, {
      size: Number.NaN,
      overlap: Number.POSITIVE_INFINITY,
    });

    expect(windows).toHaveLength(3);
    expect(windows.every((window) => window.segments.length > 0)).toBe(true);
    expect(windows[0]?.segments[0]?.text).toBe("seg-1");
    expect(windows[1]?.segments[0]?.text).toBe("seg-2");
    expect(windows[2]?.segments[0]?.text).toBe("seg-3");
  });
});

describe("dedupeCandidatesByIoU", () => {
  it("keeps highest score when overlap is high", () => {
    const input: IterationCandidate[] = [
      { startMs: 0, endMs: 30000, score: 88, topic: "A" },
      { startMs: 2000, endMs: 32000, score: 80, topic: "A" },
      { startMs: 45000, endMs: 70000, score: 84, topic: "B" },
    ];

    const deduped = dedupeCandidatesByIoU(input, 0.6);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.score).toBe(88);
  });

  it("keeps non-overlapping candidates when threshold is zero", () => {
    const input: IterationCandidate[] = [
      { startMs: 0, endMs: 30000, score: 88, topic: "A" },
      { startMs: 2000, endMs: 32000, score: 80, topic: "A" },
      { startMs: 45000, endMs: 70000, score: 84, topic: "B" },
    ];

    const deduped = dedupeCandidatesByIoU(input, 0);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((candidate) => candidate.topic)).toEqual(["A", "B"]);
  });
});

describe("rankCandidatesWithDiversity", () => {
  it("penalizes duplicate topic and keeps diverse picks", () => {
    const input: IterationCandidate[] = [
      { startMs: 0, endMs: 20000, score: 91, topic: "hooks" },
      { startMs: 21000, endMs: 41000, score: 90, topic: "hooks" },
      { startMs: 60000, endMs: 82000, score: 86, topic: "story" },
    ];

    const ranked = rankCandidatesWithDiversity(input, {
      targetCount: 2,
      topicPenalty: 12,
      overlapPenalty: 20,
    });
    expect(ranked).toHaveLength(2);
    expect(new Set(ranked.map((item) => item.topic)).size).toBe(2);
  });

  it("normalizes non-finite options to deterministic defaults", () => {
    const input: IterationCandidate[] = [
      { startMs: 0, endMs: 20000, score: 1, topic: "z" },
      { startMs: 0, endMs: 20000, score: 1, topic: "a" },
    ];

    const ranked = rankCandidatesWithDiversity(input, {
      targetCount: Number.POSITIVE_INFINITY,
      topicPenalty: Number.NaN,
      overlapPenalty: Number.NEGATIVE_INFINITY,
    });

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.topic).toBe("a");
    expect(ranked[1]?.topic).toBe("z");
  });
});

describe("shouldStopIteration", () => {
  it("stops when target pass count reached", () => {
    expect(
      shouldStopIteration({
        passCount: 6,
        targetCount: 6,
        iteration: 1,
        maxIterations: 3,
        improvedInIteration: true,
      }),
    ).toBe(true);
  });

  it("stops when max iterations reached", () => {
    expect(
      shouldStopIteration({
        passCount: 3,
        targetCount: 6,
        iteration: 3,
        maxIterations: 3,
        improvedInIteration: true,
      }),
    ).toBe(true);
  });
});
