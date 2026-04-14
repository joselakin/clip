type Segment = {
  startMs: number;
  endMs: number;
  text: string;
  wordsJson?: unknown;
};

type SubtitleEntry = {
  startMs: number;
  endMs: number;
  karaokeText: string;
};

const MAX_WORDS_PER_ENTRY = 4;
const MAX_ENTRY_DURATION_MS = 2600;
const MAX_GAP_INSIDE_ENTRY_MS = 450;
const MIN_ENTRY_DURATION_MS = 280;
const MAX_LINES_PER_ENTRY = 2;
const MAX_CHARS_PER_LINE = 18;

function pad(num: number, size = 2): string {
  return String(num).padStart(size, "0");
}

export function msToSrtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

function msToAssTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const centis = Math.floor((safe % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

type SubtitleWord = {
  startMs: number;
  endMs: number;
  text: string;
};

type PreparedSegment = {
  startMs: number;
  endMs: number;
  text: string;
  words: SubtitleWord[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => normalizeText(word))
    .filter((word) => word.length > 0);
}

function parseWordsFromJson(wordsJson: unknown, clipStartMs: number, clipEndMs: number): SubtitleWord[] {
  if (!Array.isArray(wordsJson)) {
    return [];
  }

  const words: SubtitleWord[] = [];

  for (const item of wordsJson) {
    const row = asObject(item);
    if (!row) {
      continue;
    }

    const text = normalizeText(typeof row.word === "string" ? row.word : "");
    const startRaw = Number(row.startMs);
    const endRaw = Number(row.endMs);

    if (!text || !Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
      continue;
    }

    const clippedStart = clampMs(startRaw, clipStartMs, clipEndMs) - clipStartMs;
    const clippedEnd = clampMs(endRaw, clipStartMs, clipEndMs) - clipStartMs;
    if (clippedEnd <= clippedStart) {
      continue;
    }

    words.push({
      startMs: clippedStart,
      endMs: clippedEnd,
      text,
    });
  }

  return words;
}

function buildSyntheticWords(text: string, startMs: number, endMs: number): SubtitleWord[] {
  const words = splitWords(text);
  if (words.length === 0) {
    return [];
  }

  const totalDuration = Math.max(200, endMs - startMs);
  const perWord = Math.max(60, Math.floor(totalDuration / words.length));

  return words.map((word, index) => {
    const wordStart = startMs + index * perWord;
    const isLast = index === words.length - 1;
    const wordEnd = isLast ? endMs : Math.min(endMs, wordStart + perWord);
    return {
      startMs: wordStart,
      endMs: Math.max(wordStart + 40, wordEnd),
      text: word,
    };
  });
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ");
}

function isPunctuationToken(token: string): boolean {
  return /^[.,!?;:]+$/.test(token);
}

function toCentiseconds(ms: number): number {
  return Math.max(1, Math.round(ms / 10));
}

function buildKaraokeTextFromWords(
  words: SubtitleWord[],
  entryStartMs: number,
  entryEndMs: number
): string {
  let cursor = entryStartMs;
  let output = "";
  let lineCount = 1;
  let currentLineChars = 0;

  words.forEach((word, wordIndex) => {
    if (word.startMs > cursor) {
      output += `{\\k${toCentiseconds(word.startMs - cursor)}}`;
    }

    const safeWord = escapeAssText(word.text).toUpperCase();
    const nextWordLength = safeWord.length;
    const expectedLineLength = currentLineChars + (currentLineChars > 0 ? 1 : 0) + nextWordLength;

    const shouldBreakLine =
      currentLineChars > 0 &&
      lineCount < MAX_LINES_PER_ENTRY &&
      expectedLineLength > MAX_CHARS_PER_LINE;

    if (shouldBreakLine) {
      output += "\\N";
      lineCount += 1;
      currentLineChars = 0;
    }

    const needsSpace =
      currentLineChars > 0 &&
      !isPunctuationToken(safeWord) &&
      wordIndex > 0;

    if (needsSpace) {
      output += " ";
      currentLineChars += 1;
    }

    const duration = Math.max(40, word.endMs - word.startMs);
    output += `{\\k${toCentiseconds(duration)}}${safeWord}`;
    currentLineChars += nextWordLength;
    cursor = Math.max(cursor, word.endMs);
  });

  if (cursor < entryEndMs) {
    output += `{\\k${toCentiseconds(entryEndMs - cursor)}}`;
  }

  return output;
}

function prepareSegments(
  transcriptSegments: Segment[],
  clipStartMs: number,
  clipEndMs: number
): PreparedSegment[] {
  const prepared: PreparedSegment[] = [];

  for (const segment of transcriptSegments) {
    if (segment.endMs <= clipStartMs || segment.startMs >= clipEndMs) {
      continue;
    }

    const startMs = Math.max(segment.startMs, clipStartMs) - clipStartMs;
    const endMs = Math.min(segment.endMs, clipEndMs) - clipStartMs;

    if (endMs <= startMs) {
      continue;
    }

    const text = normalizeText(segment.text);
    if (!text) {
      continue;
    }

    prepared.push({
      startMs,
      endMs: Math.max(startMs + 200, endMs),
      text,
      words: parseWordsFromJson(segment.wordsJson, clipStartMs, clipEndMs),
    });
  }

  return prepared;
}

function collectTimedWords(segments: PreparedSegment[]): SubtitleWord[] {
  const words: SubtitleWord[] = [];

  for (const segment of segments) {
    const baseWords =
      segment.words.length > 0
        ? [...segment.words].sort((a, b) => a.startMs - b.startMs)
        : buildSyntheticWords(segment.text, segment.startMs, segment.endMs);

    for (const word of baseWords) {
      if (word.endMs <= word.startMs) {
        continue;
      }
      words.push({
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
      });
    }
  }

  return words.sort((a, b) => a.startMs - b.startMs);
}

function groupWordsIntoEntries(words: SubtitleWord[]): SubtitleWord[][] {
  if (words.length === 0) {
    return [];
  }

  const groups: SubtitleWord[][] = [];
  let current: SubtitleWord[] = [];

  for (const word of words) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }

    const first = current[0];
    const last = current[current.length - 1];
    const candidateDuration = Math.max(word.endMs, word.startMs + 40) - first.startMs;
    const gap = Math.max(0, word.startMs - last.endMs);

    const shouldSplit =
      current.length >= MAX_WORDS_PER_ENTRY ||
      candidateDuration > MAX_ENTRY_DURATION_MS ||
      gap > MAX_GAP_INSIDE_ENTRY_MS;

    if (shouldSplit) {
      groups.push(current);
      current = [word];
      continue;
    }

    current.push(word);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function buildAssHeader(): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Montserrat ExtraBold,68,&H00FFFFFF,&H004FD5FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,60,60,150,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ].join("\n");
}

