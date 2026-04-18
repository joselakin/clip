import { createLogger } from "@/lib/logger";
import {
  DEFAULT_EMOTION_CONTEXT,
  getEmotionContextPromptGuidance,
  parseEmotionContext,
  type EmotionContext,
} from "@/lib/emotion-context";
import {
  buildCandidateWindowText,
  buildGroqModelsEndpoint,
  clamp,
  GroqApiRequestError,
  listGroqModels,
  looksLikeModelNotFound,
  requestGroqJson,
  resolveHighlightModelCandidates,
} from "@/lib/groq/shared";

const logger = createLogger("lib/groq/highlights");

export type TranscriptForSelection = {
  startMs: number;
  endMs: number;
  text: string;
};

type EmotionFitFields = {
  matchedEmotionContext?: EmotionContext;
  emotionFitScore?: number;
  emotionFitReason?: string;
  emotionFallback?: boolean;
};

export type GroqHighlightCandidate = EmotionFitFields & {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  scoreText: number;
  reason: string;
  topic?: string;
};

export type GroqClipEvaluation = EmotionFitFields & {
  startMs: number;
  endMs: number;
  recommendedTitle: string;
  overallScore: number;
  hookScore: number;
  valueScore: number;
  clarityScore: number;
  emotionScore: number;
  shareabilityScore: number;
  whyThisWorks: string;
  improvementTip: string;
  angle?: string;
};

type HighlightSelectionOptions = {
  maxCandidates?: number;
  durationRule?: string;
  extraRules?: string[];
  emotionContext?: EmotionContext;
};

export type HighlightCriticEvaluation = EmotionFitFields & {
  startMs: number;
  endMs: number;
  overallScore: number;
  hookScore: number;
  valueScore: number;
  clarityScore: number;
  emotionScore: number;
  noveltyScore: number;
  shareabilityScore: number;
  isPass: boolean;
  failureReasons: string[];
  fixGuidance: string;
  topic?: string;
};

type SelectHighlightsForWindowInput = {
  index: number;
  startMs: number;
  endMs: number;
  segments: TranscriptForSelection[];
};

type CriticEvaluateOptions = {
  passThreshold?: number;
  emotionContext?: EmotionContext;
};

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
      const rawStartMs = Number(item.startMs);
      const rawEndMs = Number(item.endMs);

      if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
        return null;
      }

      const startMs = Math.max(0, Math.round(rawStartMs));
      const endMs = Math.max(1, Math.round(rawEndMs));
      if (endMs <= startMs) {
        return null;
      }

      const scoreTotal = clamp(Number(item.scoreTotal), 0, 1);
      const scoreTextRaw = Number(item.scoreText);
      const scoreText = Number.isFinite(scoreTextRaw) ? clamp(scoreTextRaw, 0, 1) : scoreTotal;
      const reason = typeof item.reason === "string" ? item.reason.trim() : "Selected by AI";
      const topic = typeof item.topic === "string" ? item.topic.trim() : undefined;

      return {
        startMs,
        endMs,
        scoreTotal,
        scoreText,
        reason,
        topic,
        ...normalizeEmotionFitFields(item),
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

function normalizeFailureReasons(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 5);
}

function normalizeOptionalEmotionContext(value: unknown): EmotionContext | undefined {
  const parsed = parseEmotionContext(value, DEFAULT_EMOTION_CONTEXT);
  if (typeof value !== "string") {
    return undefined;
  }
  return parsed === DEFAULT_EMOTION_CONTEXT && value.trim().toLowerCase() !== DEFAULT_EMOTION_CONTEXT
    ? undefined
    : parsed;
}

function normalizeOptionalEmotionFitScore(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  return normalizeScore100(value, 0);
}

