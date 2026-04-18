import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMOTION_CONTEXT,
  EMOTION_CONTEXT_OPTIONS,
  EMOTION_CONTEXT_VALUES,
  getEmotionContextPromptGuidance,
  parseEmotionContext,
} from "@/lib/emotion-context";

describe("parseEmotionContext", () => {
  it("normalizes supported values from route or form input strings", () => {
    expect(parseEmotionContext(" sadness ")).toBe("sadness");
    expect(parseEmotionContext("JOY")).toBe("joy");
    expect(parseEmotionContext("\n nostalgia\t")).toBe("nostalgia");
  });

  it("falls back to general for invalid route or form input values", () => {
    expect(parseEmotionContext("unknown")).toBe(DEFAULT_EMOTION_CONTEXT);
    expect(parseEmotionContext("joyful")).toBe(DEFAULT_EMOTION_CONTEXT);
    expect(parseEmotionContext("")).toBe(DEFAULT_EMOTION_CONTEXT);
    expect(parseEmotionContext("   ")).toBe(DEFAULT_EMOTION_CONTEXT);
    expect(parseEmotionContext(null)).toBe(DEFAULT_EMOTION_CONTEXT);
    expect(parseEmotionContext(["joy"])).toBe(DEFAULT_EMOTION_CONTEXT);
  });

  it("supports serializing parsed values back into stable form payloads", () => {
    const parsed = parseEmotionContext("  MOTIVATION ");
    const payload = new URLSearchParams({ emotionContext: parsed });

    expect(payload.toString()).toBe("emotionContext=motivation");
    expect(parseEmotionContext(payload.get("emotionContext"))).toBe("motivation");
  });
});

describe("EMOTION_CONTEXT_OPTIONS", () => {
  it("includes stable preset metadata for each emotion context", () => {
    expect(EMOTION_CONTEXT_VALUES).toEqual([
      "general",
      "sadness",
      "anger",
      "tenderness",
      "anxiety",
      "joy",
      "nostalgia",
      "motivation",
      "disappointment",
    ]);
    expect(EMOTION_CONTEXT_OPTIONS).toEqual([
      { value: "general", label: "General" },
      { value: "sadness", label: "Sadness" },
      { value: "anger", label: "Anger" },
      { value: "tenderness", label: "Tenderness" },
      { value: "anxiety", label: "Anxiety" },
      { value: "joy", label: "Joy" },
      { value: "nostalgia", label: "Nostalgia" },
      { value: "motivation", label: "Motivation" },
      { value: "disappointment", label: "Disappointment" },
    ]);
  });

  it("stays aligned with the parseable emotion context values", () => {
    const optionValues = EMOTION_CONTEXT_OPTIONS.map((option) => option.value);

    expect(optionValues).toEqual([
      "general",
      "sadness",
      "anger",
      "tenderness",
      "anxiety",
      "joy",
      "nostalgia",
      "motivation",
      "disappointment",
    ]);
    expect(optionValues.every((value) => parseEmotionContext(value) === value)).toBe(true);
    expect(new Set(optionValues).size).toBe(optionValues.length);
  });
});

describe("getEmotionContextPromptGuidance", () => {
  it("returns emotion-specific guidance and general fallback guidance", () => {
    expect(getEmotionContextPromptGuidance("nostalgia")).toContain("nostalgia");
    expect(getEmotionContextPromptGuidance("general")).toContain("broad emotional range");
  });
});

describe("module exports", () => {
  it("exposes stable shared emotion values for runtime and schema alignment", async () => {
    const emotionContextModule = await import("@/lib/emotion-context");
    expect(emotionContextModule.EMOTION_CONTEXT_VALUES).toEqual(
      EMOTION_CONTEXT_OPTIONS.map((option) => option.value),
    );
  });
});