export function buildSubtitleEntriesForClip(
  transcriptSegments: Segment[],
  clipStartMs: number,
  clipEndMs: number
): SubtitleEntry[] {
  const prepared = prepareSegments(transcriptSegments, clipStartMs, clipEndMs);
  const words = collectTimedWords(prepared);
  const groups = groupWordsIntoEntries(words);

  return groups
    .map((groupWords) => {
      if (groupWords.length === 0) {
        return null;
      }

      const startMs = groupWords[0].startMs;
      const endMs = groupWords[groupWords.length - 1].endMs;
      const safeEnd = Math.max(startMs + MIN_ENTRY_DURATION_MS, endMs);

      return {
        startMs,
        endMs: safeEnd,
        karaokeText: buildKaraokeTextFromWords(groupWords, startMs, safeEnd),
      };
    })
    .filter((entry): entry is SubtitleEntry => Boolean(entry));
}

export function buildAss(entries: SubtitleEntry[]): string {
  const header = buildAssHeader();
  const events = entries.map((entry) => {
    return `Dialogue: 0,${msToAssTimestamp(entry.startMs)},${msToAssTimestamp(entry.endMs)},Default,,0,0,0,,${entry.karaokeText}`;
  });

  return `${header}\n${events.join("\n")}\n`;
}

export function buildSrt(entries: SubtitleEntry[]): string {
  return entries
    .map((entry, index) => {
      return [
        String(index + 1),
        `${msToSrtTimestamp(entry.startMs)} --> ${msToSrtTimestamp(entry.endMs)}`,
        entry.karaokeText.replace(/\{\\k\d+\}/g, "").replace(/\\N/g, "\n"),
        "",
      ].join("\n");
    })
    .join("\n");
}
