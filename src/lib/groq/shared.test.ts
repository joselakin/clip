import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGroqContentAsJson,
  supportsStrictStructuredOutputs,
} from "@/lib/groq/shared";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unmock("@/lib/groq/shared");
});

async function loadHighlightsWithSharedMocks() {
  vi.doMock("@/lib/groq/shared", async () => {
    const actual = await vi.importActual<typeof import("@/lib/groq/shared")>("@/lib/groq/shared");
    return {
      ...actual,
      listGroqModels: vi.fn().mockResolvedValue(null),
      resolveHighlightModelCandidates: vi.fn(() => ["model-a", "model-b"]),
      requestGroqJson: vi.fn(),
    };
  });

  const highlights = await import("@/lib/groq/highlights");
  const shared = await import("@/lib/groq/shared");
  return {
    highlights,
    shared,
    requestGroqJsonMock: vi.mocked(shared.requestGroqJson),
  };
}

describe("supportsStrictStructuredOutputs", () => {
  it("returns true for gpt-oss models", () => {
    expect(supportsStrictStructuredOutputs("openai/gpt-oss-120b")).toBe(true);
    expect(supportsStrictStructuredOutputs("gpt-oss-20b")).toBe(true);
  });

  it("returns false for non gpt-oss models", () => {
    expect(supportsStrictStructuredOutputs("llama-3.3-70b-versatile")).toBe(false);
    expect(supportsStrictStructuredOutputs("")).toBe(false);
  });
});

describe("parseGroqContentAsJson", () => {
  it("parses direct JSON string", () => {
    const parsed = parseGroqContentAsJson<{ foo: string; value: number }>(
      '{"foo":"bar","value":1}'
    );
    expect(parsed).toEqual({ foo: "bar", value: 1 });
  });

  it("extracts JSON object from wrapped content", () => {
    const parsed = parseGroqContentAsJson<{ candidates: Array<{ startMs: number }> }>(
      "Result:\n```json\n{\"candidates\":[{\"startMs\":1200}]}\n```"
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.startMs).toBe(1200);
  });

  it("repairs JS-like object output with bare keys and trailing commas", () => {
    const parsed = parseGroqContentAsJson<{
      candidates: Array<{ startMs: number; endMs: number; reason: string }>;
    }>(`{
      candidates: [
        { startMs: 1200, endMs: 5400, reason: "hook kuat", },
      ],
    }`);

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toEqual({
      startMs: 1200,
      endMs: 5400,
      reason: "hook kuat",
    });
  });

  it("throws when content has no valid JSON object", () => {
    expect(() => parseGroqContentAsJson("not-json")).toThrow(
      "Respons AI tidak mengandung JSON object yang valid"
    );
  });
});