function normalizeOptionalEmotionFitReason(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalEmotionFallback(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function normalizeEmotionFitFields(item: Record<string, unknown>): EmotionFitFields {
  return {
    matchedEmotionContext: normalizeOptionalEmotionContext(item.matchedEmotionContext),
    emotionFitScore: normalizeOptionalEmotionFitScore(item.emotionFitScore),
    emotionFitReason: normalizeOptionalEmotionFitReason(item.emotionFitReason),
    emotionFallback: normalizeOptionalEmotionFallback(item.emotionFallback),
  };
}

function buildEmotionPromptBlock(emotionContext: EmotionContext): string[] {
  if (emotionContext === DEFAULT_EMOTION_CONTEXT) {
    return [];
  }

  return [
    `- Requested emotion context: ${emotionContext}`,
    `- Emotion guidance: ${getEmotionContextPromptGuidance(emotionContext)}`,
    "- Jika cocok, isi matchedEmotionContext, emotionFitScore (0-100), emotionFitReason, dan emotionFallback.",
    "- Jika kecocokan emosinya lemah tapi kandidat tetap layak, emotionFallback boleh true.",
  ];
}

function normalizeCriticEvaluations(
  input: unknown,
  passThreshold: number
): HighlightCriticEvaluation[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const evaluations = Array.isArray(record.evaluations) ? record.evaluations : [];

  return evaluations
    .map((row): HighlightCriticEvaluation | null => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const item = row as Record<string, unknown>;
      const rawStartMs = Number(item.startMs);
      const rawEndMs = Number(item.endMs);
      if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
        return null;
      }

      const startMs = Math.max(0, Math.round(rawStartMs));
      const endMs = Math.max(1, Math.round(rawEndMs));
      if (endMs <= startMs) {
        return null;
      }

      const overallScore = normalizeScore100(item.overallScore ?? item.score, 68);
      const hookScore = normalizeScore100(item.hookScore, overallScore);
      const valueScore = normalizeScore100(item.valueScore, overallScore);
      const clarityScore = normalizeScore100(item.clarityScore, overallScore);
      const emotionScore = normalizeScore100(item.emotionScore, overallScore);
      const noveltyScore = normalizeScore100(item.noveltyScore, overallScore);
      const shareabilityScore = normalizeScore100(item.shareabilityScore, overallScore);

      const rawVerdict = typeof item.verdict === "string" ? item.verdict.trim().toUpperCase() : "";
      const isPass =
        typeof item.isPass === "boolean"
          ? item.isPass
          : rawVerdict
            ? rawVerdict === "PASS"
            : overallScore >= passThreshold;
      const failureReasons = normalizeFailureReasons(item.failureReasons ?? item.failureTags);

      const fixGuidanceRaw =
        typeof item.fixGuidance === "string"
          ? item.fixGuidance
          : typeof item.suggestedFix === "string"
            ? item.suggestedFix
            : typeof item.reason === "string"
              ? item.reason
              : "Perkuat hook awal dan pertegas value utama clip.";
      const fixGuidance =
        fixGuidanceRaw.trim().length > 0
          ? fixGuidanceRaw.trim()
          : "Perkuat hook awal dan pertegas value utama clip.";
      const topic = typeof item.topic === "string" ? item.topic.trim() : undefined;

      return {
        startMs,
        endMs,
        overallScore,
        hookScore,
        valueScore,
        clarityScore,
        emotionScore,
        noveltyScore,
        shareabilityScore,
        isPass,
        failureReasons,
        fixGuidance,
        topic,
        ...normalizeEmotionFitFields(item),
      };
    })
    .filter((item): item is HighlightCriticEvaluation => item !== null);
}

function isModelUnavailableError(error: unknown): boolean {
  if (!(error instanceof GroqApiRequestError)) {
    return false;
  }

  return looksLikeModelNotFound(error.status, error.responseText);
}

function isAuthOrPermissionError(error: unknown): boolean {
  if (!(error instanceof GroqApiRequestError)) {
    return false;
  }

  return error.status === 401 || error.status === 403;
}

function normalizeScore100(value: unknown, fallback = 70): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  if (raw <= 1) {
    return Math.round(clamp(raw, 0, 1) * 100);
  }

  return Math.round(clamp(raw, 0, 100));
}

