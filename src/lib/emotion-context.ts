export const EMOTION_CONTEXT_VALUES = [
  "general",
  "sadness",
  "anger",
  "tenderness",
  "anxiety",
  "joy",
  "nostalgia",
  "motivation",
  "disappointment",
] as const;

export type EmotionContext = (typeof EMOTION_CONTEXT_VALUES)[number];

const EMOTION_CONTEXT_CONFIG: Record<
  EmotionContext,
  {
    label: string;
    promptGuidance: string;
  }
> = {
  general: {
    label: "General",
    promptGuidance:
      "Prioritize clips with a broad emotional range, clear payoff, and strong audience resonance without narrowing to a single mood.",
  },
  sadness: {
    label: "Sadness",
    promptGuidance:
      "Prioritize clips that carry sadness, vulnerability, grief, or heartfelt emotional weight with sincerity and clarity.",
  },
  anger: {
    label: "Anger",
    promptGuidance:
      "Prioritize clips with anger, frustration, confrontation, or sharp emotional intensity that still feels coherent and compelling.",
  },
  tenderness: {
    label: "Tenderness",
    promptGuidance:
      "Prioritize clips with tenderness, warmth, care, affection, or gentle emotional connection.",
  },
  anxiety: {
    label: "Anxiety",
    promptGuidance:
      "Prioritize clips with anxiety, tension, nervous anticipation, or emotional unease that creates strong audience curiosity.",
  },
  joy: {
    label: "Joy",
    promptGuidance:
      "Prioritize clips with joy, delight, humor, celebration, or uplifting emotional energy.",
  },
  nostalgia: {
    label: "Nostalgia",
    promptGuidance:
      "Prioritize clips that evoke nostalgia, reflection, memory, or longing for the past in a vivid and relatable way.",
  },
  motivation: {
    label: "Motivation",
    promptGuidance:
      "Prioritize clips with motivation, encouragement, determination, or empowering momentum that pushes the audience forward.",
  },
  disappointment: {
    label: "Disappointment",
    promptGuidance:
      "Prioritize clips with disappointment, disillusionment, regret, or unmet expectations expressed clearly and meaningfully.",
  },
};

export const DEFAULT_EMOTION_CONTEXT: EmotionContext = "general";

export const EMOTION_CONTEXT_OPTIONS: ReadonlyArray<{
  value: EmotionContext;
  label: string;
}> = EMOTION_CONTEXT_VALUES.map((value) => ({
  value,
  label: EMOTION_CONTEXT_CONFIG[value].label,
}));

export function parseEmotionContext(
  input: unknown,
  fallback: EmotionContext = DEFAULT_EMOTION_CONTEXT,
): EmotionContext {
  if (typeof input !== "string") {
    return fallback;
  }

  const normalized = input.trim().toLowerCase();
  if (EMOTION_CONTEXT_VALUES.includes(normalized as EmotionContext)) {
    return normalized as EmotionContext;
  }

  return fallback;
}

export function getEmotionContextPromptGuidance(emotionContext: EmotionContext): string {
  return EMOTION_CONTEXT_CONFIG[emotionContext].promptGuidance;
}
