export const CLIP_DURATION_PRESETS = [
  "under_1_minute",
  "one_to_two_minutes",
  "over_2_minutes",
  "mixed",
] as const;

export const CLIP_COUNT_OPTIONS = [5, 6, 10] as const;

export type ClipDurationPreset = (typeof CLIP_DURATION_PRESETS)[number];
export type ClipCountTarget = (typeof CLIP_COUNT_OPTIONS)[number];

export const DEFAULT_CLIP_DURATION_PRESET: ClipDurationPreset = "under_1_minute";
export const DEFAULT_CLIP_COUNT_TARGET: ClipCountTarget = 6;

export type ClipDurationPresetConfig = {
  preset: ClipDurationPreset;
  label: string;
  minDurationMs: number;
  maxDurationMs: number;
  promptRule: string;
  extraPromptRule?: string;
};

const CLIP_DURATION_CONFIGS: Record<ClipDurationPreset, ClipDurationPresetConfig> = {
  under_1_minute: {
    preset: "under_1_minute",
    label: "Di bawah 1 menit",
    minDurationMs: 25_000,
    maxDurationMs: 59_000,
    promptRule: "- Durasi target tiap clip di bawah 1 menit (ideal 30-55 detik)",
  },
  one_to_two_minutes: {
    preset: "one_to_two_minutes",
    label: "1 - 2 menit",
    minDurationMs: 60_000,
    maxDurationMs: 120_000,
    promptRule: "- Durasi target tiap clip sekitar 1-2 menit",
  },
  over_2_minutes: {
    preset: "over_2_minutes",
    label: "Di atas 2 menit",
    minDurationMs: 120_000,
    maxDurationMs: 300_000,
    promptRule: "- Durasi target tiap clip di atas 2 menit, maksimum sekitar 5 menit",
  },
  mixed: {
    preset: "mixed",
    label: "Campur",
    minDurationMs: 25_000,
    maxDurationMs: 300_000,
    promptRule: "- Durasi clip campuran: boleh <1 menit, 1-2 menit, atau >2 menit (maks sekitar 5 menit)",
    extraPromptRule:
      "- Usahakan kandidat tidak semuanya sama panjang; variasikan durasi sesuai kekuatan topik",
  },
};

export function parseClipDurationPreset(
  value: unknown,
  fallback: ClipDurationPreset = DEFAULT_CLIP_DURATION_PRESET
): ClipDurationPreset {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "under_1_minute") {
    return "under_1_minute";
  }
  if (normalized === "one_to_two_minutes") {
    return "one_to_two_minutes";
  }
  if (normalized === "over_2_minutes") {
    return "over_2_minutes";
  }
  if (normalized === "mixed") {
    return "mixed";
  }

  return fallback;
}

export function getClipDurationPresetConfig(preset: ClipDurationPreset): ClipDurationPresetConfig {
  return CLIP_DURATION_CONFIGS[preset];
}

export function parseClipCountTarget(
  value: unknown,
  fallback: ClipCountTarget = DEFAULT_CLIP_COUNT_TARGET
): ClipCountTarget {
  const parsed = Number(value);
  if (parsed === 5 || parsed === 6 || parsed === 10) {
    return parsed;
  }

  return fallback;
}