describe("highlights fallback and schema behavior", () => {
  it("selectHighlightsWithGroq falls back to next model on parse/content failures", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockRejectedValueOnce(new Error("Respons highlight selection kosong"));
    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            startMs: 1234,
            endMs: 24567,
            scoreTotal: 0.91,
            scoreText: 0.89,
            reason: "strong hook",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.selectHighlightsWithGroq(
      [{ startMs: 0, endMs: 30000, text: "hello world" }],
      "test-key"
    );

    expect(result.model).toBe("model-b");
    expect(result.candidates).toHaveLength(1);
    expect(requestGroqJsonMock).toHaveBeenCalledTimes(2);
  });

  it("selectHighlightsWithGroq rejects zero-length segments after rounding and falls back", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            startMs: 100.4,
            endMs: 100.49,
            scoreTotal: 0.9,
            scoreText: 0.87,
            reason: "rounding collision",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });
    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            startMs: 200,
            endMs: 260,
            scoreTotal: 0.84,
            scoreText: 0.84,
            reason: "valid",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.selectHighlightsWithGroq(
      [{ startMs: 0, endMs: 30000, text: "hello world" }],
      "test-key"
    );

    expect(result.model).toBe("model-b");
    expect(result.candidates[0]?.startMs).toBe(200);
    expect(result.candidates[0]?.endMs).toBe(260);
    expect(requestGroqJsonMock).toHaveBeenCalledTimes(2);
  });

  it("evaluateClipRecommendationsWithGroq falls back to next model on invalid normalized output", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        evaluations: [
          {
            startMs: 100.4,
            endMs: 100.49,
            recommendedTitle: "judul invalid",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });
    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 35000,
            recommendedTitle: "Judul yang bagus",
            overallScore: 88,
            hookScore: 90,
            valueScore: 86,
            clarityScore: 84,
            emotionScore: 83,
            shareabilityScore: 87,
            whyThisWorks: "Hook jelas.",
            improvementTip: "Perkuat CTA.",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.evaluateClipRecommendationsWithGroq(
      [{ startMs: 0, endMs: 50000, text: "segment" }],
      [{ startMs: 1000, endMs: 35000, scoreTotal: 0.8, scoreText: 0.79, reason: "candidate" }],
      "test-key"
    );

    expect(result.model).toBe("model-b");
    expect(result.evaluations).toHaveLength(1);
    expect(requestGroqJsonMock).toHaveBeenCalledTimes(2);
  });

  it("uses strict item schemas without additional properties", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValue({
      data: {
        candidates: [
          {
            startMs: 100,
            endMs: 200,
            scoreTotal: 0.9,
            scoreText: 0.9,
            reason: "ok",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    await highlights.selectHighlightsWithGroq(
      [{ startMs: 0, endMs: 5000, text: "text" }],
      "test-key"
    );

    const selectCall = requestGroqJsonMock.mock.calls[0]?.[0] as unknown as {
      schema: {
        properties: {
          candidates: {
            items: {
              additionalProperties: boolean;
            };
          };
        };
      };
    };
    expect(selectCall.schema.properties.candidates.items.additionalProperties).toBe(false);

    requestGroqJsonMock.mockReset();
    requestGroqJsonMock.mockResolvedValue({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 2000,
            recommendedTitle: "Judul",
            overallScore: 80,
            hookScore: 80,
            valueScore: 80,
            clarityScore: 80,
            emotionScore: 80,
            shareabilityScore: 80,
            whyThisWorks: "ok",
            improvementTip: "ok",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    await highlights.evaluateClipRecommendationsWithGroq(
      [{ startMs: 0, endMs: 5000, text: "text" }],
      [{ startMs: 1000, endMs: 2000, scoreTotal: 0.8, scoreText: 0.8, reason: "ok" }],
      "test-key"
    );

    const evalCall = requestGroqJsonMock.mock.calls[0]?.[0] as unknown as {
      schema: {
        properties: {
          evaluations: {
            items: {
              additionalProperties: boolean;
            };
          };
        };
      };
    };
    expect(evalCall.schema.properties.evaluations.items.additionalProperties).toBe(false);
  });

  it("criticEvaluateHighlightsWithGroq returns normalized public contract shape", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValue({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 26000,
            overallScore: 0.83,
            hookScore: 84,
            valueScore: 82,
            clarityScore: 80,
            emotionScore: 78,
            noveltyScore: 76,
            shareabilityScore: 85,
            isPass: true,
            failureReasons: ["hook", "clarity"],
            fixGuidance: "Perjelas hook di 2 detik awal.",
            topic: "growth",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.criticEvaluateHighlightsWithGroq(
      [{ startMs: 0, endMs: 50000, text: "segment" }],
      [{ startMs: 1000, endMs: 26000, scoreTotal: 0.8, scoreText: 0.79, reason: "candidate" }],
      "test-key"
    );

    expect(result.model).toBe("model-a");
    expect(result.evaluations[0]).toEqual({
      startMs: 1000,
      endMs: 26000,
      overallScore: 83,
      hookScore: 84,
      valueScore: 82,
      clarityScore: 80,
      emotionScore: 78,
      noveltyScore: 76,
      shareabilityScore: 85,
      isPass: true,
      failureReasons: ["hook", "clarity"],
      fixGuidance: "Perjelas hook di 2 detik awal.",
      topic: "growth",
    });
    expect(result.evaluations[0]).not.toHaveProperty("verdict");
    expect(result.evaluations[0]).not.toHaveProperty("score");
    expect(result.evaluations[0]).not.toHaveProperty("failureTags");
    expect(result.evaluations[0]).not.toHaveProperty("suggestedFix");
  });

  it("criticEvaluateHighlightsWithGroq uses passThreshold for fallback isPass", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValue({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 26000,
            overallScore: 80,
            hookScore: 80,
            valueScore: 80,
            clarityScore: 80,
            emotionScore: 80,
            noveltyScore: 80,
            shareabilityScore: 80,
            failureReasons: [],
            fixGuidance: "Perkuat hook.",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.criticEvaluateHighlightsWithGroq(
      [{ startMs: 0, endMs: 50000, text: "segment" }],
      [{ startMs: 1000, endMs: 26000, scoreTotal: 0.8, scoreText: 0.79, reason: "candidate" }],
      "test-key",
      { passThreshold: 85 }
    );

    expect(result.evaluations[0]?.isPass).toBe(false);
  });

  it("regenerateHighlightsFromFailuresWithGroq consumes failureReasons and fixGuidance", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValue({
      data: {
        candidates: [
          {
            startMs: 30000,
            endMs: 52000,
            scoreTotal: 0.87,
            scoreText: 0.86,
            reason: "improved",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    const result = await highlights.regenerateHighlightsFromFailuresWithGroq(
      [{ startMs: 0, endMs: 70000, text: "segment" }],
      [
        {
          startMs: 1000,
          endMs: 26000,
          overallScore: 58,
          hookScore: 50,
          valueScore: 60,
          clarityScore: 59,
          emotionScore: 57,
          noveltyScore: 56,
          shareabilityScore: 61,
          isPass: false,
          failureReasons: ["hook", "clarity"],
          fixGuidance: "Mulai dengan konflik utama di awal.",
        },
      ],
      "test-key"
    );

    expect(result.model).toBe("model-a");
    const regenCall = requestGroqJsonMock.mock.calls[0]?.[0] as unknown as { userPrompt: string };
    expect(regenCall.userPrompt).toContain("failureReasons");
    expect(regenCall.userPrompt).toContain("fixGuidance");
    expect(regenCall.userPrompt).toContain("Mulai dengan konflik utama di awal.");
  });

  it("uses strict critic item schema without additional properties", async () => {
    const { highlights, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockResolvedValue({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 26000,
            overallScore: 81,
            hookScore: 83,
            valueScore: 80,
            clarityScore: 79,
            emotionScore: 78,
            noveltyScore: 77,
            shareabilityScore: 82,
            isPass: true,
            failureReasons: [],
            fixGuidance: "Pertahankan pacing.",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    await highlights.criticEvaluateHighlightsWithGroq(
      [{ startMs: 0, endMs: 50000, text: "segment" }],
      [{ startMs: 1000, endMs: 26000, scoreTotal: 0.8, scoreText: 0.79, reason: "candidate" }],
      "test-key"
    );

    const criticCall = requestGroqJsonMock.mock.calls[0]?.[0] as unknown as {
      schema: {
        properties: {
          evaluations: {
            items: {
              additionalProperties: boolean;
            };
          };
        };
      };
    };
    expect(criticCall.schema.properties.evaluations.items.additionalProperties).toBe(false);
  });

  it("criticEvaluateHighlightsWithGroq fails fast on auth errors", async () => {
    const { highlights, shared, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockRejectedValueOnce(
      new shared.GroqApiRequestError("unauthorized", 401, "bad key", "model-a")
    );
    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        evaluations: [
          {
            startMs: 1000,
            endMs: 26000,
            overallScore: 88,
            hookScore: 88,
            valueScore: 88,
            clarityScore: 88,
            emotionScore: 88,
            noveltyScore: 88,
            shareabilityScore: 88,
            isPass: true,
            failureReasons: [],
            fixGuidance: "ok",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    await expect(
      highlights.criticEvaluateHighlightsWithGroq(
        [{ startMs: 0, endMs: 50000, text: "segment" }],
        [{ startMs: 1000, endMs: 26000, scoreTotal: 0.8, scoreText: 0.79, reason: "candidate" }],
        "test-key"
      )
    ).rejects.toThrow("Groq critic evaluation gagal (401): bad key");
    expect(requestGroqJsonMock).toHaveBeenCalledTimes(1);
  });

  it("regenerateHighlightsFromFailuresWithGroq fails fast on permission errors", async () => {
    const { highlights, shared, requestGroqJsonMock } = await loadHighlightsWithSharedMocks();

    requestGroqJsonMock.mockRejectedValueOnce(
      new shared.GroqApiRequestError("forbidden", 403, "forbidden", "model-a")
    );
    requestGroqJsonMock.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            startMs: 30000,
            endMs: 52000,
            scoreTotal: 0.87,
            scoreText: 0.86,
            reason: "improved",
          },
        ],
      },
      status: 200,
      rawContent: "ok",
    });

    await expect(
      highlights.regenerateHighlightsFromFailuresWithGroq(
        [{ startMs: 0, endMs: 70000, text: "segment" }],
        [
          {
            startMs: 1000,
            endMs: 26000,
            overallScore: 58,
            hookScore: 50,
            valueScore: 60,
            clarityScore: 59,
            emotionScore: 57,
            noveltyScore: 56,
            shareabilityScore: 61,
            isPass: false,
            failureReasons: ["hook", "clarity"],
            fixGuidance: "Mulai dengan konflik utama di awal.",
          },
        ],
        "test-key"
      )
    ).rejects.toThrow("Groq regenerate highlight gagal (403): forbidden");
    expect(requestGroqJsonMock).toHaveBeenCalledTimes(1);
  });
});
