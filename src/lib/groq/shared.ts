import { createLogger } from "@/lib/logger";

const logger = createLogger("lib/groq/shared");

export type GroqChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export type GroqModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

export type TranscriptWindowSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Respons AI tidak mengandung JSON object yang valid");
  }

  return raw.slice(start, end + 1);
}

function uniqModels(models: string[]): string[] {
  return [...new Set(models.filter((item) => item.trim().length > 0))];
}

export function looksLikeModelNotFound(status: number, responseText: string): boolean {
  const lower = responseText.toLowerCase();
  return status === 404 || lower.includes("model_not_found") || lower.includes("does not exist");
}

export function buildGroqModelsEndpoint(chatEndpoint: string): string {
  const configured = process.env.GROQ_MODELS_ENDPOINT?.trim();
  if (configured) {
    return configured;
  }

  if (chatEndpoint.endsWith("/chat/completions")) {
    return chatEndpoint.replace(/\/chat\/completions$/, "/models");
  }

  return "https://api.groq.com/openai/v1/models";
}

export async function listGroqModels(
  apiKey: string,
  modelsEndpoint: string
): Promise<Set<string> | null> {
  try {
    const response = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      logger.warn("models_list_failed", { endpoint: modelsEndpoint, status: response.status });
      return null;
    }

    const json = (await response.json()) as GroqModelsResponse;
    const ids = (json.data || [])
      .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
      .filter((id) => id.length > 0);

    if (ids.length === 0) {
      return null;
    }

    logger.info("models_list_loaded", { count: ids.length });
    return new Set(ids);
  } catch {
    logger.warn("models_list_failed", { endpoint: modelsEndpoint });
    return null;
  }
}

export function resolveHighlightModelCandidates(
  requestedModel: string,
  available: Set<string> | null
): string[] {
  const preferred = uniqModels([
    requestedModel,
    "openai/gpt-oss-120b",
    "gpt-oss-120b",
    "openai/gpt-oss-20b",
    "gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ]);

  if (!available || available.size === 0) {
    return preferred;
  }

  const availablePreferred = preferred.filter((model) => available.has(model));
  if (availablePreferred.length > 0) {
    return availablePreferred;
  }

  const discovered = [...available].filter((model) => {
    const lower = model.toLowerCase();
    return lower.includes("gpt") || lower.includes("oss") || lower.includes("llama");
  });

  if (discovered.length > 0) {
    return discovered;
  }

  return [requestedModel];
}

export function buildCandidateWindowText(
  transcriptSegments: TranscriptWindowSegment[],
  startMs: number,
  endMs: number,
  maxChars = 420
): string {
  const joined = transcriptSegments
    .filter((segment) => segment.endMs > startMs && segment.startMs < endMs)
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!joined) {
    return "[empty transcript window]";
  }

  if (joined.length <= maxChars) {
    return joined;
  }

  return `${joined.slice(0, maxChars)}...`;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }

  return chunks;
}

export function normalizeSpeakerLabelToken(value: unknown): "SPEAKER_1" | "SPEAKER_2" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (["SPEAKER_1", "SPK1", "A", "1"].includes(normalized)) {
    return "SPEAKER_1";
  }

  if (["SPEAKER_2", "SPK2", "B", "2"].includes(normalized)) {
    return "SPEAKER_2";
  }

  return null;
}
