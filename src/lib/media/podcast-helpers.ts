type CropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PodcastSwitchSegment = {
  startMs: number;
  endMs: number;
  speaker: "SPEAKER_1" | "SPEAKER_2";
};

function clampToRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toEven(value: number, min = 2): number {
  const rounded = Math.max(min, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function computePodcastCropRect(
  inputWidth: number,
  inputHeight: number,
  focus: "left" | "right",
  targetWidth = 1080,
  targetHeight = 1920
): CropRect {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = inputWidth / inputHeight;

  if (sourceRatio >= targetRatio) {
    const cropH = toEven(inputHeight);
    const cropW = clampToRange(toEven(cropH * targetRatio), 2, toEven(inputWidth));
    const centerX = focus === "left" ? inputWidth * 0.34 : inputWidth * 0.66;
    const cropX = clampToRange(Math.round(centerX - cropW / 2), 0, Math.max(0, inputWidth - cropW));

    return {
      x: cropX,
      y: 0,
      w: cropW,
      h: cropH,
    };
  }

  const cropW = toEven(inputWidth);
  const cropH = clampToRange(toEven(cropW / targetRatio), 2, toEven(inputHeight));
  const centerY = inputHeight / 2;
  const cropY = clampToRange(Math.round(centerY - cropH / 2), 0, Math.max(0, inputHeight - cropH));

  return {
    x: 0,
    y: cropY,
    w: cropW,
    h: cropH,
  };
}

export function normalizePodcastTurns(
  turns: PodcastSwitchSegment[],
  clipStartMs: number,
  clipEndMs: number
): PodcastSwitchSegment[] {
  if (turns.length === 0 || clipEndMs <= clipStartMs) {
    return [];
  }

  const prepared = turns
    .filter((turn) => turn.endMs > clipStartMs && turn.startMs < clipEndMs)
    .map((turn) => ({
      speaker: turn.speaker,
      startMs: Math.max(clipStartMs, Math.round(turn.startMs)),
      endMs: Math.min(clipEndMs, Math.round(turn.endMs)),
    }))
    .filter((turn) => turn.endMs > turn.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (prepared.length === 0) {
    return [];
  }

  const merged: PodcastSwitchSegment[] = [];

  for (const turn of prepared) {
    if (merged.length === 0) {
      merged.push({ ...turn });
      continue;
    }

    const prev = merged[merged.length - 1];
    if (turn.speaker === prev.speaker && turn.startMs <= prev.endMs + 120) {
      prev.endMs = Math.max(prev.endMs, turn.endMs);
      continue;
    }

    if (turn.startMs < prev.endMs) {
      turn.startMs = prev.endMs;
      if (turn.endMs <= turn.startMs) {
        continue;
      }
    }

    merged.push({ ...turn });
  }

  const minShotMs = 900;
  const smoothed: PodcastSwitchSegment[] = [];

  for (const turn of merged) {
    if (smoothed.length === 0) {
      smoothed.push({ ...turn });
      continue;
    }

    const prev = smoothed[smoothed.length - 1];
    const duration = turn.endMs - turn.startMs;

    if (duration < minShotMs && turn.speaker !== prev.speaker) {
      prev.endMs = Math.max(prev.endMs, turn.endMs);
      continue;
    }

    if (turn.speaker === prev.speaker || turn.startMs <= prev.endMs + 120) {
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

  return smoothed
    .filter((turn) => turn.endMs > turn.startMs)
    .map((turn) => ({
      speaker: turn.speaker,
      startMs: Math.max(clipStartMs, turn.startMs),
      endMs: Math.min(clipEndMs, turn.endMs),
    }));
}

export function buildConcatList(rows: string[]): string {
  return rows.map((row) => `file '${row.replace(/'/g, "'\\''")}'`).join("\n");
}