function normalizeClipEvaluations(input: unknown): GroqClipEvaluation[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const record = input as Record<string, unknown>;
  const evaluations = Array.isArray(record.evaluations) ? record.evaluations : [];

  return evaluations
    .map((row): GroqClipEvaluation | null => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const item = row as Record<string, unknown>;
      const rawStartMs = Number(item.startMs);
      const rawEndMs = Number(item.endMs);

      if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
        return null;
      }

      const startMs = Math.max(0, Math.round(rawStartMs));
      const endMs = Math.max(1, Math.round(rawEndMs));
      if (endMs <= startMs) {
        return null;
      }

      const recommendedTitleRaw =
        typeof item.recommendedTitle === "string"
          ? item.recommendedTitle
          : typeof item.title === "string"
            ? item.title
            : "";
      const recommendedTitle = recommendedTitleRaw.trim();
      if (!recommendedTitle) {
        return null;
      }

      const whyThisWorks =
        typeof item.whyThisWorks === "string"
          ? item.whyThisWorks.trim()
          : typeof item.why === "string"
            ? item.why.trim()
            : "Potensi engagement cukup baik untuk short-form.";

      const improvementTip =
        typeof item.improvementTip === "string"
          ? item.improvementTip.trim()
          : typeof item.improvement === "string"
            ? item.improvement.trim()
            : "Perkuat opening 2 detik pertama agar hook lebih tajam.";

      const angle = typeof item.angle === "string" ? item.angle.trim() : undefined;

      return {
        startMs,
        endMs,
        recommendedTitle,
        overallScore: normalizeScore100(item.overallScore, 75),
        hookScore: normalizeScore100(item.hookScore, 75),
        valueScore: normalizeScore100(item.valueScore, 75),
        clarityScore: normalizeScore100(item.clarityScore, 75),
        emotionScore: normalizeScore100(item.emotionScore, 75),
        shareabilityScore: normalizeScore100(item.shareabilityScore, 75),
        whyThisWorks,
        improvementTip,
        angle,
        ...normalizeEmotionFitFields(item),
      };
    })
    .filter((item): item is GroqClipEvaluation => item !== null);
}

