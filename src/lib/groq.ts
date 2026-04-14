import { readFile } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logger";

const logger = createLogger("lib/groq");

export type GroqWord = {
  word: string;
  start?: number;
  end?: number;
};

export type GroqSegment = {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  words?: GroqWord[];
};

export type GroqTranscriptionResponse = {
  text?: string;
  language?: string;
  segments?: GroqSegment[];
};

export type TranscriptForSelection = {
  startMs: number;
  endMs: number;
  text: string;
};

export type GroqHighlightCandidate = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
};

type GroqChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type GroqModelsResponse = {
  data?: Array<{
    id?: string;
  }>;
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Respons AI tidak mengandung JSON object yang valid");
  }

  return raw.slice(start, end + 1);
}

function normalizeCandidates(input: unknown): GroqHighlightCandidate[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];

  return candidates
    .map((candidate): GroqHighlightCandidate | null => {
      if (!candidate || typeof candidate !== "object") {
        return null;
      }

      const item = candidate as Record<string, unknown>;
      const startMs = Number(item.startMs);
      const endMs = Number(item.endMs);

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null;
      }

      const scoreTotal = clamp(Number(item.scoreTotal), 0, 1);
      const scoreTextRaw = Number(item.scoreText);
      const scoreText = Number.isFinite(scoreTextRaw) ? clamp(scoreTextRaw, 0, 1) : scoreTotal;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "Selected by AI";
      const topic = typeof item.topic === "string" ? item.topic.trim() : undefined;

      return {
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(1, Math.round(endMs)),
        scoreTotal,
        scoreText,
        reason,
        topic,
      };
    })
    .filter((item): item is GroqHighlightCandidate => item !== null)
    .sort((a, b) => {
      if (b.scoreTotal !== a.scoreTotal) {
        return b.scoreTotal - a.scoreTotal;
      }
      return a.startMs - b.startMs;
    });
}

function buildGroqModelsEndpoint(chatEndpoint: string): string {
  const configured = process.env.GROQ_MODELS_ENDPOINT?.trim();
  if (configured) {
    return configured;
  }

  if (chatEndpoint.endsWith("/chat/completions")) {
    return chatEndpoint.replace(/\/chat\/completions$/, "/models");
  }

  return "https://api.groq.com/openai/v1/models";
}

function uniqModels(models: string[]): string[] {
  return [...new Set(models.filter((item) => item.trim().length > 0))];
}

function looksLikeModelNotFound(status: number, responseText: string): boolean {
  const lower = responseText.toLowerCase();
  return status === 404 || lower.includes("model_not_found") || lower.includes("does not exist");
}

async function listGroqModels(apiKey: string, modelsEndpoint: string): Promise<Set<string> | null> {
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

function resolveHighlightModelCandidates(requestedModel: string, available: Set<string> | null): string[] {
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

export async function transcribeAudioWithGroq(audioPath: string, apiKey: string) {
  const model = process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";
  const endpoint = process.env.GROQ_TRANSCRIBE_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/audio/transcriptions";

  logger.info("transcribe_request_started", { model, endpoint, audioPath });

  const fileBuffer = await readFile(audioPath);

  const formData = new FormData();
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  formData.append("timestamp_granularities[]", "word");
  const language = process.env.GROQ_TRANSCRIBE_LANGUAGE?.trim();
  if (language) {
    formData.append("language", language);
  }

  formData.append("file", new Blob([fileBuffer], { type: "audio/wav" }), path.basename(audioPath));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  logger.info("transcribe_response_received", { model, status: response.status });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("transcribe_request_failed", { model, status: response.status, errorText });
    throw new Error(`Groq transcription gagal (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as GroqTranscriptionResponse;
  logger.info("transcribe_request_completed", {
    model,
    segments: json.segments?.length || 0,
    language: json.language || null,
  });
  return { model, result: json };
}

export async function selectHighlightsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  apiKey: string
) {
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint = process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  logger.info("highlight_request_started", {
    requestedModel,
    endpoint,
    transcriptCount: transcriptSegments.length,
    candidateModels,
  });

  const compactTranscript = transcriptSegments
    .slice(0, 220)
    .map((segment, index) => {
      return `${index + 1}. [${segment.startMs}-${segment.endMs}] ${segment.text}`;
    })
    .join("\n");

  const systemPrompt =
    "Kamu adalah AI editor untuk social media short clips. Pilih segmen dengan potensi engagement tinggi dari transcript. Keluaran HARUS JSON valid tanpa markdown.";

  const userPrompt = [
    "Pilih maksimal 6 kandidat clip dengan aturan:",
    "- Durasi target tiap clip 20-45 detik",
    "- Prioritaskan hook kuat, novelty, emosi, value, CTA",
    "- Hindari overlap berat antar kandidat",
    "- Gunakan timestamp yang ada pada transcript",
    "",
    "Format JSON wajib:",
    '{"candidates":[{"startMs":1234,"endMs":34567,"scoreTotal":0.92,"scoreText":0.90,"reason":"...","topic":"..."}] }',
    "",
    "Transcript:",
    compactTranscript,
  ].join("\n");

  let lastError: string | null = null;

  for (const model of candidateModels) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    logger.info("highlight_response_received", { model, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      lastError = `Groq highlight selection gagal (${response.status}): ${errorText}`;

      if (looksLikeModelNotFound(response.status, errorText)) {
        logger.warn("highlight_model_unavailable", { model, status: response.status });
        continue;
      }

      logger.error("highlight_request_failed", { model, status: response.status, errorText });
      throw new Error(lastError);
    }

    const json = (await response.json()) as GroqChatCompletionResponse;
    const rawContent = json.choices?.[0]?.message?.content?.trim();

    if (!rawContent) {
      throw new Error("Respons highlight selection kosong");
    }

    const parsed = JSON.parse(extractJsonObject(rawContent)) as unknown;
    const candidates = normalizeCandidates(parsed);

    if (candidates.length === 0) {
      logger.warn("highlight_candidates_empty", { model });
      throw new Error("AI tidak menghasilkan kandidat highlight valid");
    }

    logger.info("highlight_request_completed", { model, candidates: candidates.length });
    return { model, candidates };
  }

  throw new Error(
    lastError ||
      "Groq highlight selection gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}
