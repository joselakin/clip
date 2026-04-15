export type TranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type TranscriptWindow = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  segments: TranscriptSegment[];
};

export type BuildTranscriptWindowsOptions = {
  size: number;
  overlap: number;
};

export type IterationCandidate = {
  startMs: number;
  endMs: number;
  score: number;
  topic: string;
};

export type RankCandidatesOptions = {
  targetCount: number;
  topicPenalty: number;
  overlapPenalty: number;
};

export type StopIterationInput = {
  passCount: number;
  targetCount: number;
  iteration: number;
  maxIterations: number;
  improvedInIteration: boolean;
};

type TemporalSpan = {
  startMs: number;
  endMs: number;
};

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function finiteOr(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function lexicalCompare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function normalizeSpan<T extends TemporalSpan>(span: T): TemporalSpan {
  const startMs = clampNonNegative(span.startMs);
  const endMs = clampNonNegative(span.endMs);
  if (endMs >= startMs) {
    return { startMs, endMs };
  }
  return { startMs: endMs, endMs: startMs };
}

function candidateSort(a: IterationCandidate, b: IterationCandidate): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.startMs !== b.startMs) {
    return a.startMs - b.startMs;
  }
  if (a.endMs !== b.endMs) {
    return a.endMs - b.endMs;
  }
  return lexicalCompare(a.topic, b.topic);
}

export function buildTranscriptWindows(
  segments: TranscriptSegment[],
  options: BuildTranscriptWindowsOptions,
): TranscriptWindow[] {
  const safeSize = Math.max(1, Math.floor(finiteOr(options.size, 1)));
  const safeOverlap = Math.max(0, Math.floor(finiteOr(options.overlap, 0)));
  const step = Math.max(1, safeSize - Math.min(safeOverlap, safeSize - 1));
  const windows: TranscriptWindow[] = [];

  for (let index = 0, start = 0; start < segments.length; index += 1, start += step) {
    const windowSegments = segments.slice(start, start + safeSize);
    if (windowSegments.length === 0) {
      break;
    }

    const first = windowSegments[0];
    const last = windowSegments[windowSegments.length - 1];
    windows.push({
      index,
      startMs: first.startMs,
      endMs: last.endMs,
      text: windowSegments
        .map((segment) => segment.text.trim())
        .filter((text) => text.length > 0)
        .join(" "),
      segments: windowSegments,
    });
  }

  return windows;
}

export function temporalIoU(a: TemporalSpan, b: TemporalSpan): number {
  const left = normalizeSpan(a);
  const right = normalizeSpan(b);

  const intersectionStart = Math.max(left.startMs, right.startMs);
  const intersectionEnd = Math.min(left.endMs, right.endMs);
  const intersection = Math.max(0, intersectionEnd - intersectionStart);

  const unionStart = Math.min(left.startMs, right.startMs);
  const unionEnd = Math.max(left.endMs, right.endMs);
  const union = Math.max(0, unionEnd - unionStart);

  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

export function dedupeCandidatesByIoU(
  candidates: IterationCandidate[],
  iouThreshold: number,
): IterationCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  const safeThreshold = Math.min(1, Math.max(0, finiteOr(iouThreshold, 0)));
  const deduped: IterationCandidate[] = [];

  for (const candidate of [...candidates].sort(candidateSort)) {
    const overlapsExisting = deduped.some((existing) => temporalIoU(existing, candidate) > safeThreshold);
    if (!overlapsExisting) {
      deduped.push(candidate);
    }
  }

  return deduped;
}

export function rankCandidatesWithDiversity(
  candidates: IterationCandidate[],
  options: RankCandidatesOptions,
): IterationCandidate[] {
  const safeTopicPenalty = finiteOr(options.topicPenalty, 0);
  const safeOverlapPenalty = finiteOr(options.overlapPenalty, 0);
  const normalizedTargetCount = finiteOr(options.targetCount, options.targetCount > 0 ? candidates.length : 0);
  const targetCount = Math.max(0, Math.floor(normalizedTargetCount));
  if (targetCount === 0 || candidates.length === 0) {
    return [];
  }

  const available = [...candidates].sort(candidateSort);
  const selected: IterationCandidate[] = [];
  const topicCounts = new Map<string, number>();

  while (selected.length < targetCount && available.length > 0) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < available.length; index += 1) {
      const candidate = available[index];
      const repeats = topicCounts.get(candidate.topic) ?? 0;
      const maxOverlap = selected.reduce((currentMax, selectedCandidate) => {
        return Math.max(currentMax, temporalIoU(candidate, selectedCandidate));
      }, 0);

      const adjustedScore =
        candidate.score - repeats * safeTopicPenalty - maxOverlap * safeOverlapPenalty;

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
        continue;
      }

      if (adjustedScore === bestAdjustedScore) {
        const currentBest = available[bestIndex];
        if (candidateSort(candidate, currentBest) < 0) {
          bestIndex = index;
        }
      }
    }

    const [picked] = available.splice(bestIndex, 1);
    selected.push(picked);
    topicCounts.set(picked.topic, (topicCounts.get(picked.topic) ?? 0) + 1);
  }

  return selected;
}

export function shouldStopIteration(input: StopIterationInput): boolean {
  if (input.passCount >= input.targetCount) {
    return true;
  }

  if (input.iteration >= input.maxIterations) {
    return true;
  }

  if (!input.improvedInIteration) {
    return true;
  }

  return false;
}