export async function selectHighlightsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  apiKey: string,
  options?: HighlightSelectionOptions
) {
  const maxCandidates = Math.max(1, Math.min(10, Math.round(options?.maxCandidates ?? 6)));
  const emotionContext = options?.emotionContext ?? DEFAULT_EMOTION_CONTEXT;
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
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
    `Pilih maksimal ${maxCandidates} kandidat clip dengan aturan:`,
    options?.durationRule || "- Durasi target tiap clip 20-45 detik",
    "- Prioritaskan hook kuat, novelty, emosi, value, CTA",
    "- Hindari overlap berat antar kandidat",
    "- Gunakan timestamp yang ada pada transcript",
    ...(options?.extraRules || []),
    "",
    "Format JSON wajib:",
    '{"candidates":[{"startMs":1234,"endMs":34567,"scoreTotal":0.92,"scoreText":0.90,"reason":"...","topic":"...","matchedEmotionContext":"joy","emotionFitScore":88,"emotionFitReason":"...","emotionFallback":false}] }',
    ...buildEmotionPromptBlock(emotionContext),
    "",
    "Transcript:",
    compactTranscript,
  ].join("\n");

  let lastError: string | null = null;

  const selectSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            startMs: { type: "number" },
            endMs: { type: "number" },
            scoreTotal: { type: "number" },
            scoreText: { type: "number" },
            reason: { type: "string" },
            topic: { type: "string" },
            matchedEmotionContext: { type: "string" },
            emotionFitScore: { type: "number" },
            emotionFitReason: { type: "string" },
            emotionFallback: { type: "boolean" },
          },
          required: ["startMs", "endMs", "scoreTotal", "scoreText", "reason"],
        },
      },
    },
    required: ["candidates"],
  };

  for (const model of candidateModels) {
    try {
      const { data, status } = await requestGroqJson<unknown>({
        apiKey,
        endpoint,
        model,
        systemPrompt,
        userPrompt,
        temperature: 0.2,
        schemaName: "highlight_candidates",
        schema: selectSchema,
        emptyContentErrorMessage: "Respons highlight selection kosong",
      });
      logger.info("highlight_response_received", { model, status });

      const candidates = normalizeCandidates(data);
      if (candidates.length === 0) {
        logger.warn("highlight_candidates_empty", { model });
        throw new Error("AI tidak menghasilkan kandidat highlight valid");
      }

      logger.info("highlight_request_completed", { model, candidates: candidates.length });
      return { model, candidates };
    } catch (error) {
      if (isModelUnavailableError(error)) {
        const groqError = error as GroqApiRequestError;
        lastError = `Groq highlight selection gagal (${groqError.status}): ${groqError.responseText}`;
        logger.warn("highlight_model_unavailable", { model, status: groqError.status });
        continue;
      }

      if (isAuthOrPermissionError(error)) {
        const groqError = error as GroqApiRequestError;
        const message = `Groq highlight selection gagal (${groqError.status}): ${groqError.responseText}`;
        logger.error("highlight_request_auth_failed", { model, status: groqError.status });
        throw new Error(message);
      }

      const message = error instanceof Error ? error.message : "Groq highlight selection gagal";
      lastError = message;
      logger.warn("highlight_request_model_failed", { model, message });
      continue;
    }
  }

  throw new Error(
    lastError ||
      "Groq highlight selection gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}

export async function evaluateClipRecommendationsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  candidates: GroqHighlightCandidate[],
  apiKey: string,
  options?: { emotionContext?: EmotionContext },
) {
  const emotionContext = options?.emotionContext ?? DEFAULT_EMOTION_CONTEXT;
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  const compactCandidates = candidates.slice(0, 6).map((candidate, index) => {
    return {
      index: index + 1,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      currentReason: candidate.reason,
      matchedEmotionContext: candidate.matchedEmotionContext || null,
      emotionFitScore: candidate.emotionFitScore ?? null,
      emotionFitReason: candidate.emotionFitReason || null,
      emotionFallback: candidate.emotionFallback ?? null,
      transcriptWindow: buildCandidateWindowText(
        transcriptSegments,
        candidate.startMs,
        candidate.endMs
      ),
    };
  });

  const systemPrompt = [
    "Kamu adalah Senior Short-Form Content Strategist untuk TikTok/Reels/Shorts.",
    "Tugasmu menilai setiap kandidat clip dan membuat judul rekomendasi yang klik-able tetapi tetap jujur.",
    "Fokus scoring: hook strength, value density, clarity, emotional pull, shareability.",
    "Skor wajib 0-100 bilangan bulat.",
    "Output HARUS JSON valid tanpa markdown, tanpa komentar, tanpa teks tambahan.",
    "Jangan mengubah timestamp kandidat yang diberikan.",
  ].join(" ");

  const userPrompt = [
    "Nilai semua kandidat berikut.",
    "Setiap kandidat harus dikembalikan dalam evaluations.",
    "Format JSON wajib:",
    '{"evaluations":[{"startMs":1234,"endMs":34567,"recommendedTitle":"...","overallScore":90,"hookScore":92,"valueScore":88,"clarityScore":84,"emotionScore":86,"shareabilityScore":89,"whyThisWorks":"...","improvementTip":"...","angle":"...","matchedEmotionContext":"joy","emotionFitScore":88,"emotionFitReason":"...","emotionFallback":false}]}',
    "Aturan:",
    "- recommendedTitle: 5-12 kata, bahasa Indonesia natural, kuat di hook",
    "- whyThisWorks: 1 kalimat ringkas dan spesifik",
    "- improvementTip: 1 kalimat actionable",
    "- angle: optional, boleh kosong",
    ...buildEmotionPromptBlock(emotionContext),
    "Candidates:",
    JSON.stringify(compactCandidates),
  ].join("\n");

  let lastError: string | null = null;

  const clipEvalSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      evaluations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            startMs: { type: "number" },
            endMs: { type: "number" },
            recommendedTitle: { type: "string" },
            overallScore: { type: "number" },
            hookScore: { type: "number" },
            valueScore: { type: "number" },
            clarityScore: { type: "number" },
            emotionScore: { type: "number" },
            shareabilityScore: { type: "number" },
            whyThisWorks: { type: "string" },
            improvementTip: { type: "string" },
            angle: { type: "string" },
            matchedEmotionContext: { type: "string" },
            emotionFitScore: { type: "number" },
            emotionFitReason: { type: "string" },
            emotionFallback: { type: "boolean" },
          },
          required: ["startMs", "endMs", "recommendedTitle"],
        },
      },
    },
    required: ["evaluations"],
  };

  for (const model of candidateModels) {
    try {
      const { data, status } = await requestGroqJson<unknown>({
        apiKey,
        endpoint,
        model,
        systemPrompt,
        userPrompt,
        temperature: 0.3,
        schemaName: "clip_recommendation_evaluations",
        schema: clipEvalSchema,
        emptyContentErrorMessage: "Respons evaluasi clip kosong",
      });
      logger.info("clip_eval_response_received", { model, status });

      const evaluations = normalizeClipEvaluations(data);
      if (evaluations.length === 0) {
        throw new Error("AI tidak menghasilkan evaluasi clip yang valid");
      }

      logger.info("clip_eval_request_completed", { model, evaluations: evaluations.length });
      return { model, evaluations };
    } catch (error) {
      if (isModelUnavailableError(error)) {
        const groqError = error as GroqApiRequestError;
        lastError = `Groq clip evaluation gagal (${groqError.status}): ${groqError.responseText}`;
        logger.warn("clip_eval_model_unavailable", { model, status: groqError.status });
        continue;
      }

      if (isAuthOrPermissionError(error)) {
        const groqError = error as GroqApiRequestError;
        const message = `Groq clip evaluation gagal (${groqError.status}): ${groqError.responseText}`;
        logger.error("clip_eval_request_auth_failed", { model, status: groqError.status });
        throw new Error(message);
      }

      const message = error instanceof Error ? error.message : "Groq clip evaluation gagal";
      lastError = message;
      logger.warn("clip_eval_request_model_failed", { model, message });
      continue;
    }
  }

  throw new Error(
    lastError ||
      "Groq clip evaluation gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}

export async function selectHighlightsForWindowWithGroq(
  input: SelectHighlightsForWindowInput,
  apiKey: string,
  options?: HighlightSelectionOptions
) {
  const selection = await selectHighlightsWithGroq(input.segments, apiKey, options);

  const bounded = selection.candidates
    .map((candidate) => {
      const startMs = Math.max(input.startMs, candidate.startMs);
      const endMs = Math.min(input.endMs, candidate.endMs);
      if (endMs <= startMs) {
        return null;
      }
      return {
        ...candidate,
        startMs,
        endMs,
      };
    })
    .filter((candidate): candidate is GroqHighlightCandidate => candidate !== null)
    .sort((a, b) => {
      if (b.scoreTotal !== a.scoreTotal) {
        return b.scoreTotal - a.scoreTotal;
      }
      return a.startMs - b.startMs;
    });

  return {
    model: selection.model,
    windowIndex: input.index,
    candidates: bounded,
  };
}

export async function criticEvaluateHighlightsWithGroq(
  transcriptSegments: TranscriptForSelection[],
  candidates: GroqHighlightCandidate[],
  apiKey: string,
  options?: CriticEvaluateOptions
) {
  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);
  const passThreshold = Math.max(1, Math.min(100, Math.round(options?.passThreshold ?? 75)));
  const emotionContext = options?.emotionContext ?? DEFAULT_EMOTION_CONTEXT;

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  const compactCandidates = candidates.slice(0, 8).map((candidate) => ({
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    topic: candidate.topic || null,
    reason: candidate.reason,
    matchedEmotionContext: candidate.matchedEmotionContext || null,
    emotionFitScore: candidate.emotionFitScore ?? null,
    emotionFitReason: candidate.emotionFitReason || null,
    emotionFallback: candidate.emotionFallback ?? null,
    transcriptWindow: buildCandidateWindowText(
      transcriptSegments,
      candidate.startMs,
      candidate.endMs,
      520
    ),
  }));

  const systemPrompt = [
    "Kamu adalah quality critic untuk short clips.",
    "Evaluasi kandidat secara ketat berdasarkan hook, kejelasan, nilai, dan kesiapan publish.",
    "Output HARUS JSON valid tanpa markdown.",
  ].join(" ");

  const userPrompt = [
    `Tandai kandidat sebagai isPass=true jika overallScore >= ${passThreshold}, selain itu false.`,
    "Format JSON wajib:",
    '{"evaluations":[{"startMs":1234,"endMs":4567,"overallScore":82,"hookScore":80,"valueScore":84,"clarityScore":78,"emotionScore":75,"noveltyScore":77,"shareabilityScore":83,"isPass":false,"failureReasons":["hook"],"fixGuidance":"...","topic":"...","matchedEmotionContext":"joy","emotionFitScore":80,"emotionFitReason":"...","emotionFallback":false}]}',
    "failureReasons contoh: hook,clarity,value,emotion,novelty,timing,cta.",
    ...buildEmotionPromptBlock(emotionContext),
    "Candidates:",
    JSON.stringify(compactCandidates),
  ].join("\n");

  const criticSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      evaluations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            startMs: { type: "number" },
            endMs: { type: "number" },
            overallScore: { type: "number" },
            hookScore: { type: "number" },
            valueScore: { type: "number" },
            clarityScore: { type: "number" },
            emotionScore: { type: "number" },
            noveltyScore: { type: "number" },
            shareabilityScore: { type: "number" },
            isPass: { type: "boolean" },
            failureReasons: { type: "array", items: { type: "string" } },
            fixGuidance: { type: "string" },
            topic: { type: "string" },
            matchedEmotionContext: { type: "string" },
            emotionFitScore: { type: "number" },
            emotionFitReason: { type: "string" },
            emotionFallback: { type: "boolean" },
          },
          required: [
            "startMs",
            "endMs",
            "overallScore",
            "hookScore",
            "valueScore",
            "clarityScore",
            "emotionScore",
            "noveltyScore",
            "shareabilityScore",
            "isPass",
            "failureReasons",
            "fixGuidance",
          ],
        },
      },
    },
    required: ["evaluations"],
  };

  let lastError: string | null = null;

  for (const model of candidateModels) {
    try {
      const { data, status } = await requestGroqJson<unknown>({
        apiKey,
        endpoint,
        model,
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        schemaName: "highlight_critic_evaluations",
        schema: criticSchema,
        emptyContentErrorMessage: "Respons critic evaluation kosong",
      });
      logger.info("highlight_critic_response_received", { model, status });

      const evaluations = normalizeCriticEvaluations(data, passThreshold);
      if (evaluations.length === 0) {
        throw new Error("AI tidak menghasilkan critic evaluation yang valid");
      }

      return { model, evaluations };
    } catch (error) {
      if (isModelUnavailableError(error)) {
        const groqError = error as GroqApiRequestError;
        lastError = `Groq critic evaluation gagal (${groqError.status}): ${groqError.responseText}`;
        logger.warn("highlight_critic_model_unavailable", { model, status: groqError.status });
        continue;
      }

      if (isAuthOrPermissionError(error)) {
        const groqError = error as GroqApiRequestError;
        const message = `Groq critic evaluation gagal (${groqError.status}): ${groqError.responseText}`;
        logger.error("highlight_critic_request_auth_failed", { model, status: groqError.status });
        throw new Error(message);
      }

      const message = error instanceof Error ? error.message : "Groq critic evaluation gagal";
      lastError = message;
      logger.warn("highlight_critic_model_failed", { model, message });
      continue;
    }
  }

  throw new Error(
    lastError ||
      "Groq critic evaluation gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}

export async function regenerateHighlightsFromFailuresWithGroq(
  transcriptSegments: TranscriptForSelection[],
  failedEvaluations: HighlightCriticEvaluation[],
  apiKey: string,
  options?: { emotionContext?: EmotionContext },
) {
  const emotionContext = options?.emotionContext ?? DEFAULT_EMOTION_CONTEXT;
  const failures = failedEvaluations.filter((row) => !row.isPass);
  if (failures.length === 0) {
    return {
      model: "none",
      candidates: [] as GroqHighlightCandidate[],
    };
  }

  const requestedModel = process.env.GROQ_HIGHLIGHT_MODEL?.trim() || "openai/gpt-oss-120b";
  const endpoint =
    process.env.GROQ_CHAT_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions";
  const modelsEndpoint = buildGroqModelsEndpoint(endpoint);

  const availableModels = await listGroqModels(apiKey, modelsEndpoint);
  const candidateModels = resolveHighlightModelCandidates(requestedModel, availableModels);

  const compactFailures = failures.slice(0, 6).map((failure) => ({
    startMs: failure.startMs,
    endMs: failure.endMs,
    failureReasons: failure.failureReasons,
    fixGuidance: failure.fixGuidance,
    topic: failure.topic || null,
    matchedEmotionContext: failure.matchedEmotionContext || null,
    emotionFitScore: failure.emotionFitScore ?? null,
    emotionFitReason: failure.emotionFitReason || null,
    emotionFallback: failure.emotionFallback ?? null,
    context: buildCandidateWindowText(transcriptSegments, failure.startMs, failure.endMs, 520),
  }));

  const systemPrompt = [
    "Kamu adalah AI editor short-form yang memperbaiki kandidat clip gagal review.",
    "Tugasmu menghasilkan kandidat baru non-overlap berat dan lebih kuat dari kandidat gagal.",
    "Output HARUS JSON valid tanpa markdown.",
  ].join(" ");

  const userPrompt = [
    "Buat kandidat baru pengganti dari daftar kegagalan berikut.",
    "Format JSON wajib:",
    '{"candidates":[{"startMs":1234,"endMs":5678,"scoreTotal":0.88,"scoreText":0.86,"reason":"...","topic":"...","matchedEmotionContext":"joy","emotionFitScore":82,"emotionFitReason":"...","emotionFallback":false}]}',
    "Aturan:",
    "- Usahakan durasi 20-45 detik",
    "- Hindari overlap berat dengan rentang gagal",
    "- Gunakan timestamp yang masuk akal berdasarkan konteks",
    ...buildEmotionPromptBlock(emotionContext),
    "Failures:",
    JSON.stringify(compactFailures),
  ].join("\n");

  const regenSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            startMs: { type: "number" },
            endMs: { type: "number" },
            scoreTotal: { type: "number" },
            scoreText: { type: "number" },
            reason: { type: "string" },
            topic: { type: "string" },
            matchedEmotionContext: { type: "string" },
            emotionFitScore: { type: "number" },
            emotionFitReason: { type: "string" },
            emotionFallback: { type: "boolean" },
          },
          required: ["startMs", "endMs", "scoreTotal", "scoreText", "reason"],
        },
      },
    },
    required: ["candidates"],
  };

  let lastError: string | null = null;

  for (const model of candidateModels) {
    try {
      const { data, status } = await requestGroqJson<unknown>({
        apiKey,
        endpoint,
        model,
        systemPrompt,
        userPrompt,
        temperature: 0.25,
        schemaName: "highlight_regeneration_candidates",
        schema: regenSchema,
        emptyContentErrorMessage: "Respons regenerate highlight kosong",
      });
      logger.info("highlight_regenerate_response_received", { model, status });

      const candidates = normalizeCandidates(data);
      if (candidates.length === 0) {
        throw new Error("AI tidak menghasilkan kandidat regenerate yang valid");
      }

      return { model, candidates };
    } catch (error) {
      if (isModelUnavailableError(error)) {
        const groqError = error as GroqApiRequestError;
        lastError = `Groq regenerate highlight gagal (${groqError.status}): ${groqError.responseText}`;
        logger.warn("highlight_regenerate_model_unavailable", { model, status: groqError.status });
        continue;
      }

      if (isAuthOrPermissionError(error)) {
        const groqError = error as GroqApiRequestError;
        const message = `Groq regenerate highlight gagal (${groqError.status}): ${groqError.responseText}`;
        logger.error("highlight_regenerate_request_auth_failed", { model, status: groqError.status });
        throw new Error(message);
      }

      const message = error instanceof Error ? error.message : "Groq regenerate highlight gagal";
      lastError = message;
      logger.warn("highlight_regenerate_model_failed", { model, message });
      continue;
    }
  }

  throw new Error(
    lastError ||
      "Groq regenerate highlight gagal: tidak menemukan model yang tersedia. Cek akses model pada API key Groq."
  );
}
